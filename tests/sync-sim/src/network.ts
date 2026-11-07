/**
 * The controllable network between the simulated tabs and the server
 * (PLAN-002 S9). Everything runs on the simulation's fake clock.
 *
 * - **HTTP** (`fetch`): a request takes a random delay to reach the server and
 *   its response another to come back. Either leg can be lost (`Failed to
 *   fetch`): a lost request never reached the server, a lost response did. A
 *   response can also hang (never arrive), so the client's request timeout
 *   fires. Once sent, a request travels on its own: an abort or a crash
 *   rejects on the client at once, but the request still reaches the server
 *   and runs, possibly after the client's resend (E3, E4). Concurrent
 *   requests overtake each other freely.
 * - **WebSocket**: each direction is a FIFO channel (TCP keeps order within a
 *   connection), but messages on one connection and HTTP responses race, so
 *   an `ack` can beat or trail its mutate response. "Reorder" means exactly
 *   that: interleavings across channels, never within one.
 * - **Disconnect**: the connection drops, and what was in flight is lost. The
 *   client sees `1006` after a short delay; the server closes its side.
 * - **Offline**: requests fail and connections cannot open until the tab is
 *   online again, which fires its `online` event.
 * - **Server down** (a restart): connections close with `1012`, requests fail,
 *   and responses to requests the old process ran are lost.
 */
import type {
  FetchLike,
  OnlineSource,
  SocketConnection,
  SocketFactory,
  SocketHandlers,
} from '@surface/sync-client';
import type { Random } from './random.js';
import { between } from './random.js';
import type { SimServer } from './server.js';

export interface Faults {
  /** Chance that a request is lost before it reaches the server. */
  readonly dropRequest: number;
  /** Chance that a response is lost on the way back. */
  readonly dropResponse: number;
  /** Chance that a response never arrives at all (the client times out). */
  readonly hangResponse: number;
  /** Upper bound of each one-way delay, in ms (the lower bound is 1). */
  readonly maxDelayMs: number;
}

/** No losses, short delays: the network once faults stop. */
export const CALM: Faults = { dropRequest: 0, dropResponse: 0, hangResponse: 0, maxDelayMs: 20 };

/** How long a tab takes to notice a dropped connection. */
const DROP_NOTICE_MS = 5;

export class Network {
  faults: Faults = CALM;
  readonly #links = new Set<Link>();
  #serverUp = true;
  /** Bumped by every restart: responses from an older process are lost. */
  #epoch = 0;
  #requests = 0;

  constructor(
    readonly server: SimServer,
    readonly random: Random,
  ) {}

  /** The network as seen by one tab. */
  link(): Link {
    const link = new Link(this);
    this.#links.add(link);
    return link;
  }

  get serverUp(): boolean {
    return this.#serverUp;
  }

  get epoch(): number {
    return this.#epoch;
  }

