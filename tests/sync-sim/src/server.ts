/**
 * The server side of the simulation. `FakeHubServer` adapts sync-client's
 * in-process fake hub; `RealServer` (`real-server.ts`) runs the real server
 * (executor, repo, hub, Postgres) behind the same interface (ADR-0016).
 */
import type { ModelDef } from '@surface/domain/model';
import { DebugItem } from '@surface/domain/model';
import type { SocketConnection, SocketHandlers } from '@surface/sync-client';
import { FakeHub } from '@surface/sync-client/testing';
import { CloseCode, computeSchemaHash } from '@surface/sync-protocol';

/** What a client should end up showing for one item. */
export interface ItemState {
  readonly title: unknown;
  readonly counter: unknown;
  readonly groups: unknown;
  /** The ISO instant it was archived, or null (protocol v0.7, SPEC-011 §5.5). */
  readonly archivedAt: unknown;
  readonly archived: boolean;
}

export interface SimServer {
  /** The users it knows, by id. Each tab is signed in as one of them. */
  readonly users: readonly string[];
  /** What went wrong on the server's side that fails the case. */
  readonly problems: readonly string[];
  /** The models it syncs: each tab's store holds the same set, so the schema hashes match. */
  readonly models: readonly ModelDef[];
  /** `GET /sync/bootstrap` and `POST /sync/mutate` as `user`, reached through the network. */
  fetch(user: string, url: string, init: RequestInit): Promise<Response>;
  /** `GET /sync/ws` as `user`, reached through the network. */
  socket(user: string, url: string, handlers: SocketHandlers): SocketConnection;
  /**
   * A process restart: every live connection closes with `1012`; the
   * database stays. The real server's restart holds the clock until it is
   * back (`clock.ts`); the network keeps it unreachable for the step's time.
   */
  restart(): void;
  /** The last sync id committed. */
  head(): Promise<number>;
  /** The database's debug items, by id. */
  items(): Promise<Record<string, ItemState>>;
  /**
   * Fixtures for a case, written the way the server writes any row: the real
   * server's adapter runs `debug.create` through the executor, so `sync_log`
   * and groups come from the repo layer (CLAUDE.md rule 2).
   */
  seed(items: readonly { id: string; title: string }[]): Promise<void>;
  /**
   * Retention drops the log up to the head: a client behind it gets
   * `resync(too_old)` when it next connects (SPEC-002 E8). Held like `restart`.
   */
  compactLog(): void;
  dispose(): Promise<void>;
}

/** The hub's ping interval (sync-protocol §4.2; PLAN-002 S4: every 25 s). */
export const PING_INTERVAL_MS = 25_000;

export class FakeHubServer implements SimServer {
  readonly users: readonly string[];
  readonly problems: readonly string[] = [];
  readonly models: readonly ModelDef[] = [DebugItem];
  readonly #hub = new FakeHub(0);
  readonly #ping: ReturnType<typeof setInterval>;

  /** The fake hub signs nobody in: every user is anybody. */
  constructor(users: number) {
    // UUIDs, as on the wire: the client names its user on every request (SPEC-002 E14).
    this.users = Array.from(
      { length: users },
      (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
    );
    this.#hub.schemaHash = computeSchemaHash(this.models);
    // A live connection hears from the server at least every 25 s, so the
    // client's silence watchdog only fires on a dead connection.
    this.#ping = setInterval(() => {
      for (const connection of this.#hub.live) connection.send({ t: 'ping' });
    }, PING_INTERVAL_MS);
  }

  fetch(_user: string, url: string, init: RequestInit): Promise<Response> {
    return this.#hub.fetch(url, init);
  }

  socket(_user: string, url: string, handlers: SocketHandlers): SocketConnection {
    return this.#hub.socket(url, handlers);
  }

  restart(): void {
    for (const connection of this.#hub.live) connection.close(CloseCode.ServiceRestart);
  }

  head(): Promise<number> {
    return Promise.resolve(this.#hub.head);
  }

  items(): Promise<Record<string, ItemState>> {
    const entries = [...this.#hub.rows.values()].map(({ row, archived }): [string, ItemState] => [
      row.id,
      {
        title: row['title'],
        counter: row['counter'],
        groups: row['groups'],
        archivedAt: row['archivedAt'],
        archived,
      },
    ]);
    return Promise.resolve(Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b))));
  }

  seed(items: readonly { id: string; title: string }[]): Promise<void> {
    for (const item of items) {
      const row = {
        id: item.id,
        title: item.title,
        counter: 0,
        groups: ['workspace'],
        archivedAt: null,
      };
      this.#hub.rows.set(item.id, { row, archived: false });
      this.#hub.head += 1;
      this.#hub.log.push({ id: this.#hub.head, a: 'I', m: 'DebugItem', d: { ...row } });
    }
    return Promise.resolve();
  }

  compactLog(): void {
    this.#hub.retainedFrom = this.#hub.head;
  }

  dispose(): Promise<void> {
    clearInterval(this.#ping);
    return Promise.resolve();
  }
}
