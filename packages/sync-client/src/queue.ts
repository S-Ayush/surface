/**
 * The pending-mutation queue (SPEC-002 §3.3, §3.5; sync-protocol.md §4.4, §5.1).
 *
 * `queued` (persisted) → `sent` → committed (`lastSyncId = N`) → confirmed once
 * the replica reaches N or an `ack` for the seq arrives → removed. A rejected
 * mutation is removed at once and reported.
 *
 * - **Exactly once:** a mutation is persisted before it is first sent, with
 *   its `(clientId, seq)`. Resends (after a failure, a crash or a reload)
 *   reuse the pair and the server dedupes them. One batch is in flight at a
 *   time, in seq order, so seq N+1 never goes before N.
 * - **Offline:** the queue sends only while the live connection is up. On
 *   reconnect it flushes; confirmation still waits for the replica to reach
 *   each commit, so it does not matter whether catch-up has finished.
 * - **Failures:** a network error, a 5xx or an unreadable answer retries the
 *   same batch with backoff. A `429` or `503` with `Retry-After` (a rate
 *   limit, or a server still starting, SPEC-003 §9) resends after that many
 *   seconds instead, within the backoff's bounds (SPEC-002 Q12). `CLIENT_OUTDATED`
 *   stops the queue until reload. A `401` (no session, or another user's,
 *   SPEC-002 E14) parks it with every mutation kept: the store redials, and
 *   the queue resends after a backoff once the socket opens again. A `4001`
 *   there leaves the socket down for good, so the queue stays offline until
 *   its user signs in again (a new store adopts it).
 *   `SEQ_GAP` means the server has lost seqs this client already removed
 *   (e.g. a database restore): the unsent mutations are renumbered from
 *   `lastSeq + 1` and sent again.
 */
import type { AnyOperation, InputOf, OperationRegistry } from '@surface/operations';
import type { MutateRequest, MutationIssue, MutationResult } from '@surface/sync-protocol';
import {
  CSRF_HEADER,
  CSRF_INVALID,
  decodeMutateErrorBody,
  decodeMutateResponse,
  MAX_MUTATION_BATCH_BYTES,
  MAX_MUTATIONS_PER_BATCH,
  MUTATE_PATH,
  MutateErrorCode,
  mutationSchema,
  SESSION_PATH,
} from '@surface/sync-protocol';
import type { IObservableArray } from 'mobx';
import { observable, runInAction } from 'mobx';
import type { FetchLike } from './bootstrap.js';
import type { OverlayMutation } from './overlay.js';
import type { QueueOwnership } from './owner.js';
import type { Persistence } from './persistence.js';
import type { Timers } from './socket.js';
import { BACKOFF_MAX_MS, BACKOFF_MIN_MS, backoffDelay } from './socket.js';
import type { PendingRecord, QueueWrite } from './storage/types.js';
import { QueueFencedError } from './storage/types.js';

/** Room for the request envelope: batches and single mutations stay under this (sync-protocol.md §9). */
const MAX_SEND_BYTES = Math.floor(MAX_MUTATION_BATCH_BYTES * 0.9);
const encoder = new TextEncoder();
/** A request with no answer by then is abandoned and sent again (deduped by seq). */
export const REQUEST_TIMEOUT_MS = 30_000;
/** The size of a value on the wire: UTF-8 bytes of its JSON, not UTF-16 code units. */
const wireBytes = (value: unknown) => encoder.encode(JSON.stringify(value)).length;
const megabytes = (bytes: number) => (bytes / 1_000_000).toFixed(1);

/**
 * Why a mutation was rejected. `issues` name the fields at fault when the server
 * sent them (sync-protocol v0.6, SPEC-003 §9), so a form can show each on its field.
 */
export interface RejectionError {
  readonly code: string;
  readonly message: string;
  readonly issues?: readonly MutationIssue[];
}

/** How a dispatched mutation ended. */
export type MutationOutcome =
  | { readonly status: 'confirmed' }
  | { readonly status: 'rejected'; readonly error: RejectionError };

