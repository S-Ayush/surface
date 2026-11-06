/**
 * An in-process fake of the server side of sync (PLAN-002 S3/S4), speaking
 * the S1 protocol: a `sync_log` of `DebugItem` changes, a bootstrap from the
 * same state, and WebSocket connections with catch-up, live delivery, `prev`,
 * `resync` and close codes. Faults are injected per connection.
 */
import type { ModelRow } from '@surface/domain/model';
import type {
  BootstrapFrame,
  ClientMessage,
  DeltaPacket,
  ServerMessage,
} from '@surface/sync-protocol';
import {
  CloseCode,
  decodeClientMessage,
  decodeSocketConnectParams,
  encodeSocketMessage,
} from '@surface/sync-protocol';
import type { FetchLike } from '../../src/bootstrap.js';
import type { SocketConnection, SocketFactory, SocketHandlers } from '../../src/socket.js';
import type { ConnectionOptions } from '../../src/store.js';
import { debugRow, id } from './models.js';
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

  constructor(head = 100) {
    this.head = head;
  }

  /** `GET /sync/bootstrap` from the current state. */
  readonly fetch: FetchLike = () => {
    this.bootstraps += 1;
    return Promise.resolve(ndjsonResponse(this.snapshot()));
  };

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

  archive(n: number, archived = true): void {
    const existing = this.rows.get(id(n));
    if (existing === undefined) return;
    existing.archived = archived;
    this.#commit({ id: this.head + 1, a: archived ? 'A' : 'V', m: 'DebugItem', mid: id(n) });
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
    for (const connection of this.live) connection.deliver();
  }
}

export class HubConnection {
  readonly since: number;
  readonly clientId: string;
  readonly schemaHash: string;
  readonly received: ClientMessage[] = [];
  /** The id of the last packet sent on this connection (`prev` of the next message). */
  sent: number;
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
    this.schemaHash = params.schemaHash;
    this.sent = params.since;
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
    this.handlers.onOpen();
    if (this.schemaHash !== this.hub.schemaHash) this.send({ t: 'resync', reason: 'schema' });
    else if (this.since < this.hub.retainedFrom) this.send({ t: 'resync', reason: 'too_old' });
    else this.deliver();
  }

  /** Send every logged packet after `sent`, in pages, each with its `prev`. */
  deliver(): void {
    if (!this.isOpen || this.paused) return;
    const packets = this.hub.log.filter((packet) => packet.id > this.sent);
    for (let start = 0; start < packets.length; start += this.hub.pageSize) {
      const page = packets.slice(start, start + this.hub.pageSize);
      const last = page.at(-1);
      if (last === undefined) break;
      this.send({ t: 'deltas', prev: this.sent, packets: page, ack: [] });
      this.sent = last.id;
    }
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