  /** The server process stops: its connections close with `1012`. */
  serverDown(): void {
    if (!this.#serverUp) return;
    this.#serverUp = false;
    this.#epoch += 1;
    this.server.restart();
  }

  serverUpAgain(): void {
    this.#serverUp = true;
  }

  /** Faults stop, the server is up and every tab is online. */
  heal(): void {
    this.faults = CALM;
    this.serverUpAgain();
    for (const link of this.#links) link.setOnline(true);
  }

  /** A one-way delay. */
  delay(): number {
    return between(this.random, 1, Math.max(1, this.faults.maxDelayMs));
  }

  /** Whether a leg is lost, with chance `p`. */
  lost(p: number): boolean {
    return p > 0 && this.random() < p;
  }

  /**
   * Requests sent and not yet handled by the server, whoever sent them: a
   * request a crashed or impatient tab gave up on still counts until it
   * arrives (or is lost on the way). Responses are not counted: one that
   * hangs never arrives, and the server already ran its request.
   */
  get requestsInFlight(): number {
    return this.#requests;
  }

  /** A request left a tab. */
  requestSent(): void {
    this.#requests += 1;
  }

  /** The request was lost, or the server finished handling it. */
  requestDone(): void {
    this.#requests -= 1;
  }

  forget(link: Link): void {
    this.#links.delete(link);
  }
}

/** One tab's view of the network. */
export class Link {
  #online = true;
  #dead = false;
  readonly #sockets = new Set<LinkSocket>();
  readonly #listeners = new Set<() => void>();

  constructor(readonly network: Network) {}

  get dead(): boolean {
    return this.#dead;
  }

  /** What the store gets as `onlineSource`: the browser's `online` event. */
  readonly onlineSource: OnlineSource = {
    subscribe: (listener) => {
      this.#listeners.add(listener);
      return () => this.#listeners.delete(listener);
    },
  };

  setOnline(online: boolean): void {
    if (this.#dead || online === this.#online) return;
    this.#online = online;
    if (!online) {
      for (const socket of this.#sockets) socket.drop();
      return;
    }
    // Browsers fire `online` as a task, not synchronously.
    setTimeout(() => {
      if (this.#dead) return;
      for (const listener of this.#listeners) listener();
    }, 0);
  }

  /** Drop every connection of this tab (the network blipped). */
  disconnect(): void {
    for (const socket of this.#sockets) socket.drop();
  }

  /** The tab crashed: nothing reaches it any more, and the server sees its sockets close. */
  kill(): void {
    this.#dead = true;
    for (const socket of this.#sockets) socket.drop();
    this.#listeners.clear();
    this.network.forget(this);
  }

  /** Whether a message to or from this tab can travel now. */
  reachable(): boolean {
    return !this.#dead && this.#online && this.network.serverUp;
  }

  readonly fetch: FetchLike = (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const network = this.network;
      let settled = false;
      const settle = (outcome: () => void) => {
        if (settled || this.#dead) return;
        settled = true;
        outcome();
      };
      const failed = () => settle(() => reject(new TypeError('Failed to fetch')));
      const signal = init.signal;
      if (signal?.aborted) {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }
      signal?.addEventListener('abort', () =>
        settle(() => reject(new DOMException('The operation was aborted.', 'AbortError'))),
      );
      // Nothing leaves an offline or dead tab.
      const sent = !this.#dead && this.#online;
      if (sent) network.requestSent();
      setTimeout(() => {
        // From here the request is on the wire: giving up on it (abort, crash)
        // does not stop it reaching the server.
        if (!sent || !network.serverUp || network.lost(network.faults.dropRequest)) {
          if (sent) network.requestDone();
          failed();
          return;
        }
        const epoch = network.epoch;
        const back = (outcome: () => void) => {
          if (network.lost(network.faults.hangResponse)) return;
          setTimeout(() => {
            const lost =
              !this.reachable() ||
              network.epoch !== epoch ||
              network.lost(network.faults.dropResponse);
            if (lost) failed();
            else settle(outcome);
          }, network.delay());
        };
        // A server that throws is a failed request, as over HTTP.
        Promise.resolve()
          .then(() => network.server.fetch(url, init))
          .finally(() => network.requestDone())
          .then(
            (response) => back(() => resolve(response)),
            (error: unknown) =>
              back(() => reject(error instanceof Error ? error : new Error(String(error)))),
          );
      }, network.delay());
    });

  readonly socket: SocketFactory = (url, handlers) => {
    const socket = new LinkSocket(this, url, handlers);
    this.#sockets.add(socket);
    socket.connect(() => this.#sockets.delete(socket));
    return socket.client;
  };
}

/** One direction of a connection: in order, each message after its own delay. */
class Channel {
  #last = 0;
  readonly #pending = new Set<ReturnType<typeof setTimeout>>();

  constructor(readonly network: Network) {}

  send(deliver: () => void): void {
    const at = Math.max(Date.now() + this.network.delay(), this.#last);
    this.#last = at;
    const handle = setTimeout(() => {
      this.#pending.delete(handle);
      deliver();
    }, at - Date.now());
    this.#pending.add(handle);
  }

  /** Lose everything still on its way. */
  clear(): void {
    for (const handle of this.#pending) clearTimeout(handle);
    this.#pending.clear();
  }
}

class LinkSocket {
  readonly #toServer: Channel;
  readonly #toClient: Channel;
  #server: SocketConnection | undefined;
  /** The client closed it, or it dropped: nothing more is delivered. */
  #closed = false;
  #onEnd: () => void = () => undefined;

  readonly client: SocketConnection = {
    send: (data) => {
      if (this.#closed) return;
      this.#toServer.send(() => this.#server?.send(data));
    },
    close: (code, reason) => {
      if (this.#closed) return;
      this.#closed = true;
      this.#toClient.clear();
      this.#toServer.send(() => this.#server?.close(code, reason));
      this.#end();
    },
  };

  constructor(
    readonly link: Link,
    readonly url: string,
    readonly handlers: SocketHandlers,
  ) {
    this.#toServer = new Channel(link.network);
    this.#toClient = new Channel(link.network);
  }

  connect(onEnd: () => void): void {
    this.#onEnd = onEnd;
    this.#toServer.send(() => {
      if (this.#closed) return;
      if (!this.link.reachable()) {
        this.drop();
        return;
      }
      this.#server = this.link.network.server.socket(this.url, {
        onOpen: () => this.#toClient.send(() => this.#deliver(() => this.handlers.onOpen())),
        onMessage: (data) =>
          this.#toClient.send(() => this.#deliver(() => this.handlers.onMessage(data))),
        onClose: (code) =>
          this.#toClient.send(() => {
            if (this.#closed) return;
            this.#closed = true;
            this.#end();
            if (!this.link.dead) this.handlers.onClose(code);
          }),
      });
    });
  }

  /** The connection is gone: in-flight messages are lost; each side learns of it. */
  drop(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#toServer.clear();
    this.#toClient.clear();
    this.#server?.close(1006, 'network');
    this.#end();
    if (this.link.dead) return;
    setTimeout(() => {
      if (!this.link.dead) this.handlers.onClose(1006);
    }, DROP_NOTICE_MS);
  }

  /** Events after the client closed it, or after a crash, never arrive. */
  #deliver(event: () => void): void {
    if (!this.link.dead && !this.#closed) event();
  }

  #end(): void {
    this.#onEnd();
  }
}
