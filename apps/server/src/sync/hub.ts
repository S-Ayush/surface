/**
 * The sync hub (SPEC-002 §4.3, sync-protocol §4.3, PLAN-002 S4): live deltas for every open
 * WebSocket, and catch-up for new ones.
 *
 * - **Live:** on `NOTIFY sync` the hub reads `sync_log` from `broadcastedUpTo` to the head, so
 *   every delivery ends at a transaction boundary, and hands the rows to each live connection.
 * - **Catch-up:** a new connection is registered and takes `upTo = broadcastedUpTo` in the same
 *   tick, so it is a live recipient of everything after `upTo` (buffered meanwhile) and catches
 *   up on `(since, upTo]` a page at a time. Nothing is missed, and the writer drops overlaps.
 * - **Resync:** `schema` when the client's hash differs, `too_old` when its `since` is outside
 *   retention. The client then re-bootstraps and closes the socket itself.
 * - **Liveness:** a `ping` every 25 s; no `pong` within 10 s ends the connection. Each ping round
 *   also reads the log, so a listen connection that silently stopped delivering costs at most one
 *   interval of lag, and a failed read is retried.
 * - **Backpressure:** catch-up waits while the socket has more than `catchUpHighWaterBytes`
 *   queued. A live client that lets more than `maxSocketBytes` pile up, or whose live backlog
 *   outgrows `maxBufferedRows` while it catches up, is dropped and reconnects.
 */
import { setTimeout as delay } from 'node:timers/promises';
import {
  CloseCode,
  decodeClientMessage,
  encodeSocketMessage,
  PING_INTERVAL_MS,
  PING_TIMEOUT_MS,
  type ServerMessage,
} from '@surface/sync-protocol';
import type { Logger } from 'pino';
import { Gauge, Histogram, type Registry } from 'prom-client';
import { loggableError } from '../executor/log-error.js';
import { DeltaWriter, type LogRow } from './delta-writer.js';
import type { Listener, SyncLogSource } from './hub-source.js';
import type { SyncModel, SyncRegistry } from './registry.js';

/** The part of a WebSocket the hub uses. */
export interface HubSocket {
  send(text: string): void;
  close(code: number, reason?: string): void;
  /** Ends the connection without a closing handshake (the peer is gone or too slow). */
  terminate(): void;
  readonly bufferedAmount: number;
}

export interface ConnectionInfo {
  readonly userId: string;
  /** For `closeSessions`, once sessions exist (PLAN-001 S3). */
  readonly sessionId?: string;
  readonly clientId: string;
  readonly groups: readonly string[];
  readonly since: number;
  readonly schemaHash: string;
}

/** What the route tells the hub about one socket. */
export interface HubConnection {
  receive(text: string): void;
  closed(): void;
}

export interface HubMetrics {
  /** Notification received → rows handed to every connection (SPEC-002 §10). */
  observeLag(seconds: number): void;
  setConnections(count: number): void;
}

export interface HubOptions {
  readonly source: SyncLogSource;
  readonly registry: SyncRegistry;
  readonly log: Logger;
  readonly metrics?: HubMetrics;
  readonly pingIntervalMs?: number;
  readonly pongTimeoutMs?: number;
  /** Rows per catch-up read (and the writer cuts messages of up to 500 packets). */
  readonly catchUpPageSize?: number;
  /** Live rows held for one connection while it catches up, before it is dropped. */
  readonly maxBufferedRows?: number;
  /** Bytes queued on a live socket before it is dropped as too slow. */
  readonly maxSocketBytes?: number;
  /** Bytes queued on the socket above which catch-up waits for the client to read. */
  readonly catchUpHighWaterBytes?: number;
  /** How often catch-up looks at the socket again while waiting. */
  readonly drainPollMs?: number;
  /** First wait before listening again after the listen connection failed; doubles to 30 s. */
  readonly retryDelayMs?: number;
}

/** Close codes besides the protocol's own (`CloseCode`). */
const INTERNAL_ERROR = 1011;
const TRY_AGAIN_LATER = 1013;
const POLICY_VIOLATION = 1008;
const MAX_RETRY_DELAY_MS = 30_000;

