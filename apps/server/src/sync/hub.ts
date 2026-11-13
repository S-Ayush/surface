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
 *   retention, `groups` when a private team's membership changes and the connection's user may
 *   be the one who joined or left (a connection's home groups are fixed when it opens). The
 *   client then re-bootstraps and closes the socket itself.
 * - **Team subscriptions** (v0.8, SPEC-011 §5.7): a connection's groups are its home groups plus
 *   `team:<id>` of each public team its client follows. `subscribe` and `unsubscribe` are handled
 *   one at a time, in order, once the connection is live, so the writer has sent everything it
 *   took in: `subscribed`/`unsubscribed` go out at `at` = the last sync id taken in, and the next
 *   delivery is filtered with the new groups.
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
  type ClientMessage,
  type ServerMessage,
} from '@surface/sync-protocol';
import { teamGroup } from '@surface/domain';
import type { Logger } from 'pino';
import { Gauge, Histogram, type Registry } from 'prom-client';
import { loggableError } from '../executor/log-error.js';
import { DeltaWriter, type LogRow } from './delta-writer.js';
import type { TeamAccess } from './groups.js';
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
  /**
   * The home groups: `workspace`, `user:<id>`, each private team the user is a member of. Fixed
   * for the connection's life: `unsubscribe` never removes one.
   */
  readonly groups: readonly string[];
  /**
   * Teams followed from the start (v0.8): the accepted `teams` of the URL, or the user's member
   * teams when it names none. Catch-up uses them too.
   */
  readonly teams?: readonly string[];
  /** Whether to answer the URL's `teams` with `subscribed {teams, at: since}` first. */
  readonly ackTeams?: boolean;
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
  /**
   * Which teams a user may subscribe to (`acceptedTeams` over the database), read at each
   * `subscribe` and at connect. Without it, every subscription is ignored.
   */
  readonly teamAccess?: TeamAccess;
  /** `subscribe`/`unsubscribe` requests a connection may have waiting before it is closed. */
  readonly maxPendingRequests?: number;
}

/** Close codes besides the protocol's own (`CloseCode`). */
const INTERNAL_ERROR = 1011;
const TRY_AGAIN_LATER = 1013;
const POLICY_VIOLATION = 1008;
const MAX_RETRY_DELAY_MS = 30_000;
const TEAM_GROUP_PREFIX = teamGroup('');
const IGNORE_EVERY_TEAM: TeamAccess = () => Promise.resolve([]);

/**
 * Whether `rows` may change the sync groups of `info`'s user (permissions.md §2, sync-protocol
 * §6, SPEC-002 Q13): a membership of a private team (a row in a `team:` group) inserted for the
 * user, or deleted from a group they are in. A deleted row carries no data (Q4), so every
 * connection in that team's group is resynced, not only the leaver's: rare, and safe. Public
 * teams' memberships change no groups. A deletion the connection can't see (the user was
 * removed while away) is the source's `groups` event instead. Until `G` packets (M7), the client
 * learns its new groups by bootstrapping again, which also purges the team's rows from its
 * replica (PLAN-001 S9, security review M1).
 */
function changesGroups(
  rows: readonly LogRow[],
  info: ConnectionInfo,
  groups: ReadonlySet<string>,
): boolean {
  return rows.some((row) => {
    // The client has it already: a delivery can repeat rows up to its `since` (the writer drops
    // them), and a change it has applied asks for no resync.
    if (row.syncId <= info.since || row.model !== 'TeamMembership') return false;
    const teams = row.groups.filter((group) => group.startsWith(TEAM_GROUP_PREFIX));
    if (row.action === 'D') return teams.some((group) => groups.has(group));
    // Whatever the connection's groups: read after the join, they have the team already, but a
    // replica that catches up across its own join lacks the team's earlier rows.
    return row.action === 'I' && teams.length > 0 && row.data?.['userId'] === info.userId;
  });
}

/**
 * What an outdated client's connection carries (`connectOutdated`): nothing but its session, if
 * any. It is idle from the start, so none of it is read, except as an empty `userId` in a log line
 * about a missed pong.
 */
const OUTDATED_CLIENT: ConnectionInfo = {
  userId: '',
  clientId: '',
  groups: [],
  since: 0,
  schemaHash: '',
};