/** Per-dispatch choices (`dispatch(op, input, options)`). */
export interface DispatchOptions {
  /**
   * Whether the app's `onRejected` handler (the shell's toast) should hear of a rejection. Asked
   * at the moment of the rejection: a form that shows the refusal on its own field answers
   * `false` while it is still waiting for it, and `true` once it stopped (closed, or queued
   * offline), so the user hears of it exactly once. Default, and when it throws: `true`. Not
   * kept across a reload: a mutation sent again from storage is reported.
   */
  readonly reportRejection?: () => boolean;
  /**
   * Called once the mutation has its `(clientId, seq)`, before its `optimistic` effect shows. A
   * content mutation may wait for its parent first (SPEC-011 §5.3 step 6), so this can come after
   * `dispatch` returns. For tests and tools that track mutations by key.
   */
  readonly onQueued?: (key: { readonly clientId: string; readonly seq: number }) => void;
}

/** A mutation the server rejected (SPEC-002 §3.5): for the toast, the inspector and forms. */
export interface Rejection extends RejectionError {
  readonly op: string;
  readonly seq: number;
  readonly input: unknown;
}

/** A pending mutation, for the inspector and the offline badge (SPEC-002 §5.4, §7). */
export interface PendingView {
  readonly seq: number;
  readonly op: string;
  readonly at: string;
  readonly state: 'queued' | 'sent' | 'committed';
  /**
   * What was dispatched, as dispatched: lets a page tell whose change is still unconfirmed (the
   * issue page's description waits for one, PLAN-012 S4b). Never send or store it from here.
   * Optional so views built elsewhere (the inspector's tests) needn't carry it.
   */
  readonly input?: unknown;
}

/** The input did not match the operation's schema; nothing was queued. */
export class InvalidInputError extends Error {
  override readonly name = 'InvalidInputError';
  constructor(
    readonly operation: string,
    readonly issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
  ) {
    const first = issues[0];
    const where = first && first.path.length > 0 ? `${first.path.map(String).join('.')}: ` : '';
    super(`Invalid input for ${operation}: ${where}${first?.message ?? 'not valid'}`);
  }
}

export interface QueueOptions {
  readonly fetch: FetchLike;
  readonly baseUrl: string;
  /** The user this queue belongs to; the server refuses another session (SPEC-002 E14). */
  readonly userId: string;
  readonly schemaHash: string;
  readonly registry: OperationRegistry;
  readonly timers: Timers;
  readonly random: () => number;
  readonly clock: () => number;
  /** The `lastSyncId` the replica has reached, if it is ready. */
  readonly replicaAt: () => number | undefined;
  /**
   * One mutation added on top of the overlay. An error returned means its `optimistic()` refused
   * it from the store (`OptimisticRefusal`): the dispatch throws it and queues nothing.
   */
  readonly onPush: (mutation: OverlayMutation) => Error | undefined | void;
  readonly onRebuild: () => void;
  /** `report`: whether the app's handler should hear of it (`DispatchOptions.reportRejection`). */
  readonly onRejected: (rejection: Rejection, report: boolean) => void;
  readonly onOutdated: () => void;
  /**
   * `401`: no session, or another user's (SPEC-002 E14). The queue has parked;
   * the store redials, so the socket finds out which (`4001`, or open again).
   */
  readonly onUnauthenticated: () => void;
  /** Another tab owns this queue now; this tab must stop. */
  readonly onFenced: () => void;
  /** The CSRF token to send, read at each request (SPEC-001 §6.1). */
  readonly csrfToken: () => string | undefined;
  /**
   * The latest of the mutations the replica now includes that this queue sent,
   * with the epoch ms of its last send, for the inspector's lag (SPEC-002 §5.4).
   */
  readonly onConfirmed?: (latest: {
    readonly op: string;
    readonly seq: number;
    readonly sentAt: number;
  }) => void;
}

interface Entry {
  record: PendingRecord;
  readonly op: AnyOperation | undefined;
  /** `undefined` when the input no longer parses (an older client's mutation). */
  readonly parsed: { readonly value: unknown } | undefined;
  persisted: boolean;
  sent: boolean;
  /** Epoch ms of the last send, kept when `sent` is reset: a lost response may still commit. */
  sentAt: number | undefined;
  readonly settle: (outcome: MutationOutcome) => void;
  readonly reportRejection?: () => boolean;
}

/** Whether the app hears of this entry's rejection; a caller's bug never silences it. */
function reportable(entry: Entry): boolean {
  if (entry.reportRejection === undefined) return true;
  try {
    return entry.reportRejection();
  } catch {
    return true;
  }
}

