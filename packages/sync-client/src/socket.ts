/**
 * The live connection to `GET /sync/ws` (SPEC-002 §3.6, sync-protocol.md §4.3).
 *
 * - Connects with the current `since`, answers `ping` with `pong`, and treats
 *   35 s of silence (ping interval + timeout) as a dead connection.
 * - Reconnects with backoff from 0.5 s to 30 s with jitter, and at once on the
 *   browser's `online` event. The backoff resets only after a healthy message,
 *   so a server that accepts and then drops connections is not hammered.
 * - Close code `4001` (session revoked) stops reconnecting (E10).
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
}

const globalTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    if (handle !== undefined) clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export class SyncSocket {
  readonly #options: SyncSocketOptions;
  readonly #timers: Timers;
  readonly #random: () => number;
  readonly #state: IObservableValue<ConnectionState> = observable.box('disconnected');
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
  }

  /** Observable. */
  get state(): ConnectionState {
    return this.#state.get();
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
    this.#setState('connecting');
    this.#armWatchdog(token);
    try {
      const connection = this.#options.factory(this.#options.url(), {
        onOpen: () => {
          if (token !== this.#token) return;
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
    if (this.#running) this.#scheduleRetry();
    else this.#setState('disconnected');
  }

  #fail(reason: string): void {
    this.#drop(reason);
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
    if (!this.#running || this.state !== 'offline') return;
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

  #setState(state: ConnectionState): void {
    runInAction(() => this.#state.set(state));
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
