/**
 * The live connection to `GET /sync/ws` (SPEC-002 §3.6, sync-protocol.md §4.3).
 *
 * - Connects with the current `since`, answers `ping` with `pong`, and treats
 *   35 s of silence (ping interval + timeout) as a dead connection.
 * - Reconnects with backoff from 0.5 s to 30 s with jitter, and at once on the
 *   browser's `online` event. The backoff resets only after a healthy message,
 *   so a server that accepts and then drops connections is not hammered.
 * - Close code `4001` (session revoked) stops reconnecting (E10).
 * - Counts connection attempts in a row that never opened. A browser cannot
 *   tell a proxy that refuses the upgrade from a server that is down, so
 *   after the third it asks the server over plain HTTP (`probe`). When the
 *   server answers, it dials at once, and if that attempt fails too, live
 *   updates are unavailable (SPEC-005 §8, sync-protocol.md §4.3). A restart
 *   never trips it: the server does not answer, or the next attempt opens.
 * - What a message means for the replica is the store's call (`onMessage`
 *   returns a verdict): carry on, reconnect (gap, bad data), or pause (the
 *   store is re-bootstrapping or outdated and calls `start()` again later).
 *
 * Transport, timers, randomness and the online event are injected, so tests
 * drive all of it without real sleeps.
 */
import type { DeltasMessage, ResyncMessage, ServerMessage } from '@surface/sync-protocol';
import {
  CloseCode,
  PING_INTERVAL_MS,
  PING_TIMEOUT_MS,
  decodeServerMessage,
  encodeSocketMessage,
} from '@surface/sync-protocol';
import type { IObservableValue } from 'mobx';
import { observable, runInAction } from 'mobx';

/**
 * `connecting` while dialling, `online` once open, `offline` while waiting to
 * retry, `revoked` after close code 4001, `disconnected` when stopped.
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'online' | 'offline' | 'revoked';

/** What the store made of a message. */
export type Verdict = 'ok' | 'reconnect' | 'pause';

export interface SocketHandlers {
  onOpen(): void;
  onMessage(data: unknown): void;
  onClose(code: number): void;
}

export interface SocketConnection {
  send(data: string): void;
  close(code: number, reason: string): void;
}

/** Open a connection to `url`. May throw (e.g. a URL the browser refuses). */
export type SocketFactory = (url: string, handlers: SocketHandlers) => SocketConnection;

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Tells the socket the network may be back (the browser's `online` event). */
export interface OnlineSource {
  subscribe(listener: () => void): () => void;
}

export const BACKOFF_MIN_MS = 500;
export const BACKOFF_MAX_MS = 30_000;
/** No message for this long means the connection is dead. */
export const SILENCE_LIMIT_MS = PING_INTERVAL_MS + PING_TIMEOUT_MS;
/** Attempts in a row that never opened before live updates count as unavailable (SPEC-005 §8). */
export const FAILED_CONNECTS_LIMIT = 3;

/**
 * Delay before reconnect attempt `attempt` (0-based): a ceiling doubling from
 * 1 s to 30 s, and a delay drawn from its upper half, so 0.5–1 s first and
 * 15–30 s at most. `random` is in [0, 1).
 */
export function backoffDelay(attempt: number, random: number): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, 2 * BACKOFF_MIN_MS * 2 ** attempt);
  return ceiling / 2 + (random * ceiling) / 2;
}

export interface SyncSocketOptions {
  /** Built at each dial, so it carries the `since` of that moment. */
  readonly url: () => string;
  readonly factory: SocketFactory;
  readonly onMessage: (message: DeltasMessage | ResyncMessage) => Verdict;
  readonly onRevoked: () => void;
  /** The connection is open, so the server is reachable again. */
  readonly onOpen?: () => void;
  readonly timers?: Timers;
  readonly random?: () => number;
  readonly online?: OnlineSource;
  /** Epoch ms, for `since`; defaults to `Date.now`. */
  readonly clock?: () => number;
  /**
   * Whether the server answers plain HTTP, asked after repeated failed
   * attempts. Without it, live updates never count as unavailable.
   */
  readonly probe?: () => Promise<boolean>;
}