/** A `subscribe` or `unsubscribe`, waiting for its turn. */
type TeamRequest = Extract<ClientMessage, { t: 'subscribe' | 'unsubscribe' }>;

interface Connection {
  readonly info: ConnectionInfo;
  /** `info.groups`: never removed by `unsubscribe`. A change resyncs the connection instead. */
  readonly home: ReadonlySet<string>;
  /**
   * The connection's groups: the home groups plus each followed team's. The writer filters with
   * this very set, so a change applies from the next row it takes in.
   */
  readonly groups: Set<string>;
  /** `subscribe`/`unsubscribe` requests in arrival order, handled once live (`#pump`). */
  readonly requests: TeamRequest[];
  pumping: boolean;
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
      teamAccess: IGNORE_EVERY_TEAM,
      maxPendingRequests: 32,
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
    const listener = await this.#listen();
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

  #listen(): Promise<Listener> {
    return this.#options.source.listen(
      () => this.#requestDrain(true),
      // Ended on some replica (`notifySessionsRevoked`): close them here too.
      (sessionIds) => void this.closeSessions(sessionIds),
    );
  }

  /** Closes the connections of these sessions with `4001` (SPEC-002 E10), on this replica. */
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

  /**
   * The groups this replica's open connections of `clientId` receive (the user's), or undefined
   * when it has none here: the confirm point of a no-op mutation (`visibleHead`) uses them, never
   * every group the user may see (PLAN-011 S4b).
   */
  connectionGroups(userId: string, clientId: string): readonly string[] | undefined {
    let groups: Set<string> | undefined;
    for (const connection of this.#connections) {
      const { info } = connection;
      if (info.clientId !== clientId || info.userId !== userId || connection.state === 'idle') {
        continue;
      }
      groups ??= new Set();
      for (const group of connection.groups) groups.add(group);
    }
    return groups && [...groups];
  }

  connect(socket: HubSocket, info: ConnectionInfo): HubConnection {
    return this.#register(socket, info, (connection, upTo) => {
      if (info.schemaHash !== this.#options.registry.schemaHash) {
        this.#resync(connection, 'schema');
        return;
      }
      if (info.ackTeams === true) {
        // Catch-up from `since` already uses these teams (sync-protocol §4.3).
        this.#send(connection, { t: 'subscribed', teams: [...(info.teams ?? [])], at: info.since });
      }
      void this.#catchUp(connection, upTo);
    });
  }

  /**
   * A client from before sync-protocol v0.5, which names no user (SPEC-002 E14): `resync(schema)`
   * at once, then only pings, as after a schema mismatch. It has no user, groups or client, so it is
   * never caught up and never sent a delta; it is kept only to be pinged, and closed on shutdown or
   * when its session ends (4001, as any socket of that session).
   */
  connectOutdated(socket: HubSocket, sessionId?: string): HubConnection {
    const info = sessionId === undefined ? OUTDATED_CLIENT : { ...OUTDATED_CLIENT, sessionId };
    return this.#register(socket, info, (connection) => {
      this.#resync(connection, 'schema');
    });
  }

  /** Registers the socket and hands it to `start`, unless the hub is starting or stopping. */
  #register(
    socket: HubSocket,
    info: ConnectionInfo,
    start: (connection: Connection, upTo: number) => void,
  ): HubConnection {
    const home = new Set(info.groups);
    const groups = new Set([...home, ...(info.teams ?? []).map(teamGroup)]);
    const connection: Connection = {
      info,
      home,
      groups,
      requests: [],
      pumping: false,
      socket,
      state: 'catching-up',
      buffer: [],
      bufferedRows: 0,
      pongTimer: undefined,
      open: true,
      writer: new DeltaWriter({
        models: this.#models,
        groups,
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
    start(connection, upTo);
    return handle;
  }

  async #catchUp(connection: Connection, upTo: number): Promise<void> {
    const { info, writer } = connection;
    try {
      const events = this.#options.source.catchUp({
        since: info.since,
        upTo,
        // Fixed for the catch-up: team requests wait until the connection is live.
        groups: [...connection.groups],
        clientId: info.clientId,
        pageSize: this.#options.catchUpPageSize,
      });
      for await (const event of events) {
        // Leaving the loop stops the reads (the generator returns). A live delivery may have
        // resynced the connection meanwhile.
        if (!this.#catchingUp(connection)) return;
        if (event.t === 'too_old' || event.t === 'groups') {
          this.#resync(connection, event.t);
          return;
        }
        // The groups were read before the upgrade: a membership may have ended since.
        if (changesGroups(event.rows, connection.info, connection.groups)) {
          this.#resync(connection, 'groups');
          return;
        }
        writer.add(event.rows);
        writer.flush(false);
        if (!(await this.#writable(connection))) return;
      }
      if (!this.#catchingUp(connection)) return;
      writer.flush(true);
      // Live rows that arrived meanwhile, one delivery at a time with the same backpressure.
      // Deliveries go on buffering until the loop finds the buffer empty; from that check to going
      // live is synchronous, so no delivery can slip in between.
      for (;;) {
        if (!(await this.#writable(connection)) || !this.#catchingUp(connection)) return;
        const rows = connection.buffer.shift();
        if (rows === undefined) break;
        connection.bufferedRows -= rows.length;
        writer.add(rows);
        writer.flush(true);
      }
      connection.state = 'live';
      void this.#pump(connection);
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

  #catchingUp(connection: Connection): boolean {
    return connection.open && connection.state === 'catching-up';
  }

  #resync(connection: Connection, reason: 'schema' | 'too_old' | 'groups'): void {
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
      if (connection.state !== 'idle' && changesGroups(rows, connection.info, connection.groups)) {
        // Nothing of this delivery: rows after the change may be in a team the user left.
        this.#resync(connection, 'groups');
        continue;
      }
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
        const listener = await this.#listen();
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
    let message: ClientMessage;
    try {
      message = decodeClientMessage(text);
    } catch {
      this.#close(connection, POLICY_VIOLATION, 'Unknown message');
      return;
    }
    if (message.t === 'pong') {
      clearTimeout(connection.pongTimer);
      connection.pongTimer = undefined;
      return;
    }
    // An outdated client's connection is idle from the start and follows nothing.
    if (connection.state === 'idle') return;
    if (connection.requests.length >= this.#options.maxPendingRequests) {
      this.#close(connection, POLICY_VIOLATION, 'Too many subscription requests');
      return;
    }
    connection.requests.push(message);
    void this.#pump(connection);
  }

  /**
   * Handles the connection's `subscribe` and `unsubscribe` requests one at a time, in arrival
   * order, and only while it is live (SPEC-011 §5.7). While live, every delivery is flushed whole
   * and synchronously, so between deliveries the writer holds nothing: everything up to
   * `writer.through` has been sent with the old groups, and the next row it takes in is filtered
   * with the new ones. The ack goes out at that point, in the same ordered stream as the deltas.
   */
  async #pump(connection: Connection): Promise<void> {
    if (connection.pumping) return;
    connection.pumping = true;
    try {
      while (connection.open && connection.state === 'live') {
        const request = connection.requests.shift();
        if (request === undefined) return;
        if (request.t === 'subscribe') {
          // Read fresh (SPEC-011 §5.7): an unknown team and a private team the user isn't in are
          // dropped alike (E32).
          const accepted = await this.#options.teamAccess(connection.info.userId, request.teams);
          // A resync or a close meanwhile: the connection follows nothing more.
          if (!connection.open || connection.state !== 'live') return;
          for (const team of accepted) connection.groups.add(teamGroup(team));
          this.#send(connection, {
            t: 'subscribed',
            teams: accepted,
            at: connection.writer.through,
          });
        } else {
          // A home group stays (a private team the user is in): its packets keep coming, so it
          // isn't acked as dropped.
          const dropped = [...new Set(request.teams)].filter(
            (team) => !connection.home.has(teamGroup(team)),
          );
          for (const team of dropped) connection.groups.delete(teamGroup(team));
          this.#send(connection, {
            t: 'unsubscribed',
            teams: dropped,
            at: connection.writer.through,
          });
        }
      }
    } catch (error) {
      this.#options.log.error({ err: loggableError(error) }, 'sync subscription failed');
      this.#close(connection, INTERNAL_ERROR, 'Subscription failed');
    } finally {
      connection.pumping = false;
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