/** A refusal of the CSRF token, not of the batch (SPEC-001 §6.1). */
function csrfRefusal(json: unknown): boolean {
  try {
    return decodeMutateErrorBody(json).error.code === CSRF_INVALID;
  } catch {
    return false;
  }
}

export class MutationQueue {
  readonly #options: QueueOptions;
  readonly #ownership: QueueOwnership;
  readonly #persistence: Persistence;
  readonly #entries = new Map<number, Entry>();
  readonly #view: IObservableArray<PendingView> = observable.array([], { deep: false });
  #nextSeq: number;
  #writes: Promise<unknown> = Promise.resolve();
  #online = false;
  /** Refused with `401`: send nothing until the connection opens again (SPEC-002 E14). */
  #parked = false;
  #stopped = false;
  #inFlight: AbortController | undefined;
  #retry: unknown;
  /** Failed sends since the last answer: picks the next backoff (`backoffDelay`). */
  #attempt = 0;
  /** At most this many mutations per batch; lowered when the server refuses a batch (413, 400). */
  #batchLimit = MAX_MUTATIONS_PER_BATCH;

  constructor(ownership: QueueOwnership, persistence: Persistence, options: QueueOptions) {
    this.#options = options;
    this.#ownership = ownership;
    this.#persistence = persistence;
    this.#nextSeq = ownership.nextSeq;
    for (const record of ownership.pending) {
      this.#entries.set(
        record.seq,
        this.#entry(record, () => undefined, true),
      );
    }
    this.#publish();
  }

  get clientId(): string {
    return this.#ownership.clientId;
  }

  /** Closed, outdated or taken over: no more dispatches. */
  get stopped(): boolean {
    return this.#stopped;
  }

  /** Pending mutations in seq order. Observable. */
  get pending(): readonly PendingView[] {
    return this.#view;
  }

  /** What the overlay runs, in seq order. */
  get mutations(): OverlayMutation[] {
    return [...this.#entries.values()].flatMap((entry) => this.#overlayOf(entry) ?? []);
  }

  /**
   * SPEC-002 §3.3. Throws `InvalidInputError` before queueing anything. Throws the
   * `OptimisticRefusal` the operation's prediction raised (SPEC-010 §5, E8) the same way: the
   * prediction runs before the entry exists, so a refused change is never pending, persisted or
   * sent, and does not use up its seq.
   */
  dispatch<Op extends AnyOperation>(
    op: Op,
    input: InputOf<Op>,
    options: DispatchOptions = {},
  ): Promise<MutationOutcome> {
    if (op.kind !== 'mutation') {
      throw new Error(`${op.name} is a query; dispatch only takes mutations`);
    }
    const parsed = op.input.safeParse(input);
    if (!parsed.success) throw new InvalidInputError(op.name, parsed.error.issues);
    const seq = this.#nextSeq;
    const at = new Date(this.#options.clock()).toISOString();
    // The wire takes JSON only; refuse anything else now rather than at send time.
    const wire = mutationSchema.safeParse({ seq, op: op.name, input, at });
    if (!wire.success) throw new InvalidInputError(op.name, wire.error.issues);
    // A copy: what is persisted and sent is the input as validated, whatever the caller
    // does with its object afterwards.
    const record: PendingRecord = {
      clientId: this.clientId,
      seq,
      op: op.name,
      input: structuredClone(input),
      at,
    };
    // The server's body limit refuses anything larger, however it is batched (review M2).
    const bytes = wireBytes(wire.data);
    if (bytes > MAX_SEND_BYTES) {
      throw new InvalidInputError(op.name, [
        {
          path: [],
          message: `too large to save (${megabytes(bytes)} MB; the limit is ${megabytes(MAX_SEND_BYTES)} MB). Split it into smaller changes`,
        },
      ]);
    }

    let settle: (outcome: MutationOutcome) => void = () => undefined;
    const outcome = new Promise<MutationOutcome>((resolve) => {
      settle = resolve;
    });
    const entry: Entry = {
      record,
      op,
      parsed: { value: parsed.data },
      persisted: false,
      sent: false,
      sentAt: undefined,
      settle,
      ...(options.reportRejection ? { reportRejection: options.reportRejection } : {}),
    };
    // The prediction first: when the store already shows the server would refuse it (SPEC-010
    // §5), nothing has been queued yet, so refusing leaves no trace.
    const mutation = this.#overlayOf(entry);
    const refusal = mutation && this.#options.onPush(mutation);
    if (refusal instanceof Error) throw refusal;
    this.#nextSeq += 1;
    this.#entries.set(seq, entry);
    options.onQueued?.({ clientId: this.clientId, seq });
    this.#publish();
    this.#write({ nextSeq: this.#nextSeq, put: [record] }).then(
      () => {
        entry.persisted = true;
        this.#flush();
      },
      () => undefined,
    );
    return outcome;
  }

  /**
   * The live connection is up (send now) or down (hold). Going down abandons
   * the request in flight: after a sleep or a network change it may hang for
   * minutes, and its resend is deduped. Coming back sends at once, without
   * waiting out a retry delay (SPEC-002 §3.6, review M3), except after a `401`:
   * then it resends after the next backoff (SPEC-002 E14).
   */
  setOnline(online: boolean): void {
    this.#online = online;
    if (!online) {
      this.#inFlight?.abort('offline');
      return;
    }
    if (this.#parked) {
      // The session answered the socket, but the last send was refused: resend after a
      // growing backoff, so a server (or proxy) that disagrees with itself can't make a
      // tight loop of 401s and redials.
      this.#parked = false;
      this.#retryLater();
      return;
    }
    this.#options.timers.clearTimeout(this.#retry);
    this.#retry = undefined;
    this.#attempt = 0;
    this.#flush();
  }

  /**
   * After a delta: confirm what the replica now includes. Returns whether the
   * list changed, so the caller rebuilds the overlay in the same batch.
   */
  confirm(lastSyncId: number, acks: readonly { clientId: string; seq: number }[]): boolean {
    const acked = new Set(acks.filter((a) => a.clientId === this.clientId).map((a) => a.seq));
    const done = [...this.#entries.values()].filter(
      (entry) =>
        acked.has(entry.record.seq) ||
        (entry.record.lastSyncId !== undefined && entry.record.lastSyncId <= lastSyncId),
    );
    if (done.length === 0) return false;
    this.#remove(done);
    for (const entry of done) entry.settle({ status: 'confirmed' });
    // Not one queued offline and confirmed by a resend from another tab or an
    // earlier page: its wait is not the server's (review of PLAN-002 S10).
    let latest: { op: string; seq: number; sentAt: number } | undefined;
    for (const { record, sentAt } of done) {
      if (sentAt !== undefined && (latest === undefined || record.seq > latest.seq)) {
        latest = { op: record.op, seq: record.seq, sentAt };
      }
    }
    if (latest !== undefined) this.#options.onConfirmed?.(latest);
    return true;
  }

  /**
   * Stop sending (close, outdated, fenced). Persisted mutations stay for the
   * next start. `release: false` keeps the claim (the tab moved to another
   * queue under the same lease).
   */
  async stop({ release = true }: { readonly release?: boolean } = {}): Promise<void> {
    this.#stopped = true;
    this.#inFlight?.abort('stop');
    this.#options.timers.clearTimeout(this.#retry);
    await this.#writes;
    if (release) await this.#ownership.release();
  }

  #entry(record: PendingRecord, settle: Entry['settle'], persisted: boolean): Entry {
    const op = this.#options.registry.get(record.op);
    const parsed = op?.input.safeParse(record.input);
    return {
      record,
      op,
      parsed: parsed?.success ? { value: parsed.data } : undefined,
      persisted,
      sent: false,
      sentAt: undefined,
      settle,
    };
  }

  #overlayOf(entry: Entry): OverlayMutation | undefined {
    if (entry.op === undefined || entry.parsed === undefined) return undefined;
    return {
      key: `${entry.record.clientId}:${entry.record.seq}`,
      op: entry.op,
      input: entry.parsed.value,
      now: new Date(entry.record.at),
    };
  }

  #publish(): void {
    const view = [...this.#entries.values()].map(({ record, sent }): PendingView => ({
      seq: record.seq,
      op: record.op,
      at: record.at,
      state: record.lastSyncId !== undefined ? 'committed' : sent ? 'sent' : 'queued',
      input: record.input,
    }));
    runInAction(() => this.#view.replace(view));
  }

  #remove(entries: readonly Entry[]): void {
    for (const entry of entries) this.#entries.delete(entry.record.seq);
    this.#publish();
    void this.#write({ remove: entries.map((entry) => entry.record.seq) });
  }

  /** Persist in call order. A fenced queue stops; a lost storage carries on in memory. */
  #write(write: Omit<QueueWrite, 'clientId' | 'owner'>): Promise<void> {
    const { clientId, owner } = this.#ownership;
    const run = this.#writes.then(() =>
      this.#persistence.writeQueue((storage) => storage.writeQueue({ ...write, clientId, owner })),
    );
    this.#writes = run.catch(() => undefined);
    return run.then(
      () => undefined,
      (error: unknown) => {
        if (!(error instanceof QueueFencedError)) throw error;
        if (this.#stopped) return;
        void this.stop();
        this.#options.onFenced();
      },
    );
  }

  /** Send the next batch, if there is one and nothing is in flight. */
  #flush(): void {
    if (
      this.#stopped ||
      this.#parked ||
      !this.#online ||
      this.#inFlight ||
      this.#retry !== undefined
    ) {
      return;
    }
    const batch = this.#nextBatch();
    if (batch.length === 0) return;
    const controller = new AbortController();
    this.#inFlight = controller;
    const timeout = this.#options.timers.setTimeout(
      () => controller.abort('timeout'),
      REQUEST_TIMEOUT_MS,
    );
    const sentAt = this.#options.clock();
    for (const entry of batch) {
      entry.sent = true;
      entry.sentAt = sentAt;
    }
    this.#publish();
    this.#send(batch, controller.signal).then(
      (next) => {
        this.#options.timers.clearTimeout(timeout);
        this.#inFlight = undefined;
        if (next === 'retry') this.#retryLater();
        else if (typeof next === 'object') this.#retryLater(next.retryIn);
        else this.#flush();
      },
      () => {
        this.#options.timers.clearTimeout(timeout);
        this.#inFlight = undefined;
        // Stopped, or a bug: never leave the queue stuck behind it (review m2).
        this.#retryLater();
      },
    );
  }

  /**
   * Persisted mutations without a result, from the lowest seq, within the
   * batch limits. The seqs must be consecutive (sync-protocol.md §5.1), so the
   * batch ends where one is missing (confirmed already) or has a result
   * (committed): the rest go in the next batch (found by PLAN-002 S9).
   */
  #nextBatch(): Entry[] {
    const batch: Entry[] = [];
    let bytes = 0;
    for (const entry of this.#entries.values()) {
      const last = batch.at(-1);
      if (entry.record.lastSyncId !== undefined) {
        if (last === undefined) continue;
        break;
      }
      if (last !== undefined && entry.record.seq !== last.record.seq + 1) break;
      if (!entry.persisted || batch.length === this.#batchLimit) break;
      const size = wireBytes(entry.record);
      if (batch.length > 0 && bytes + size > MAX_SEND_BYTES) break;
      bytes += size;
      batch.push(entry);
    }
    return batch;
  }

  #url(path: string): string {
    return `${this.#options.baseUrl.replace(/\/$/, '')}${path}`;
  }

  async #post(body: string, signal: AbortSignal): Promise<{ response: Response; json: unknown }> {
    const token = this.#options.csrfToken();
    const response = await this.#options.fetch(this.#url(MUTATE_PATH), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token === undefined ? {} : { [CSRF_HEADER]: token }),
      },
      body,
      credentials: 'same-origin',
      signal,
    });
    // Not JSON (a proxy's page): `undefined`, so the status and headers still count.
    const json: unknown = await response.json().catch(() => undefined);
    return { response, json };
  }

  /**
   * `GET /auth/session` sets the CSRF cookie again. False when there is no
   * session (`401`): a resend would only be refused too.
   */
  async #renewCsrf(signal: AbortSignal): Promise<boolean> {
    const response = await this.#options.fetch(this.#url(SESSION_PATH), {
      credentials: 'same-origin',
      signal,
    });
    await response.body?.cancel();
    return response.ok;
  }

  /** What next: the next batch, a backoff, a resend when the server said (ms), or nothing. */
  async #send(
    batch: readonly Entry[],
    signal: AbortSignal,
  ): Promise<'next' | 'retry' | 'stop' | { retryIn: number }> {
    const mutations: MutateRequest['mutations'] = [];
    for (const { record } of batch) {
      // Checked at dispatch; a stored record that no longer passes can only be rejected.
      const wire = mutationSchema.safeParse({
        seq: record.seq,
        op: record.op,
        input: record.input,
        at: record.at,
      });
      if (!wire.success) {
        this.#apply([
          {
            seq: record.seq,
            status: 'error',
            error: {
              code: 'INVALID_INPUT',
              message: 'This change could not be read back. Make it again.',
            },
          },
        ]);
        return 'next';
      }
      mutations.push(wire.data);
    }
    const body: MutateRequest = {
      clientId: this.clientId,
      userId: this.#options.userId,
      schemaHash: this.#options.schemaHash,
      mutations,
    };
    let response: Response;
    let json: unknown;
    try {
      ({ response, json } = await this.#post(JSON.stringify(body), signal));
      // A stale CSRF token (a new session, or a cookie the browser lost): the
      // session endpoint sets it again, and the batch goes once more at once
      // (SPEC-001 §6.1). Refused again, it backs off like any failure.
      if (response.status === 403 && csrfRefusal(json)) {
        const renewed = await this.#renewCsrf(signal);
        if (this.#stopped) return 'stop';
        if (renewed) ({ response, json } = await this.#post(JSON.stringify(body), signal));
      }
    } catch {
      // A timeout or going offline retries; only `stop` ends the send.
      if (this.#stopped) throw new Error('stopped');
      return 'retry';
    }
    if (this.#stopped) return 'stop';

    if (response.ok) {
      let results: readonly MutationResult[];
      try {
        results = decodeMutateResponse(json).results;
      } catch {
        return 'retry';
      }
      this.#attempt = 0;
      this.#batchLimit = MAX_MUTATIONS_PER_BATCH;
      this.#apply(results);
      return 'next';
    }
    if (response.status === 413) {
      return this.#refused(batch, {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'This change is too large to save. Split it into smaller changes.',
      });
    }
    if (response.status === 401) {
      // Never resent under this cookie: it may be another user's, and the mutations are
      // this queue's user's. They stay queued until that user's session answers again.
      this.#parked = true;
      this.#options.onUnauthenticated();
      return 'stop';
    }
    const retryAfterMs = retryAfter(response);
    if (retryAfterMs !== undefined) {
      // The server answered and said when to come back: not a failure to back off from.
      this.#attempt = 0;
      return { retryIn: retryAfterMs };
    }
    let code: string | undefined;
    let message: string | undefined;
    let lastSeq: number | undefined;
    try {
      ({ code, message, lastSeq } = decodeMutateErrorBody(json).error);
    } catch {
      // An unreadable error body (a proxy page, say): treat like any failure.
    }
    if (code === MutateErrorCode.ClientOutdated) {
      this.#stopped = true;
      this.#options.onOutdated();
      return 'stop';
    }
    if (code === MutateErrorCode.SeqGap && lastSeq !== undefined) {
      // Nothing to renumber means the server's answer makes no sense: back off.
      return (await this.#renumber(lastSeq + 1)) ? 'next' : 'retry';
    }
    // The server read the request and refused it: the same batch would fail forever.
    if ((response.status === 400 || response.status === 422) && code && message) {
      return this.#refused(batch, { code, message });
    }
    return 'retry';
  }

  /**
   * The server refused a whole batch (too large, or invalid). Send smaller
   * batches until the mutation at fault is alone, then reject it; the rest go
   * through (a later `SEQ_GAP` renumbers past it).
   */
  #refused(batch: readonly Entry[], error: { code: string; message: string }): 'next' {
    const [first] = batch;
    if (batch.length > 1 || first === undefined) {
      this.#batchLimit = Math.max(1, Math.ceil(batch.length / 2));
      for (const entry of batch) entry.sent = false;
      this.#publish();
      return 'next';
    }
    this.#apply([{ seq: first.record.seq, status: 'error', error }]);
    return 'next';
  }

  /** Apply the results of a batch (one per mutation, in seq order). */
  #apply(results: readonly MutationResult[]): void {
    const rejected: { entry: Entry; error: RejectionError }[] = [];
    const committed: PendingRecord[] = [];
    for (const result of results) {
      const entry = this.#entries.get(result.seq);
      // Already confirmed by an `ack` that beat the response.
      if (entry === undefined) continue;
      if (result.status === 'ok') {
        entry.record = { ...entry.record, lastSyncId: result.lastSyncId };
        committed.push(entry.record);
      } else rejected.push({ entry, error: result.error });
    }
    if (committed.length > 0) void this.#write({ put: committed });
    if (rejected.length > 0) this.#remove(rejected.map(({ entry }) => entry));
    // The replica may already include a commit: a resend after a reload, answered
    // from the server's record, gets no ack and maybe no further delta.
    const at = this.#options.replicaAt();
    const confirmed = at !== undefined && this.confirm(at, []);
    if (rejected.length > 0 || confirmed) this.#options.onRebuild();
    else this.#publish();
    // Reported once rolled back, so a toast handler sees what the user sees (review m2).
    for (const { entry, error } of rejected) {
      const { op, seq, input } = entry.record;
      this.#options.onRejected({ op, seq, input, ...error }, reportable(entry));
      entry.settle({ status: 'rejected', error });
    }
  }

  /**
   * `SEQ_GAP`: the server has nothing after `from - 1` (e.g. a database
   * restore). Every mutation after that is renumbered from `from` and sent
   * again, including ones it had committed but this client has not yet seen
   * confirmed: the restore lost those too, and keeping their seqs would
   * collide with the renumbered ones (review m4). Returns whether anything moved.
   */
  async #renumber(from: number): Promise<boolean> {
    const lost = [...this.#entries.values()].filter((e) => e.record.seq >= from);
    const changes = lost.some(
      (entry, index) => entry.record.seq !== from + index || entry.record.lastSyncId !== undefined,
    );
    if (!changes) return false;
    const oldSeqs = lost.map((entry) => entry.record.seq);
    const moved = lost.map((entry, index) => {
      const { lastSyncId: _lost, ...record } = entry.record;
      return { entry, record: { ...record, seq: from + index } };
    });
    for (const { entry } of moved) this.#entries.delete(entry.record.seq);
    for (const { entry, record } of moved) {
      entry.record = record;
      entry.sent = false;
      this.#entries.set(record.seq, entry);
    }
    const sorted = [...this.#entries.entries()].sort(([a], [b]) => a - b);
    this.#entries.clear();
    for (const [seq, entry] of sorted) this.#entries.set(seq, entry);
    this.#nextSeq = from + moved.length;
    this.#publish();
    // One transaction: removes run before puts, so old and new seqs may overlap.
    await this.#write({
      nextSeq: this.#nextSeq,
      remove: oldSeqs,
      put: moved.map(({ record }) => record),
    });
    this.#options.onRebuild();
    return true;
  }

  /** Resend after `asked` ms (a `Retry-After`), or after the next backoff. */
  #retryLater(asked?: number): void {
    if (this.#stopped) return;
    let delay: number;
    if (asked === undefined) {
      delay = backoffDelay(this.#attempt, this.#options.random());
      this.#attempt += 1;
    } else {
      // Within the backoff's bounds, so `Retry-After: 0` can't make a tight loop.
      // Spread a little, so tabs told the same thing don't all resend at once.
      const bounded = Math.max(BACKOFF_MIN_MS, Math.min(asked, BACKOFF_MAX_MS));
      delay = bounded + this.#options.random() * RETRY_AFTER_JITTER_MS;
    }
    this.#retry = this.#options.timers.setTimeout(() => {
      this.#retry = undefined;
      this.#flush();
    }, delay);
  }
}

/** The most a `Retry-After` resend is spread by, so tabs told the same thing don't all resend at once. */
const RETRY_AFTER_JITTER_MS = 250;

/**
 * `Retry-After` of a `429` or `503`, in ms: a whole number of seconds, the
 * only form the server sends (SPEC-003 §9). Anything else (missing, a date,
 * negative) is undefined, and the queue backs off as for any failure.
 */
function retryAfter(response: Response): number | undefined {
  if (response.status !== 429 && response.status !== 503) return undefined;
  const value = response.headers.get('retry-after')?.trim();
  if (value === undefined || !/^\d{1,9}$/.test(value)) return undefined;
  return Number(value) * 1000;
}