export const globalTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    if (handle !== undefined) clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export class SyncSocket {
  readonly #options: SyncSocketOptions;
  readonly #timers: Timers;
  readonly #random: () => number;
  readonly #clock: () => number;
  readonly #state: IObservableValue<ConnectionState> = observable.box('disconnected');
  readonly #since: IObservableValue<number>;
  readonly #reconnectingSince = observable.box<number | undefined>(undefined);
  readonly #failedConnects = observable.box(0);
  readonly #unavailable = observable.box(false);
  /** Whether the server answered plain HTTP during the current run of failures. */
  #answered: 'unknown' | 'asking' | 'yes' = 'unknown';
  /** Identifies the current run of failures; answers about an older one are ignored. */
  #run = 0;
  /**
   * The current attempt has not opened yet. A dropped attempt never reports
   * (its token is stale), so only `#closed` and `#fail` read this.
   */
  #opening = false;
  #connection: SocketConnection | undefined;
  /** Identifies the current connection; events of older ones are ignored. */
  #token = 0;
  #attempt = 0;
  #running = false;
  #retry: unknown;
  #watchdog: unknown;
  #unsubscribe: (() => void) | undefined;

  constructor(options: SyncSocketOptions) {
    this.#options = options;
    this.#timers = options.timers ?? globalTimers;
    this.#random = options.random ?? Math.random;
    this.#clock = options.clock ?? Date.now;
    this.#since = observable.box(this.#clock());
  }

  /** Observable. */
  get state(): ConnectionState {
    return this.#state.get();
  }

  /** Epoch ms when `state` last changed (for "Reconnecting > 5 s", SPEC-005 §8). Observable. */
  get since(): number {
    return this.#since.get();
  }

  /**
   * Epoch ms since the socket has been trying to get back online: since it
   * last was, or since `start()`. Retries do not reset it. `undefined` while
   * online, stopped or revoked ("Reconnecting > 5 s", SPEC-005 §8). Observable.
   */
  get reconnectingSince(): number | undefined {
    return this.#reconnectingSince.get();
  }

  /**
   * Connection attempts in a row that closed or went silent before opening.
   * Reset when one opens, on `stop()`, and by the browser's `online` event. Observable.
   */
  get failedConnects(): number {
    return this.#failedConnects.get();
  }

  /**
   * The server answers plain HTTP, but attempts still fail before opening:
   * something between refuses WebSocket upgrades (SPEC-005 §8). Observable.
   */
  get liveUpdatesUnavailable(): boolean {
    return this.#unavailable.get();
  }

  /** Connect now, and keep reconnecting until `stop()` or a revoked session. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#attempt = 0;
    this.#unsubscribe ??= this.#options.online?.subscribe(() => this.#online());
    this.#dial();
  }

  /** Close the connection and stop reconnecting until `start()`. */
  stop(): void {
    this.#running = false;
    this.#halt();
    this.#startOver();
    if (this.state !== 'revoked') this.#setState('disconnected');
  }

  /** Drop the current connection (if any) and reconnect after the backoff. */
  retryLater(): void {
    // A revoked session stays down until the user logs in again (E10).
    if (this.state === 'revoked') return;
    this.#running = true;
    this.#unsubscribe ??= this.#options.online?.subscribe(() => this.#online());
    this.#drop('retry');
    this.#scheduleRetry();
  }

  #dial(): void {
    this.#timers.clearTimeout(this.#retry);
    this.#retry = undefined;
    const token = (this.#token += 1);
    this.#opening = true;
    this.#setState('connecting');
    this.#armWatchdog(token);
    try {
      const connection = this.#options.factory(this.#options.url(), {
        onOpen: () => {
          if (token !== this.#token) return;
          this.#opening = false;
          this.#startOver();
          this.#setState('online');
          this.#options.onOpen?.();
        },
        onMessage: (data) => {
          if (token === this.#token) this.#receive(data);
        },
        onClose: (code) => {
          if (token === this.#token) this.#closed(code);
        },
      });
      // A handler may have stopped or replaced it while it was being made.
      if (token === this.#token) this.#connection = connection;
      else connection.close(1000, 'superseded');
    } catch {
      this.#connection = undefined;
      this.#closed(1006);
    }
  }

  #receive(data: unknown): void {
    this.#armWatchdog(this.#token);
    let message: ServerMessage;
    try {
      if (typeof data !== 'string') throw new TypeError('binary frame');
      message = decodeServerMessage(data);
    } catch {
      this.#fail('invalid message');
      return;
    }
    if (message.t === 'ping') {
      this.#connection?.send(encodeSocketMessage({ t: 'pong' }));
      this.#attempt = 0;
      return;
    }
    // v0.8 subscription acks (SPEC-011 §5.7). This client names no `teams`, so its connection
    // follows the user's member teams and the server sends none; PLAN-011 S4c handles them.
    if (message.t === 'subscribed' || message.t === 'unsubscribed') return;
    const token = this.#token;
    const verdict = this.#options.onMessage(message);
    // The store may have stopped or restarted the socket while handling it.
    if (token !== this.#token) return;
    if (verdict === 'ok') this.#attempt = 0;
    else if (verdict === 'reconnect') this.#fail('reconnect');
    else this.stop();
  }

  #closed(code: number): void {
    this.#connection = undefined;
    const neverOpened = this.#opening;
    this.#opening = false;
    this.#timers.clearTimeout(this.#watchdog);
    this.#watchdog = undefined;
    this.#token += 1;
    // Also on a connection that never opened: the hub accepts the upgrade and
    // then closes with 4001 when the session is gone (sync-protocol.md §4.3).
    if (code === CloseCode.SessionRevoked) {
      this.#running = false;
      this.#halt();
      this.#setState('revoked');
      this.#options.onRevoked();
      return;
    }
    if (neverOpened) this.#countFailedConnect();
    if (this.#running) this.#scheduleRetry();
    else this.#setState('disconnected');
  }

  #fail(reason: string): void {
    // Only the silence watchdog fires before an attempt opens: an upgrade that hangs.
    const neverOpened = this.#opening;
    this.#drop(reason);
    if (neverOpened) this.#countFailedConnect();
    if (this.#running) this.#scheduleRetry();
  }

  #scheduleRetry(): void {
    this.#timers.clearTimeout(this.#retry);
    this.#setState('offline');
    const delay = backoffDelay(this.#attempt, this.#random());
    this.#attempt += 1;
    this.#retry = this.#timers.setTimeout(() => {
      this.#retry = undefined;
      if (this.#running) this.#dial();
    }, delay);
  }

  #online(): void {
    if (!this.#running) return;
    // The network was down, so earlier failures say nothing about the proxy.
    this.#startOver();
    if (this.state !== 'offline') return;
    this.#attempt = 0;
    this.#dial();
  }

  /** Close the current connection, ignoring anything it still reports. */
  #drop(reason: string): void {
    this.#token += 1;
    this.#timers.clearTimeout(this.#watchdog);
    this.#watchdog = undefined;
    const connection = this.#connection;
    this.#connection = undefined;
    connection?.close(1000, reason);
  }

  /** Stop everything: connection, timers, online listener. */
  #halt(): void {
    this.#drop('stop');
    this.#timers.clearTimeout(this.#retry);
    this.#retry = undefined;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  #armWatchdog(token: number): void {
    this.#timers.clearTimeout(this.#watchdog);
    this.#watchdog = this.#timers.setTimeout(() => {
      if (token === this.#token) this.#fail('silent');
    }, SILENCE_LIMIT_MS);
  }

  #countFailedConnect(): void {
    const failed = this.#failedConnects.get() + 1;
    runInAction(() => {
      this.#failedConnects.set(failed);
      if (this.#answered === 'yes') this.#unavailable.set(true);
    });
    if (failed >= FAILED_CONNECTS_LIMIT && this.#answered === 'unknown') this.#ask();
  }

  /** Does the server answer plain HTTP? Then the upgrade is what fails: try it once more now. */
  #ask(): void {
    const probe = this.#options.probe;
    if (probe === undefined) return;
    const run = this.#run;
    this.#answered = 'asking';
    const answered = (yes: boolean) => {
      if (run !== this.#run) return;
      this.#answered = yes ? 'yes' : 'unknown';
      if (yes && this.#running && this.state === 'offline') this.#dial();
    };
    probe().then(answered, () => answered(false));
  }

  /** A new run of failures: an attempt opened, the network came back, or the socket stopped. */
  #startOver(): void {
    this.#run += 1;
    this.#answered = 'unknown';
    runInAction(() => {
      this.#failedConnects.set(0);
      this.#unavailable.set(false);
    });
  }

  #setState(state: ConnectionState): void {
    if (state === this.#state.get()) return;
    const now = this.#clock();
    runInAction(() => {
      this.#state.set(state);
      this.#since.set(now);
      const trying = state === 'connecting' || state === 'offline';
      if (!trying) this.#reconnectingSince.set(undefined);
      else if (this.#reconnectingSince.get() === undefined) this.#reconnectingSince.set(now);
    });
  }
}

/** The browser WebSocket. Non-text frames are passed on and rejected as invalid. */
export const webSocketFactory: SocketFactory = (url, handlers) => {
  const socket = new WebSocket(url);
  socket.addEventListener('open', () => handlers.onOpen());
  socket.addEventListener('message', (event: MessageEvent) => handlers.onMessage(event.data));
  socket.addEventListener('close', (event) => handlers.onClose(event.code));
  return {
    send: (data) => socket.send(data),
    close: (code, reason) => socket.close(code, reason),
  };
};

/** The window `online` event, where there is a window. */
export function windowOnline(): OnlineSource | undefined {
  if (typeof window === 'undefined') return undefined;
  return {
    subscribe(listener) {
      window.addEventListener('online', listener);
      return () => window.removeEventListener('online', listener);
    },
  };
}

/**
 * `ws(s)://…/sync/ws?query` for a server at `baseUrl` (`''` = this page's
 * origin). Throws when `baseUrl` is relative and there is no page origin.
 */
export function socketUrl(baseUrl: string, path: string, query: string): string {
  const origin = typeof location === 'undefined' ? undefined : location.origin;
  const url = new URL(`${baseUrl.replace(/\/$/, '')}${path}`, origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = query;
  return url.toString();
}
