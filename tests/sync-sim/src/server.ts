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
  /**
   * The last sync id `userId`'s connections can receive: `head()` but for rows only other users'
   * `user:` groups hold (their drafts, PLAN-012 S5), which never reach this user.
   */
  headFor(userId: string): Promise<number>;
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

/**
 * What a client should end up showing for one issue (PLAN-011 S4): every field an issue
 * operation writes, and the server-computed number and sort key.
 */
export interface IssueState {
  readonly teamId: unknown;
  readonly number: unknown;
  readonly title: unknown;
  readonly statusId: unknown;
  readonly priority: unknown;
  readonly labelIds: unknown;
  readonly sortOrder: unknown;
  readonly groups: unknown;
}

/** The rows the issue steps name (`steps.ts`), made by `IssueServer.seedIssueFixtures`. */
export interface IssueFixtures {
  /** Label ids by the reference the steps use (`Bug`, `Size/Small`, …). */
  readonly labels: Readonly<Record<string, string>>;
  /** A status of another team (OPS), which an issue of the steps' team may not take. */
  readonly otherTeamStatusId: string;
}

/** A server the issue steps run against: only the real one syncs issues. */
export interface IssueServer extends SimServer {
  /** Set once `seedIssueFixtures` has run. */
  readonly issueFixtures: IssueFixtures | undefined;
  /** Labels and a second team, written through the executor. */
  seedIssueFixtures(): Promise<IssueFixtures>;
  /** The database's issues, by id. */
  issues(): Promise<Record<string, IssueState>>;
  /** The database's issues with their commit order, for the numbering checks. */
  issueRows(): Promise<readonly IssueRecord[]>;
  /** The database's drafts, by id (PLAN-012 S5). */
  drafts(): Promise<Record<string, StoredDraft>>;
}

/** What a client should show for one draft (PLAN-012 S5): its owner's replica only. */
export interface DraftState {
  readonly userId: unknown;
  readonly kind: unknown;
  readonly teamId: unknown;
  readonly issueId: unknown;
  readonly data: unknown;
}

/** A stored draft: what its owner shows, and the sync groups only the server holds. */
export interface StoredDraft extends DraftState {
  readonly groups: readonly string[];
}

/** One stored issue, with the `sync_id` of its insert (its commit order). */
export interface IssueRecord {
  readonly id: string;
  readonly teamId: string;
  readonly number: number;
  readonly labelIds: readonly string[];
  readonly sortOrder: string;
  readonly insertedAt: number | null;
}

export function isIssueServer(server: SimServer): server is IssueServer {
  return 'issueRows' in server && 'seedIssueFixtures' in server;
}

/**
 * What a client should end up showing for one comment (PLAN-013 S3): every field a comment
 * operation writes. Timestamps are ISO strings, as on the wire.
 */
export interface CommentState {
  readonly issueId: unknown;
  readonly teamId: unknown;
  readonly parentCommentId: unknown;
  readonly userId: unknown;
  readonly actorKind: unknown;
  readonly body: unknown;
  readonly version: unknown;
  readonly editedAt: unknown;
  readonly deletedAt: unknown;
  readonly resolvedAt: unknown;
  readonly resolvedById: unknown;
}

/**
 * What a client should end up showing for one reaction (PLAN-013 S4): every field `reaction.set`
 * writes. `createdAt` is an ISO string, as on the wire.
 */
export interface ReactionState {
  readonly issueId: unknown;
  readonly teamId: unknown;
  readonly commentId: unknown;
  readonly userId: unknown;
  readonly emoji: unknown;
  readonly createdAt: unknown;
}

/** A server the comment steps run against: the real one, with issues. */
export interface CommentServer extends IssueServer {
  /** The database's comments, by id. */
  comments(): Promise<Record<string, CommentState>>;
  /** How many reactions are stored. */
  reactionCount(): Promise<number>;
  /** The database's reactions, by id (PLAN-013 S4). */
  reactions(): Promise<Record<string, ReactionState>>;
}

export function isCommentServer(server: SimServer): server is CommentServer {
  return isIssueServer(server) && 'comments' in server;
}

/** The stored workflow (PLAN-010 S5): teams' defaults, statuses and labels. */
export interface WorkflowState {
  readonly teams: readonly { id: string; key: string; defaultStatusId: string }[];
  readonly statuses: readonly { id: string; teamId: string; name: string; category: string }[];
  readonly labels: readonly { id: string; teamId: string | null; name: string }[];
}

/** A server the workflow steps run against (SPEC-010 AC-19): only the real one has issues. */
export interface WorkflowServer extends IssueServer {
  workflow(): Promise<WorkflowState>;
}

export function isWorkflowServer(server: SimServer): server is WorkflowServer {
  return isIssueServer(server) && 'workflow' in server;
}

/** An issue's lifecycle as stored (PLAN-015 S2): ISO strings or null. */
export interface IssueLifecycleState {
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
}

/** A server the lifecycle steps run against (PLAN-015 S2): the real one, with comments. */
export interface LifecycleServer extends CommentServer {
  /** Every stored issue's lifecycle, by id. A purged issue has no row, so no entry. */
  issueLifecycles(): Promise<Record<string, IssueLifecycleState>>;
  /**
   * Closes a live issue and runs `issue.autoArchive` on it as the system actor, like the job
   * (PLAN-015 S3; `TestServer.autoArchive`). Queued behind the other server calls, so a later
   * read sees it. Does nothing for an issue that is not live.
   */
  autoArchive(issueId: string): void;
  /** The issues `autoArchive` really archived, read after the calls queued so far. */
  autoArchivedIds(): Promise<string[]>;
}

export function isLifecycleServer(server: SimServer): server is LifecycleServer {
  return isCommentServer(server) && 'issueLifecycles' in server;
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

  /** The fake hub's rows reach everyone. */
  headFor(_userId: string): Promise<number> {
    return this.head();
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
