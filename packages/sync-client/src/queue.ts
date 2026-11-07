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
 *   same batch with backoff. `CLIENT_OUTDATED` stops the queue until reload.
 *   `SEQ_GAP` means the server has lost seqs this client already removed
 *   (e.g. a database restore): the unsent mutations are renumbered from
 *   `lastSeq + 1` and sent again.
 */
import type { AnyOperation, InputOf, OperationRegistry } from '@surface/operations';
import type { MutateRequest, MutationResult } from '@surface/sync-protocol';
import {
  MAX_MUTATIONS_PER_BATCH,
  MAX_MUTATION_BATCH_BYTES,
  MUTATE_PATH,
  MutateErrorCode,
  decodeMutateErrorBody,
  decodeMutateResponse,
  mutationSchema,
} from '@surface/sync-protocol';
import type { IObservableArray } from 'mobx';
import { observable, runInAction } from 'mobx';
import type { FetchLike } from './bootstrap.js';
import type { OverlayMutation } from './overlay.js';
import type { QueueOwnership } from './owner.js';
import type { Persistence } from './persistence.js';
import type { Timers } from './socket.js';
import { backoffDelay } from './socket.js';
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

/** How a dispatched mutation ended. */
export type MutationOutcome =
  | { readonly status: 'confirmed' }
  | {
      readonly status: 'rejected';
      readonly error: { readonly code: string; readonly message: string };
    };

/** A mutation the server rejected (SPEC-002 §3.5): for the toast and the inspector. */
export interface Rejection {
  readonly op: string;
  readonly seq: number;
  readonly input: unknown;
  readonly code: string;
  readonly message: string;
}

/** A pending mutation, for the inspector and the offline badge (SPEC-002 §5.4, §7). */
export interface PendingView {
  readonly seq: number;
  readonly op: string;
  readonly at: string;
  readonly state: 'queued' | 'sent' | 'committed';
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
  readonly schemaHash: string;
  readonly registry: OperationRegistry;
  readonly timers: Timers;
  readonly random: () => number;
  readonly clock: () => number;
  /** The `lastSyncId` the replica has reached, if it is ready. */
  readonly replicaAt: () => number | undefined;
  /** The overlay changed: one mutation added on top, or the list changed. */
  readonly onPush: (mutation: OverlayMutation) => void;
  readonly onRebuild: () => void;
  readonly onRejected: (rejection: Rejection) => void;
  readonly onOutdated: () => void;
  /** Another tab owns this queue now; this tab must stop. */
  readonly onFenced: () => void;
}

interface Entry {
  record: PendingRecord;
  readonly op: AnyOperation | undefined;
  /** `undefined` when the input no longer parses (an older client's mutation). */
  readonly parsed: { readonly value: unknown } | undefined;
  persisted: boolean;
  sent: boolean;
  readonly settle: (outcome: MutationOutcome) => void;
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
  #stopped = false;
  #inFlight: AbortController | undefined;
  #retry: unknown;
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

  /** SPEC-002 §3.3. Throws `InvalidInputError` before queueing anything. */
  dispatch<Op extends AnyOperation>(op: Op, input: InputOf<Op>): Promise<MutationOutcome> {
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

    this.#nextSeq += 1;
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
      settle,
    };
    this.#entries.set(seq, entry);
    this.#publish();
    const mutation = this.#overlayOf(entry);
    if (mutation) this.#options.onPush(mutation);
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
   * waiting out a retry delay (SPEC-002 §3.6, review M3).
   */
  setOnline(online: boolean): void {
    this.#online = online;
    if (!online) {
      this.#inFlight?.abort('offline');
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
    if (this.#stopped || !this.#online || this.#inFlight || this.#retry !== undefined) return;
    const batch = this.#nextBatch();
    if (batch.length === 0) return;
    const controller = new AbortController();
    this.#inFlight = controller;
    const timeout = this.#options.timers.setTimeout(
      () => controller.abort('timeout'),
      REQUEST_TIMEOUT_MS,
    );
    for (const entry of batch) entry.sent = true;
    this.#publish();
    this.#send(batch, controller.signal).then(
      (next) => {
        this.#options.timers.clearTimeout(timeout);
        this.#inFlight = undefined;
        if (next === 'retry') this.#retryLater();
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

  async #send(batch: readonly Entry[], signal: AbortSignal): Promise<'next' | 'retry' | 'stop'> {
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
      schemaHash: this.#options.schemaHash,
      mutations,
    };
    let response: Response;
    let json: unknown;
    try {
      response = await this.#options.fetch(
        `${this.#options.baseUrl.replace(/\/$/, '')}${MUTATE_PATH}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          credentials: 'same-origin',
          signal,
        },
      );
      json = await response.json();
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
    const rejected: { entry: Entry; error: { code: string; message: string } }[] = [];
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
      this.#options.onRejected({ op, seq, input, code: error.code, message: error.message });
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

  #retryLater(): void {
    if (this.#stopped) return;
    const delay = backoffDelay(this.#attempt, this.#options.random());
    this.#attempt += 1;
    this.#retry = this.#options.timers.setTimeout(() => {
      this.#retry = undefined;
      this.#flush();
    }, delay);
  }
}
