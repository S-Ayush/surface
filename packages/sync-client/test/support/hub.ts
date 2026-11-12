/**
 * An in-process fake of the server side of sync (PLAN-002 S3/S4), speaking
 * the S1 protocol: a `sync_log` of `DebugItem` changes, a bootstrap from the
 * same state, and WebSocket connections with catch-up, live delivery, `prev`,
 * `resync` and close codes. Faults are injected per connection.
 */
import type { ModelRow } from '@surface/domain/model';
import type {
  Ack,
  BootstrapFrame,
  ClientMessage,
  DeltaPacket,
  MutateRequest,
  MutationResult,
  ServerMessage,
} from '@surface/sync-protocol';
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  CSRF_INVALID,
  CloseCode,
  MAX_MUTATION_BATCH_BYTES,
  MUTATE_PATH,
  SESSION_PATH,
  decodeBootstrapQuery,
  decodeClientMessage,
  decodeMutateRequest,
  decodeSocketConnectParams,
  encodeSocketMessage,
} from '@surface/sync-protocol';
import type { FetchLike } from '../../src/bootstrap.js';
import type { SocketConnection, SocketFactory, SocketHandlers } from '../../src/socket.js';
import type { ConnectionOptions } from '../../src/store.js';
import { USER_ID, debugRow, id } from './models.js';
import { TEST_SCHEMA_HASH, bootstrapFrames, ndjsonResponse } from './server.js';
import { ManualTimers } from './timers.js';

/** A connection that never opens, with timers that never fire: for tests that leave sync alone. */
export function quietConnection(): ConnectionOptions {
  return {
    socket: () => ({ send: () => undefined, close: () => undefined }),
    timers: new ManualTimers(),
  };
}

interface ServerRow {
  row: ModelRow;
  archived: boolean;
}