interface Connection {
  readonly info: ConnectionInfo;
  readonly socket: HubSocket;
  readonly writer: DeltaWriter;
  /** `catching-up` buffers live rows; `idle` (after a resync) gets nothing more. */
  state: 'catching-up' | 'live' | 'idle';
  buffer: (readonly LogRow[])[];
  bufferedRows: number;
  pongTimer: NodeJS.Timeout | undefined;
  open: boolean;
}

export class SyncHub {
  readonly #options: Required<Omit<HubOptions, 'metrics'>> & Pick<HubOptions, 'metrics'>;
  readonly #models: ReadonlyMap<string, SyncModel>;
  readonly #connections = new Set<Connection>();
  #metrics: HubMetrics | undefined;
  #broadcastedUpTo: number | undefined;
  #listener: Listener | undefined;
  #pingTimer: NodeJS.Timeout | undefined;
  #stopped = false;
  #draining: Promise<void> | undefined;
  #drainAgain = false;
  #notifiedAt: number | undefined;
  #retryDelayMs: number;

  constructor(options: HubOptions) {
    this.#options = {
      pingIntervalMs: PING_INTERVAL_MS,
      pongTimeoutMs: PING_TIMEOUT_MS,
      catchUpPageSize: 500,
      maxBufferedRows: 50_000,
      maxSocketBytes: 8 * 1024 * 1024,
      catchUpHighWaterBytes: 1024 * 1024,
      drainPollMs: 20,
      retryDelayMs: 1000,
      ...options,
    };
    this.#models = new Map(options.registry.models.map((model) => [model.name, model]));
    this.#retryDelayMs = this.#options.retryDelayMs;
    this.#metrics = options.metrics;
  }

  /** Records into the app's `/metrics` registry, which is built after the hub. */
  useMetrics(metrics: HubMetrics): void {
    this.#metrics = metrics;
    metrics.setConnections(this.#connections.size);
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  /** Whether `start()` has finished: connections are accepted only then. */
  get started(): boolean {
    return this.#broadcastedUpTo !== undefined && !this.#stopped;
  }

  /**
   * Starts listening, then takes the head as delivered: a client connecting after this catches
   * up from its own `since`. Rejects if the database can't be reached.
   */
  async start(): Promise<void> {
    const listener = await this.#options.source.listen(() => this.#requestDrain(true));
    try {
      this.#broadcastedUpTo = await this.#options.source.head();
    } catch (error) {
      await listener.close().catch(() => undefined);
      throw error;
    }
    this.#listener = listener;
    this.#watch(listener);
    this.#pingTimer = setInterval(() => this.#tick(), this.#options.pingIntervalMs);
    this.#pingTimer.unref();
    // Anything committed between LISTEN and reading the head was delivered to nobody yet, and
    // nobody is connected; draining once is still cheap and keeps the invariant simple.
    this.#requestDrain(false);
  }

  /** Closes every connection with `1012` (reconnect with backoff) and stops listening. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    clearInterval(this.#pingTimer);
    for (const connection of [...this.#connections]) {
      this.#close(connection, CloseCode.ServiceRestart, 'Server restarting');
    }
    await this.#listener?.close().catch(() => undefined);
    await this.#draining;
  }

  /** Closes the connections of these sessions with `4001` (SPEC-002 E10). */
  closeSessions(sessionIds: Iterable<string>): number {
    const ids = new Set(sessionIds);
    let closed = 0;
    for (const connection of [...this.#connections]) {
      const { sessionId } = connection.info;
      if (sessionId !== undefined && ids.has(sessionId)) {
        this.#close(connection, CloseCode.SessionRevoked, 'Session revoked');
        closed += 1;
      }
    }
    return closed;
  }

  connect(socket: HubSocket, info: ConnectionInfo): HubConnection {
    const connection: Connection = {
      info,
      socket,
      state: 'catching-up',
      buffer: [],
      bufferedRows: 0,
      pongTimer: undefined,
      open: true,
      writer: new DeltaWriter({
        models: this.#models,
        groups: new Set(info.groups),
        clientId: info.clientId,
        since: info.since,
        send: (message) => this.#send(connection, message),
      }),
    };
    const handle: HubConnection = {
      receive: (text) => this.#receive(connection, text),
      closed: () => this.#forget(connection),
    };
    const upTo = this.#broadcastedUpTo;
    if (upTo === undefined || this.#stopped) {
      socket.close(TRY_AGAIN_LATER, 'Sync is starting');
      return handle;
    }
    this.#connections.add(connection);
    this.#metrics?.setConnections(this.#connections.size);
    if (info.schemaHash !== this.#options.registry.schemaHash) {
      this.#resync(connection, 'schema');
      return handle;
    }
    void this.#catchUp(connection, upTo);
    return handle;
  }

  async #catchUp(connection: Connection, upTo: number): Promise<void> {
    const { info, writer } = connection;
    try {
      const events = this.#options.source.catchUp({
        since: info.since,
        upTo,
        groups: info.groups,
        clientId: info.clientId,
        pageSize: this.#options.catchUpPageSize,
      });
      for await (const event of events) {
        // Leaving the loop stops the reads (the generator returns).
        if (!connection.open) return;
        if (event.t === 'too_old') {
          this.#resync(connection, 'too_old');
          return;
        }
        writer.add(event.rows);
        writer.flush(false);
        if (!(await this.#writable(connection))) return;
      }
      if (!connection.open) return;
      writer.flush(true);
      // Live rows that arrived meanwhile, one delivery at a time with the same backpressure.
      // Deliveries go on buffering until the loop finds the buffer empty; from that check to going
      // live is synchronous, so no delivery can slip in between.
      for (;;) {
        if (!(await this.#writable(connection))) return;
        const rows = connection.buffer.shift();
        if (rows === undefined) break;
        connection.bufferedRows -= rows.length;
        writer.add(rows);
        writer.flush(true);
      }
      connection.state = 'live';
    } catch (error) {
      this.#options.log.error({ err: loggableError(error) }, 'sync catch-up failed');
      this.#close(connection, INTERNAL_ERROR, 'Catch-up failed');
    }
  }

  /**
   * Waits while the client has more than the high-water mark queued, so catch-up streams at the
   * client's pace instead of into memory. A client that stops reading misses its pong and is
   * ended, which ends the wait. False when the connection is gone.
   */
  async #writable(connection: Connection): Promise<boolean> {
    while (
      connection.open &&
      connection.socket.bufferedAmount > this.#options.catchUpHighWaterBytes
    ) {
      await delay(this.#options.drainPollMs, undefined, { ref: false });
    }
    return connection.open;
  }

  #resync(connection: Connection, reason: 'schema' | 'too_old'): void {
    connection.state = 'idle';
    connection.buffer = [];
    connection.bufferedRows = 0;
    this.#send(connection, { t: 'resync', reason });
  }

  /**
   * Reads and delivers what committed since the last delivery. `notified`: a notification asked
   * for it, so the time until delivery is broadcast lag (SPEC-002 §10); polls don't count.
   */
  #requestDrain(notified: boolean): void {
    if (notified) this.#notifiedAt ??= performance.now();
    if (this.#draining) {
      this.#drainAgain = true;
      return;
    }
    this.#draining = this.#drain().finally(() => {
      this.#draining = undefined;
    });
  }

  async #drain(): Promise<void> {
    do {
      this.#drainAgain = false;
      const notifiedAt = this.#notifiedAt;
      this.#notifiedAt = undefined;
      try {
        const from = this.#broadcastedUpTo;
        if (from === undefined || this.#stopped) return;
        const target = await this.#options.source.head();
        if (target <= from) continue;
        const rows = await this.#options.source.read(from, target);
        if (this.#stopped) return;
        this.#deliver(rows, target);
        if (notifiedAt !== undefined) {
          this.#metrics?.observeLag((performance.now() - notifiedAt) / 1000);
        }
      } catch (error) {
        // Nothing was delivered: the next notification or ping round reads the same rows again,
        // and its lag counts from this notification.
        this.#options.log.error({ err: loggableError(error) }, 'sync broadcast failed');
        if (notifiedAt !== undefined) this.#notifiedAt ??= notifiedAt;
      }
    } while (this.#drainAgain);
  }

  /** Synchronous, so a connection registers either before or after a whole delivery. */
  #deliver(rows: readonly LogRow[], target: number): void {
    for (const connection of this.#connections) {
      if (connection.state === 'live') {
        connection.writer.add(rows);
        connection.writer.flush(true);
      } else if (connection.state === 'catching-up') {
        connection.buffer.push(rows);
        connection.bufferedRows += rows.length;
        if (connection.bufferedRows > this.#options.maxBufferedRows) {
          this.#options.log.warn(
            { userId: connection.info.userId },
            'sync client too slow to catch up',
          );
          this.#close(connection, TRY_AGAIN_LATER, 'Too far behind');
        }
      }
    }
    this.#broadcastedUpTo = target;
  }

  /** Listens again (with backoff) when the listen connection ends, then catches up on missed rows. */
  #watch(listener: Listener): void {
    void listener.ended.then((error) => {
      if (this.#stopped || this.#listener !== listener) return;
      this.#options.log.warn({ err: loggableError(error) }, 'sync listener lost; reconnecting');
      this.#listener = undefined;
      // An error doesn't always end the connection; end it, so it can't linger or notify twice.
      void listener.close().catch(() => undefined);
      void this.#relisten();
    });
  }

  async #relisten(): Promise<void> {
    while (!this.#stopped) {
      await delay(this.#retryDelayMs, undefined, { ref: false });
      if (this.#stopped) return;
      try {
        const listener = await this.#options.source.listen(() => this.#requestDrain(true));
        if (this.#stopped) {
          await listener.close();
          return;
        }
        this.#listener = listener;
        this.#retryDelayMs = this.#options.retryDelayMs;
        this.#watch(listener);
        this.#options.log.info('sync listener reconnected');
        // Notifications sent while it was down are lost; the log is not.
        this.#requestDrain(false);
        return;
      } catch (error) {
        this.#options.log.warn({ err: loggableError(error) }, 'sync listener reconnect failed');
        this.#retryDelayMs = Math.min(this.#retryDelayMs * 2, MAX_RETRY_DELAY_MS);
      }
    }
  }

  #receive(connection: Connection, text: string): void {
    try {
      const message = decodeClientMessage(text);
      if (message.t === 'pong') {
        clearTimeout(connection.pongTimer);
        connection.pongTimer = undefined;
      }
    } catch {
      this.#close(connection, POLICY_VIOLATION, 'Unknown message');
    }
  }

  #tick(): void {
    this.#pingAll();
    // A listen connection can stop delivering without ending (a half-open TCP connection until
    // keepalive notices), and a failed read is not retried by itself. Polling bounds both.
    this.#requestDrain(false);
  }

  #pingAll(): void {
    for (const connection of this.#connections) {
      if (connection.pongTimer !== undefined) continue;
      this.#send(connection, { t: 'ping' });
      connection.pongTimer = setTimeout(() => {
        this.#options.log.info({ userId: connection.info.userId }, 'sync client missed a pong');
        this.#terminate(connection);
      }, this.#options.pongTimeoutMs);
      connection.pongTimer.unref();
    }
  }

  #send(connection: Connection, message: ServerMessage): void {
    if (!connection.open) return;
    connection.socket.send(encodeSocketMessage(message));
    // Catch-up waits for the client instead (`#writable`).
    if (
      connection.state === 'live' &&
      connection.socket.bufferedAmount > this.#options.maxSocketBytes
    ) {
      // It reconnects and catches up from what it has applied.
      this.#options.log.warn({ userId: connection.info.userId }, 'sync client too slow to read');
      this.#terminate(connection);
    }
  }

  #close(connection: Connection, code: number, reason: string): void {
    if (!connection.open) return;
    this.#forget(connection);
    connection.socket.close(code, reason);
  }

  #terminate(connection: Connection): void {
    if (!connection.open) return;
    this.#forget(connection);
    connection.socket.terminate();
  }

  #forget(connection: Connection): void {
    connection.open = false;
    clearTimeout(connection.pongTimer);
    connection.buffer = [];
    if (this.#connections.delete(connection)) {
      this.#metrics?.setConnections(this.#connections.size);
    }
  }
}

/** The hub's metrics on the `/metrics` registry (SPEC-002 §10: broadcast lag p95 < 20 ms). */
export function hubMetrics(registry: Registry): HubMetrics {
  const lag = new Histogram({
    name: 'surface_sync_broadcast_lag_seconds',
    help: 'Time from a sync notification to its rows being handed to every connection, in seconds',
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 1],
    registers: [registry],
  });
  const connections = new Gauge({
    name: 'surface_sync_connections',
    help: 'Open sync WebSocket connections',
    registers: [registry],
  });
  return {
    observeLag: (seconds) => lag.observe(seconds),
    setConnections: (count) => connections.set(count),
  };
}
