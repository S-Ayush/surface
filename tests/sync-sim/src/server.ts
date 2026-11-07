/**
 * The server side of the simulation. `FakeHubServer` adapts sync-client's
 * in-process fake hub; once PLAN-002 S5 is on `main`, a second adapter runs
 * the real server (executor, Postgres) behind the same interface (ADR-0016).
 */
import { DebugItem } from '@surface/domain/model';
import type { FetchLike, SocketFactory } from '@surface/sync-client';
import { FakeHub } from '@surface/sync-client/testing';
import { CloseCode, computeSchemaHash } from '@surface/sync-protocol';

/** What a client should end up showing for one item. */
export interface ItemState {
  readonly title: unknown;
  readonly counter: unknown;
  readonly groups: unknown;
  readonly archived: boolean;
}

export interface SimServer {
  /** `GET /sync/bootstrap` and `POST /sync/mutate`, reached through the network. */
  readonly fetch: FetchLike;
  /** `GET /sync/ws`, reached through the network. */
  readonly socket: SocketFactory;
  /** A process restart: every live connection closes with `1012`; the database stays. */
  restart(): void;
  /** The last sync id committed. */
  head(): number;
  /** The database's debug items, by id. */
  items(): Record<string, ItemState>;
  /**
   * Fixtures for a case, written the way the server writes any row: the real
   * server's adapter runs `debug.create` through the executor, so `sync_log`
   * and groups come from the repo layer (CLAUDE.md rule 2).
   */
  seed(items: readonly { id: string; title: string }[]): void;
  /**
   * Retention drops the log up to the head: a client behind it gets
   * `resync(too_old)` when it next connects (SPEC-002 E8).
   */
  compactLog(): void;
  dispose(): void;
}

/** The hub's ping interval (sync-protocol §4.2; PLAN-002 S4: every 25 s). */
export const PING_INTERVAL_MS = 25_000;

export class FakeHubServer implements SimServer {
  readonly #hub = new FakeHub(0);
  readonly #ping: ReturnType<typeof setInterval>;

  constructor() {
    this.#hub.schemaHash = computeSchemaHash([DebugItem]);
    // A live connection hears from the server at least every 25 s, so the
    // client's silence watchdog only fires on a dead connection.
    this.#ping = setInterval(() => {
      for (const connection of this.#hub.live) connection.send({ t: 'ping' });
    }, PING_INTERVAL_MS);
  }

  readonly fetch: FetchLike = (url, init) => this.#hub.fetch(url, init);
  readonly socket: SocketFactory = (url, handlers) => this.#hub.socket(url, handlers);

  restart(): void {
    for (const connection of this.#hub.live) connection.close(CloseCode.ServiceRestart);
  }

  head(): number {
    return this.#hub.head;
  }

  items(): Record<string, ItemState> {
    const entries = [...this.#hub.rows.values()].map(({ row, archived }): [string, ItemState] => [
      row.id,
      { title: row['title'], counter: row['counter'], groups: row['groups'], archived },
    ]);
    return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
  }

  seed(items: readonly { id: string; title: string }[]): void {
    for (const item of items) {
      const row = { id: item.id, title: item.title, counter: 0, groups: ['workspace'] };
      this.#hub.rows.set(item.id, { row, archived: false });
      this.#hub.head += 1;
      this.#hub.log.push({ id: this.#hub.head, a: 'I', m: 'DebugItem', d: { ...row } });
    }
  }

  compactLog(): void {
    this.#hub.retainedFrom = this.#hub.head;
  }

  dispose(): void {
    clearInterval(this.#ping);
  }
}