/** A whole-request error in the SPEC-003 shape. */
function errorResponse(status: number, code: string): Response {
  return new Response(
    JSON.stringify({ ok: false, error: { code, message: `Refused: ${code}`, correlationId: 'c' } }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

export class FakeHub {
  readonly rows = new Map<string, ServerRow>();
  readonly log: DeltaPacket[] = [];
  readonly connections: HubConnection[] = [];
  head: number;
  /** A `since` below this is outside retention: `resync(too_old)`. */
  retainedFrom = 0;
  schemaHash = TEST_SCHEMA_HASH;
  /** Packets per `deltas` message during catch-up. */
  pageSize = 500;
  bootstraps = 0;
  /** The `(clientId, seq)` behind each sync id a client's own mutation wrote. */
  readonly acks = new Map<number, Ack>();
  /** Per client: the last seq processed and every stored result (`client_mutations`). */
  readonly clients = new Map<string, { lastSeq: number; results: Map<number, MutationResult> }>();
  /** Every mutate request received, in order. */
  readonly mutateRequests: MutateRequest[] = [];
  /** Faults: fail the next N requests before processing, or lose the next N responses after. */
  failRequests = 0;
  loseResponses = 0;
  /** The body limit (Fastify's `bodyLimit`): a larger request gets a 413. */
  maxBodyBytes = MAX_MUTATION_BATCH_BYTES;
  /** Batches containing one of these ops are refused as a whole (400 `INVALID_INPUT`). */
  readonly invalidOps = new Set<string>();
  /** Held requests the client aborted. */
  aborted = 0;
  /** The UTF-8 size of every mutate request body, in order. */
  readonly bodySizes: number[] = [];
  /** Hold mutate responses until `release()`; requests are processed at once. */
  holdResponses = false;
  readonly #held: (() => void)[] = [];
  #acking: Ack | undefined;
  /**
   * CSRF as the server checks it (SPEC-001 §6.1): when set, a mutate request
   * must carry this token in `X-CSRF-Token`, or gets `403 CSRF_INVALID`.
   */
  csrfToken: string | undefined;
  /** The browser's cookie jar: `GET /auth/session` sets `surface_csrf` in it. */
  readonly cookies = new Map<string, string>();
  /** `GET /auth/session` requests, and mutate requests refused for CSRF. */
  sessionRequests = 0;
  csrfRefusals = 0;
  /** What `GET /auth/session` answers: `401` when the session is gone. */
  sessionStatus = 200;
  /**
   * No session for this browser's cookie, or one of another user (SPEC-002 E14):
   * mutate answers `401`, and a new socket opens and is closed with `4001` before
   * any message, as the real hub accepts the upgrade first (sync-protocol §4.3).
   */
  signedOut = false;
  /** Refuse every mutate request with `403 FORBIDDEN` (not a CSRF refusal). */
  forbidMutate = false;
  /** The `userId` each request named, in order (SPEC-002 E14). */
  readonly users: { bootstrap: string[]; mutate: string[]; socket: string[] } = {
    bootstrap: [],
    mutate: [],
    socket: [],
  };
  /** The headers of every mutate request, in order. */
  readonly mutateHeaders: Headers[] = [];

  constructor(head = 100) {
    this.head = head;
  }

  /** `GET /sync/bootstrap` from the current state, `POST /sync/mutate`, or `GET /auth/session`. */
  readonly fetch: FetchLike = (url, init) => {
    if (url.endsWith(MUTATE_PATH)) return this.#mutate(init);
    if (url.endsWith(SESSION_PATH)) {
      this.sessionRequests += 1;
      if (this.sessionStatus !== 200) {
        this.cookies.delete(CSRF_COOKIE);
        return Promise.resolve(errorResponse(this.sessionStatus, 'UNAUTHENTICATED'));
      }
      if (this.csrfToken !== undefined) this.cookies.set(CSRF_COOKIE, this.csrfToken);
      return Promise.resolve(
        new Response(JSON.stringify({ userId: USER_ID, workspaceId: 'ws' }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    const query = decodeBootstrapQuery(Object.fromEntries(new URL(url).searchParams));
    this.users.bootstrap.push(query.userId);
    this.bootstraps += 1;
    return Promise.resolve(ndjsonResponse(this.snapshot()));
  };

  /** Let held mutate responses through, in order. */
  release(): void {
    for (const send of this.#held.splice(0)) send();
  }

  /** How many times the server ran a mutation (not counting replays). */
  executed(op?: string): number {
    return this.mutateRequests
      .flatMap((request) => request.mutations)
      .filter((m) => op === undefined || m.op === op).length;
  }

  #mutate(init: RequestInit): Promise<Response> {
    if (this.failRequests > 0) {
      this.failRequests -= 1;
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    const headers = new Headers(init.headers);
    this.mutateHeaders.push(headers);
    if (this.signedOut) return Promise.resolve(errorResponse(401, 'UNAUTHENTICATED'));
    if (this.csrfToken !== undefined && headers.get(CSRF_HEADER) !== this.csrfToken) {
      this.csrfRefusals += 1;
      return Promise.resolve(errorResponse(403, CSRF_INVALID));
    }
    if (this.forbidMutate) return Promise.resolve(errorResponse(403, 'FORBIDDEN'));
    if (typeof init.body !== 'string') throw new Error('The queue sends a JSON string body');
    const respond = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const size = new TextEncoder().encode(init.body).length;
    this.bodySizes.push(size);
    if (size > this.maxBodyBytes) {
      return Promise.resolve(
        respond(413, {
          ok: false,
          error: { code: 'PAYLOAD_TOO_LARGE', message: 'Too large', correlationId: 'c' },
        }),
      );
    }
    const request = decodeMutateRequest(JSON.parse(init.body));
    this.users.mutate.push(request.userId);
    if (request.mutations.some((m) => this.invalidOps.has(m.op))) {
      return Promise.resolve(
        respond(400, {
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'This change is not valid on the server.',
            correlationId: 'c',
          },
        }),
      );
    }
    if (request.schemaHash !== this.schemaHash) {
      return Promise.resolve(
        respond(426, {
          ok: false,
          error: { code: 'CLIENT_OUTDATED', message: 'Reload', correlationId: 'c' },
        }),
      );
    }
    let client = this.clients.get(request.clientId);
    if (client === undefined) {
      this.clients.set(request.clientId, (client = { lastSeq: 0, results: new Map() }));
    }
    const first = request.mutations[0]?.seq ?? 1;
    if (first > client.lastSeq + 1) {
      return Promise.resolve(
        respond(400, {
          ok: false,
          error: { code: 'SEQ_GAP', message: 'Gap', correlationId: 'c', lastSeq: client.lastSeq },
        }),
      );
    }
    const fresh = request.mutations.filter((m) => m.seq > (client?.lastSeq ?? 0));
    this.mutateRequests.push({ ...request, mutations: fresh });
    const results = request.mutations.map((mutation): MutationResult => {
      const stored = client.results.get(mutation.seq);
      if (stored) return stored;
      const result = this.#execute(request.clientId, mutation.seq, mutation.op, mutation.input);
      client.results.set(mutation.seq, result);
      client.lastSeq = mutation.seq;
      return result;
    });
    if (this.loseResponses > 0) {
      this.loseResponses -= 1;
      return Promise.reject(new TypeError('Failed to fetch'));
    }
    const response = respond(200, { results });
    if (!this.holdResponses) return Promise.resolve(response);
    return new Promise((resolve, reject) => {
      this.#held.push(() => resolve(response));
      // Like `fetch`: an abort rejects the request (the server already ran it).
      init.signal?.addEventListener('abort', () => {
        this.aborted += 1;
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    });
  }

  /** The server side of the fixture operations (`ops.ts`), one transaction each. */
  #execute(clientId: string, seq: number, op: string, input: unknown): MutationResult {
    const fields = typeof input === 'object' && input !== null ? input : {};
    const get = (key: string): unknown => (key in fields ? Reflect.get(fields, key) : undefined);
    const itemId = String(get('id'));
    const existing = this.rows.get(itemId);
    const notFound = (): MutationResult => ({
      seq,
      status: 'error',
      error: { code: 'NOT_FOUND', message: 'Debug item not found. It may have been deleted.' },
    });
    this.#acking = { clientId, seq };
    try {
      switch (op) {
        case 'debug.create':
          if (existing) {
            // With issues, as the server sends a field's refusal (SPEC-003 §9).
            const message = 'A debug item with this id exists.';
            return {
              seq,
              status: 'error',
              error: { code: 'CONFLICT', message, issues: [{ path: ['id'], message }] },
            };
          }
          this.#upsertRow({
            id: itemId,
            title: String(get('title')),
            counter: 0,
            groups: ['workspace'],
            archivedAt: null,
          });
          break;
        case 'debug.archive':
        case 'debug.unarchive':
          if (!existing) return notFound();
          this.#archiveRow(itemId, op === 'debug.archive');
          break;
        case 'debug.rename':
        case 'debug.broken':
          if (!existing) return notFound();
          this.#upsertRow({ ...existing.row, title: String(get('title')) });
          break;
        case 'debug.touch':
          if (!existing) return notFound();
          this.#upsertRow({ ...existing.row, counter: Number(existing.row.counter) + 1 });
          break;
        case 'debug.delete':
          if (!existing) return notFound();
          this.rows.delete(itemId);
          this.#commit({ id: this.head + 1, a: 'D', m: 'DebugItem', mid: itemId });
          break;
        case 'debug.hide':
          this.invisible();
          this.acks.set(this.head, { clientId, seq });
          for (const connection of this.live) connection.deliver();
          break;
        default:
          return { seq, status: 'error', error: { code: 'UNKNOWN_OPERATION', message: op } };
      }
      return { seq, status: 'ok', lastSyncId: this.head };
    } finally {
      this.#acking = undefined;
    }
  }

  #upsertRow(row: ModelRow): void {
    const existing = this.rows.get(row.id);
    this.rows.set(row.id, { row, archived: existing?.archived ?? false });
    this.#commit({ id: this.head + 1, a: existing ? 'U' : 'I', m: 'DebugItem', d: { ...row } });
  }

  /** The bootstrap frames of the current state (one REPEATABLE READ snapshot). */
  snapshot(): BootstrapFrame[] {
    const rows = [...this.rows.values()]
      .sort((a, b) => (a.row.id < b.row.id ? -1 : 1))
      .map(({ row, archived }) => ({ model: 'DebugItem', row, archived }));
    return bootstrapFrames(rows, { lastSyncId: this.head, schemaHash: this.schemaHash });
  }

  /** `GET /sync/ws`: opens on the next microtask, like a real socket. */
  readonly socket: SocketFactory = (url, handlers) => {
    const connection = new HubConnection(this, url, handlers);
    this.connections.push(connection);
    queueMicrotask(() => connection.open());
    return connection.client;
  };

  /** Connections that are open and not closed. */
  get live(): HubConnection[] {
    return this.connections.filter((c) => c.isOpen);
  }

  /** The most recent connection. */
  get last(): HubConnection {
    const connection = this.connections.at(-1);
    if (connection === undefined) throw new Error('no connection yet');
    return connection;
  }

  // Writes: one sync_log packet each, delivered to every live connection.

  upsert(n: number, fields: Record<string, unknown> = {}): void {
    const existing = this.rows.get(id(n));
    const row = debugRow(n, { ...(existing?.row ?? {}), ...fields });
    this.rows.set(id(n), { row, archived: existing?.archived ?? false });
    this.#commit({ id: this.head + 1, a: existing ? 'U' : 'I', m: 'DebugItem', d: { ...row } });
  }

  /**
   * Archive (or unarchive) as the repo does: set (or clear) `archivedAt`, also when it already
   * is, and log an `A` (or `V`) with the full row (v0.7, SPEC-011 §5.5).
   */
  archive(n: number, archived = true): void {
    this.#archiveRow(id(n), archived);
  }

  #archiveRow(rowId: string, archived: boolean): void {
    const existing = this.rows.get(rowId);
    if (existing === undefined) return;
    const archivedAt = archived ? new Date(Date.now()).toISOString() : null;
    const row = { ...existing.row, archivedAt };
    this.rows.set(rowId, { row, archived });
    this.#commit({ id: this.head + 1, a: archived ? 'A' : 'V', m: 'DebugItem', d: { ...row } });
  }

  remove(n: number): void {
    if (!this.rows.delete(id(n))) return;
    this.#commit({ id: this.head + 1, a: 'D', m: 'DebugItem', mid: id(n) });
  }

  /** A change to rows the client cannot see: the id is used, nothing is sent. */
  invisible(): void {
    this.head += 1;
  }

  #commit(packet: DeltaPacket): void {
    this.head = packet.id;
    this.log.push(packet);
    if (this.#acking) this.acks.set(packet.id, this.#acking);
    for (const connection of this.live) connection.deliver();
  }
}

export class HubConnection {
  readonly since: number;
  readonly clientId: string;
  readonly userId: string;
  readonly schemaHash: string;
  readonly received: ClientMessage[] = [];
  /** The id of the last packet sent on this connection (`prev` of the next message). */
  sent: number;
  /** Acks are sent for sync ids up to here. */
  ackedThrough: number;
  /** Messages sent to the client, in order. */
  readonly messages: ServerMessage[] = [];
  isOpen = false;
  closedWith: number | undefined;
  /** When set, `deliver` holds packets back (a slow or stalled server). */
  paused = false;

  readonly client: SocketConnection;

  constructor(
    readonly hub: FakeHub,
    url: string,
    readonly handlers: SocketHandlers,
  ) {
    const parsed = new URL(url);
    const params = decodeSocketConnectParams(Object.fromEntries(parsed.searchParams));
    this.since = params.since;
    this.clientId = params.clientId;
    this.userId = params.userId;
    hub.users.socket.push(params.userId);
    this.schemaHash = params.schemaHash;
    this.sent = params.since;
    this.ackedThrough = params.since;
    this.client = {
      send: (data) => {
        this.received.push(decodeClientMessage(data));
      },
      close: (code) => {
        this.isOpen = false;
        this.closedWith ??= code;
      },
    };
  }

  open(): void {
    if (this.closedWith !== undefined) return;
    this.isOpen = true;
    if (this.hub.signedOut) {
      this.handlers.onOpen();
      this.close(CloseCode.SessionRevoked);
      return;
    }
    this.handlers.onOpen();
    if (this.schemaHash !== this.hub.schemaHash) this.send({ t: 'resync', reason: 'schema' });
    else if (this.since < this.hub.retainedFrom) this.send({ t: 'resync', reason: 'too_old' });
    else this.deliver();
  }

  /**
   * Send every logged packet after `sent`, in pages, each with its `prev`, and
   * the acks of this client's mutations they cover. Acks for mutations with
   * no visible packet go in a message of their own (`packets: []`).
   */
  deliver(): void {
    if (!this.isOpen || this.paused) return;
    const packets = this.hub.log.filter((packet) => packet.id > this.sent);
    for (let start = 0; start < packets.length; start += this.hub.pageSize) {
      const page = packets.slice(start, start + this.hub.pageSize);
      const last = page.at(-1);
      if (last === undefined) break;
      const ack = this.#acksThrough(last.id);
      this.send({ t: 'deltas', prev: this.sent, packets: page, ack });
      this.sent = last.id;
    }
    const rest = this.#acksThrough(this.hub.head);
    if (rest.length > 0) this.send({ t: 'deltas', prev: this.sent, packets: [], ack: rest });
  }

  /** This client's acks for sync ids after `ackedThrough`, up to `id`. */
  #acksThrough(id: number): Ack[] {
    const acks = [...this.hub.acks]
      .filter(([at, ack]) => at > this.ackedThrough && at <= id && ack.clientId === this.clientId)
      .map(([, ack]) => ack);
    this.ackedThrough = Math.max(this.ackedThrough, id);
    return acks;
  }

  send(message: ServerMessage): void {
    if (!this.isOpen) return;
    this.messages.push(message);
    this.handlers.onMessage(encodeSocketMessage(message));
  }

  /** Send raw text, e.g. a malformed frame. */
  sendRaw(data: unknown): void {
    if (this.isOpen) this.handlers.onMessage(data);
  }

  /** Lose the next `count` packets: the hub believes it sent them. */
  lose(count = 1): void {
    const lost = this.hub.log.filter((packet) => packet.id > this.sent).slice(0, count);
    const last = lost.at(-1);
    if (last) this.sent = last.id;
  }

  /** Send the last `deltas` message again (a duplicate after a retry). */
  repeat(): void {
    const last = this.messages.findLast((message) => message.t === 'deltas');
    if (last) this.send(last);
  }

  /** Close from the server side (default: the network dropped, 1006). */
  close(code = 1006): void {
    if (this.closedWith !== undefined) return;
    this.isOpen = false;
    this.closedWith = code;
    this.handlers.onClose(code);
  }

  revoke(): void {
    this.close(CloseCode.SessionRevoked);
  }
}
