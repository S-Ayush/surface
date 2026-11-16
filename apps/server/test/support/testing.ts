/**
 * `@surface/server/testing`: the real server for the sync simulation (PLAN-002 S9 part 2; the
 * session-d2 file's "Real-server test entry"). `tests/sync-sim` wraps it in its `SimServer`, so
 * the convergence and exactly-once properties also run against the executor, the repo layer,
 * `sync_log`, the hub and Postgres.
 *
 * - Starts the server through `startServer` on `127.0.0.1:0` with the engine fixtures synced
 *   (`syncFixtures`), completes first-run setup once, and signs in N users with real sessions
 *   and CSRF tokens (PLAN-001 S3), all members of the setup's team.
 * - `restart()` shuts the server down the way a signal does and starts a new one on the same
 *   database; sessions, rows and `client_mutations` survive, the port may change.
 * - Reads (`head`, `items`) go to the database directly.
 *
 * Config is built in code, never from `process.env` (CLAUDE.md rule 7). Only `tests/` and this
 * app's own tests import it (dependency-cruiser `server-testing-only-in-tests`), and it is not
 * part of the build (`tsconfig.build.json` includes `src` only).
 */
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { systemActor } from '@surface/domain';
import { registry } from '@surface/operations';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { pino, type Logger } from 'pino';
import { z } from 'zod';
import { csrfToken } from '../../src/auth/csrf.js';
import { SESSION_COOKIE } from '../../src/auth/session.js';
import { pgAuthStore } from '../../src/auth/store.js';
import { loadConfig, type Config } from '../../src/config.js';
import { createPool } from '../../src/db/pool.js';
import { createLogger } from '../../src/logger.js';
import { uuidv7 } from '../../src/db/uuidv7.js';
import { createExecutor, type Executor } from '../../src/executor/execute.js';
import { transactionRunner } from '../../src/executor/transaction.js';
import { HANDLERS } from '../../src/handlers/index.js';
import { startServer, type RunningServer } from '../../src/server.js';
import { gracefulShutdown } from '../../src/shutdown.js';
import { setupInputSchema } from '../../src/setup/input.js';
import { pgSetupStore } from '../../src/setup/store.js';
import { serverSyncRegistry } from '../../src/sync/registry.js';
import { pruneSyncLog, syncRepo } from '../../src/sync/repo.js';
import { CSRF_COOKIE, CSRF_HEADER } from '@surface/sync-protocol';

export {
  createDatabaseFrom,
  createTemplateDatabase,
  startTestPostgres,
  type TestDatabaseHandle,
  type TestPostgres,
} from './postgres.js';

export interface TestServerOptions {
  /**
   * A database on a running PostgreSQL that has not been set up yet: empty or migrated (startup
   * migrates it), such as `createTestDatabase()`. One that an earlier entry set up is refused.
   */
  readonly databaseUrl: string;
  /** Users to sign in (default 1). The first is the workspace's Admin. */
  readonly users?: number;
  /** Defaults to a silent logger; `errorLogger` reports the server's errors to a harness. */
  readonly logger?: Logger;
}

/** A signed-in user: send `cookie` with every request, and `csrfToken` with every POST. */
export interface TestUser {
  readonly id: string;
  readonly email: string;
  /** A `Cookie` header value carrying the session and CSRF cookies. */
  readonly cookie: string;
  /** For the `X-CSRF-Token` header (`CSRF_HEADER`). */
  readonly csrfToken: string;
}

/** A `debug_items` row as stored. A deleted item has no row. */
export interface DebugItemRow {
  readonly id: string;
  readonly title: string;
  readonly counter: number;
  readonly archived: boolean;
  /** ISO 8601 with milliseconds, as clients receive it (protocol v0.7), or null. */
  readonly archivedAt: string | null;
  readonly syncGroups: readonly string[];
}

/** An `issues` row as stored, the fields the issue properties compare (PLAN-011 S4). */
export interface IssueRow {
  readonly id: string;
  readonly teamId: string;
  readonly number: number;
  readonly title: string;
  readonly statusId: string;
  readonly priority: number;
  readonly labelIds: readonly string[];
  readonly sortOrder: string;
  readonly syncGroups: readonly string[];
  /** The `sync_id` of the issue's `I` row: commit order (null once retention pruned it). */
  readonly insertedAt: number | null;
}

/** A `drafts` row as stored (PLAN-012 S5): what the draft property compares. */
export interface DraftRow {
  readonly id: string;
  readonly userId: string;
  readonly kind: string;
  readonly teamId: string | null;
  readonly issueId: string | null;
  readonly data: unknown;
  readonly syncGroups: readonly string[];
}

/** A `comments` row as stored, the fields the comment property compares (PLAN-013 S3). */
export interface CommentRow {
  readonly id: string;
  readonly issueId: string;
  readonly teamId: string;
  readonly parentCommentId: string | null;
  readonly userId: string;
  readonly actorKind: string;
  readonly body: unknown;
  readonly version: number;
  readonly editedAt: string | null;
  readonly deletedAt: string | null;
  readonly resolvedAt: string | null;
  readonly resolvedById: string | null;
  readonly syncGroups: readonly string[];
}

/** A stored reaction (PLAN-013 S4), timestamps as ISO strings. */
export interface ReactionRow {
  readonly id: string;
  readonly issueId: string;
  readonly teamId: string;
  readonly commentId: string | null;
  readonly userId: string;
  readonly emoji: string;
  readonly createdAt: string;
  readonly syncGroups: readonly string[];
}

/** A stored `issue_content` row (PLAN-011 S6): the fields the description property compares. */
export interface IssueContentRow {
  readonly id: string;
  readonly issueId: string;
  readonly teamId: string;
  readonly description: unknown;
  readonly version: number;
  readonly syncGroups: readonly string[];
}

/** A stored `issue_history` row (PLAN-011 S6), without its timestamps. */
export interface IssueHistoryRow {
  readonly id: string;
  readonly issueId: string;
  readonly teamId: string;
  readonly actorKind: string;
  readonly actorId: string | null;
  readonly apiKeyId: string | null;
  readonly kind: string;
  readonly changes: unknown;
  readonly syncGroups: readonly string[];
}

/** The SPEC-003 response body of `POST /api/ops/:name`. */
export type OpResponse =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

export interface TestServer {
  /**
   * `http://127.0.0.1:<port>`. Changes at each restart. The socket refuses an `Origin` other than
   * `http://127.0.0.1` (`SURFACE_URL`, without the port), so clients send none, as Node's do.
   */
  readonly url: string;
  readonly users: readonly TestUser[];
  /** The hash of the models the server syncs, the engine fixtures included. */
  readonly schemaHash: string;
  /** Run an operation as `user` over HTTP: session, CSRF, executor and repo, like a client. */
  run(user: TestUser, name: string, input: unknown): Promise<OpResponse>;
  /** The last committed `sync_id` (0 when nothing is logged yet). */
  head(): Promise<number>;
  /**
   * The last committed `sync_id` that may reach `userId`'s connections: rows held only by other
   * users' `user:` groups (their drafts, PLAN-012 S5) are left out. 0 when none.
   */
  headFor(userId: string): Promise<number>;
  /** Every `debug_items` row, by id. */
  items(): Promise<DebugItemRow[]>;
  /** Every `issues` row, by id (PLAN-011 S4). */
  issues(): Promise<IssueRow[]>;
  /** Every `drafts` row, by id (PLAN-012 S5). */
  drafts(): Promise<DraftRow[]>;
  /** Every `comments` row, by id (PLAN-013 S3). */
  comments(): Promise<CommentRow[]>;
  /** How many `reactions` rows are stored (PLAN-013 S3: none until `reaction.set`, S4). */
  reactionCount(): Promise<number>;
  /** Every `reactions` row, by id (PLAN-013 S4). */
  reactions(): Promise<ReactionRow[]>;
  /** Every `issue_content` row, by id (PLAN-011 S6). */
  issueContents(): Promise<IssueContentRow[]>;
  /** Every `issue_history` row, by id (PLAN-011 S6). */
  issueHistories(): Promise<IssueHistoryRow[]>;
  /**
   * The `event_outbox` events of `type`, oldest first, with their `data` (PLAN-013 S4: the sync
   * suite counts `reaction.removed`, emitted only when a clear removed a row).
   */
  events(type: string): Promise<OutboxEventRow[]>;
  /** Every team's default status, and every `workflow_statuses` and `labels` row (PLAN-010 S5). */
  workflow(): Promise<WorkflowRows>;
  /**
   * Every issue's lifecycle, by id (PLAN-015 S2): `archivedAt` and `deletedAt` as ISO strings or
   * null, so the lifecycle property tells live issues from archived and deleted ones.
   */
  issueLifecycles(): Promise<IssueLifecycleRow[]>;
  /**
   * Closes a live issue with a logged `issue.update` (to the team's first Completed status, by
   * position) when it is open, then runs `issue.autoArchive` as the system actor through an
   * executor whose clock is 13 months ahead, as the job would (PLAN-015 S3). Resolves true only
   * when the issue was archived: false for one that is not live, or that an edit reopened first.
   */
  autoArchive(issueId: string): Promise<boolean>;
  /**
   * Retention runs now: `sync_log` keeps only its newest row, so a client behind it gets
   * `resync(too_old)` when it next connects (SPEC-002 E8). The job's own pruning, all at once.
   */
  compactLog(): Promise<void>;
  /** Shut down like `SIGTERM` (sockets close with 1012), then start again on the same database. */
  restart(): Promise<void>;
  /** Shut down and release the database; a second call does nothing. The caller drops its database afterwards. */
  stop(): Promise<void>;
}

const OpResponseSchema = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

/** The rows the workflow property reads (PLAN-010 S5, SPEC-010 AC-19). */
export interface WorkflowRows {
  readonly teams: readonly { id: string; key: string; defaultStatusId: string }[];
  readonly statuses: readonly { id: string; teamId: string; name: string; category: string }[];
  readonly labels: readonly { id: string; teamId: string | null; name: string }[];
}

const WorkflowTeamRow = z.object({
  id: z.string(),
  key: z.string(),
  default_status_id: z.string(),
});
const WorkflowStatusRow = z.object({
  id: z.string(),
  team_id: z.string(),
  name: z.string(),
  category: z.string(),
});
const WorkflowLabelRow = z.object({
  id: z.string(),
  team_id: z.string().nullable(),
  name: z.string(),
});

/** An issue's lifecycle fields (PLAN-015 S2). */
export interface IssueLifecycleRow {
  readonly id: string;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
}

const IssueLifecycleDbRow = z.object({
  id: z.string(),
  archived_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
});

const IssueDbRow = z.object({
  id: z.string(),
  team_id: z.string(),
  number: z.number(),
  title: z.string(),
  status_id: z.string(),
  priority: z.number(),
  label_ids: z.array(z.string()),
  sort_order: z.string(),
  sync_groups: z.array(z.string()),
  inserted_at: z.string().nullable(),
});

const DraftDbRow = z.object({
  id: z.string(),
  user_id: z.string(),
  kind: z.string(),
  team_id: z.string().nullable(),
  issue_id: z.string().nullable(),
  data: z.unknown(),
  sync_groups: z.array(z.string()),
});

const instantText = z
  .date()
  .nullable()
  .transform((value) => value?.toISOString() ?? null);

const CommentDbRow = z.object({
  id: z.string(),
  issue_id: z.string(),
  team_id: z.string(),
  parent_comment_id: z.string().nullable(),
  user_id: z.string(),
  actor_kind: z.string(),
  body: z.unknown(),
  version: z.number(),
  edited_at: instantText,
  deleted_at: instantText,
  resolved_at: instantText,
  resolved_by_id: z.string().nullable(),
  sync_groups: z.array(z.string()),
});

const ReactionDbRow = z.object({
  id: z.string(),
  issue_id: z.string(),
  team_id: z.string(),
  comment_id: z.string().nullable(),
  user_id: z.string(),
  emoji: z.string(),
  created_at: z.date().transform((value) => value.toISOString()),
  sync_groups: z.array(z.string()),
});

const IssueContentDbRow = z.object({
  id: z.string(),
  issue_id: z.string(),
  team_id: z.string(),
  description: z.unknown(),
  version: z.number(),
  sync_groups: z.array(z.string()),
});

const IssueHistoryDbRow = z.object({
  id: z.string(),
  issue_id: z.string(),
  team_id: z.string(),
  actor_kind: z.string(),
  actor_id: z.string().nullable(),
  api_key_id: z.string().nullable(),
  kind: z.string(),
  changes: z.unknown(),
  sync_groups: z.array(z.string()),
});

const OutboxEventDbRow = z.object({ type: z.string(), data: z.unknown() });

/** One `event_outbox` row's name and data. */
export type OutboxEventRow = z.infer<typeof OutboxEventDbRow>;

const ItemRow = z.object({
  id: z.string(),
  title: z.string(),
  counter: z.number(),
  archived: z.boolean(),
  archived_at: z.date().nullable(),
  sync_groups: z.array(z.string()),
});

export async function startTestServer(options: TestServerOptions): Promise<TestServer> {
  const userCount = options.users ?? 1;
  if (!Number.isInteger(userCount) || userCount < 1) {
    throw new RangeError(`users must be a whole number of at least 1 (got ${userCount}).`);
  }
  const logger = options.logger ?? pino({ level: 'silent' });
  const setupToken = randomBytes(24).toString('hex');
  const config = testServerConfig(options.databaseUrl, setupToken);
  // Reads and sign-ins outlive restarts, so they get a pool of their own, built like the server's
  // (an idle connection that fails is logged, not an uncaught 'error').
  const db = createPool(options.databaseUrl, logger, { max: 2 });
  let stopped = false;

  let server: RunningServer | undefined;
  let url = '';
  const start = async (): Promise<void> => {
    if (stopped) throw new Error('This test server was stopped. Start a new one.');
    const started = await startServer(config, { logger, syncFixtures: true });
    server = started;
    await started.ready;
    const address = started.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no TCP port assigned');
    url = `http://127.0.0.1:${address.port}`;
  };
  const shutdown = async (): Promise<void> => {
    const running = server;
    server = undefined;
    if (running === undefined) return;
    await gracefulShutdown({ app: running.app, lifecycle: running.lifecycle, log: logger });
  };

  try {
    await start();
    const users = await signIn(db, config, setupToken, userCount);
    const runOp = async (user: TestUser, name: string, input: unknown): Promise<OpResponse> => {
      const response = await fetch(`${url}/api/ops/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: {
          cookie: user.cookie,
          [CSRF_HEADER]: user.csrfToken,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ input }),
      });
      return OpResponseSchema.parse(await response.json());
    };
    // A second executor on the same database whose clock runs 13 months ahead: `issue.autoArchive`
    // through it finds a just-closed issue due (the default period is 6), with no raw write. Its
    // commits reach the hub through `NOTIFY` like any other (PLAN-015 S3).
    let ahead: Executor | undefined;
    const dueExecutor = (): Executor =>
      (ahead ??= createExecutor({
        pool: db,
        registry,
        handlers: HANDLERS,
        log: logger,
        allowInternal: true,
        publicUrl: config.publicUrl,
        syncedModels: serverSyncRegistry({ syncFixtures: true }).models.map((m) => m.name),
        clock: () => new Date(Date.now() + 13 * 30 * 24 * 60 * 60 * 1000),
      }));
    return {
      get url() {
        return url;
      },
      users,
      schemaHash: serverSyncRegistry({ syncFixtures: true }).schemaHash,
      run: runOp,
      head: async () => {
        const { rows } = await db.query<{ head: string | null }>(
          'SELECT max(sync_id)::text AS head FROM sync_log',
        );
        return Number(rows[0]?.head ?? 0);
      },
      headFor: async (userId) => {
        // A row only other users' `user:` groups hold never reaches this user's connections.
        const { rows } = await db.query<{ head: string | null }>(
          `SELECT max(sync_id)::text AS head FROM sync_log
            WHERE EXISTS (SELECT 1 FROM unnest(groups) g WHERE g NOT LIKE 'user:%' OR g = $1)`,
          [`user:${userId}`],
        );
        return Number(rows[0]?.head ?? 0);
      },
      items: async () => {
        const { rows } = await db.query(
          `SELECT id, title, counter, archived_at IS NOT NULL AS archived, archived_at, sync_groups
             FROM debug_items ORDER BY id`,
        );
        return rows.map((row) => {
          const item = ItemRow.parse(row);
          return {
            id: item.id,
            title: item.title,
            counter: item.counter,
            archived: item.archived,
            archivedAt: item.archived_at?.toISOString() ?? null,
            syncGroups: item.sync_groups,
          };
        });
      },
      issues: async () => {
        const { rows } = await db.query(
          `SELECT i.id, i.team_id, i.number, i.title, i.status_id, i.priority, i.label_ids,
                  i.sort_order, i.sync_groups,
                  (SELECT min(l.sync_id)::text FROM sync_log l
                    WHERE l.model = 'Issue' AND l.model_id = i.id AND l.action = 'I') AS inserted_at
             FROM issues i ORDER BY i.id`,
        );
        return rows.map((row) => {
          const issue = IssueDbRow.parse(row);
          return {
            id: issue.id,
            teamId: issue.team_id,
            number: issue.number,
            title: issue.title,
            statusId: issue.status_id,
            priority: issue.priority,
            labelIds: issue.label_ids,
            sortOrder: issue.sort_order,
            syncGroups: issue.sync_groups,
            insertedAt: issue.inserted_at === null ? null : Number(issue.inserted_at),
          };
        });
      },
      drafts: async () => {
        const { rows } = await db.query(
          `SELECT id, user_id, kind, team_id, issue_id, data, sync_groups FROM drafts ORDER BY id`,
        );
        return rows.map((row) => {
          const draft = DraftDbRow.parse(row);
          return {
            id: draft.id,
            userId: draft.user_id,
            kind: draft.kind,
            teamId: draft.team_id,
            issueId: draft.issue_id,
            data: draft.data,
            syncGroups: draft.sync_groups,
          };
        });
      },
      comments: async () => {
        const { rows } = await db.query(
          `SELECT id, issue_id, team_id, parent_comment_id, user_id, actor_kind, body, version,
                  edited_at, deleted_at, resolved_at, resolved_by_id, sync_groups
             FROM comments ORDER BY id`,
        );
        return rows.map((row) => {
          const c = CommentDbRow.parse(row);
          return {
            id: c.id,
            issueId: c.issue_id,
            teamId: c.team_id,
            parentCommentId: c.parent_comment_id,
            userId: c.user_id,
            actorKind: c.actor_kind,
            body: c.body,
            version: c.version,
            editedAt: c.edited_at,
            deletedAt: c.deleted_at,
            resolvedAt: c.resolved_at,
            resolvedById: c.resolved_by_id,
            syncGroups: c.sync_groups,
          };
        });
      },
      reactionCount: async () => {
        const { rows } = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM reactions');
        return rows[0]?.n ?? 0;
      },
      reactions: async () => {
        const { rows } = await db.query(
          `SELECT id, issue_id, team_id, comment_id, user_id, emoji, created_at, sync_groups
             FROM reactions ORDER BY id`,
        );
        return rows.map((row) => {
          const r = ReactionDbRow.parse(row);
          return {
            id: r.id,
            issueId: r.issue_id,
            teamId: r.team_id,
            commentId: r.comment_id,
            userId: r.user_id,
            emoji: r.emoji,
            createdAt: r.created_at,
            syncGroups: r.sync_groups,
          };
        });
      },
      issueContents: async () => {
        const { rows } = await db.query(
          `SELECT id, issue_id, team_id, description, version, sync_groups
             FROM issue_content ORDER BY id`,
        );
        return rows.map((row) => {
          const c = IssueContentDbRow.parse(row);
          return {
            id: c.id,
            issueId: c.issue_id,
            teamId: c.team_id,
            description: c.description,
            version: c.version,
            syncGroups: c.sync_groups,
          };
        });
      },
      issueHistories: async () => {
        const { rows } = await db.query(
          `SELECT id, issue_id, team_id, actor_kind, actor_id, api_key_id, kind, changes,
                  sync_groups
             FROM issue_history ORDER BY id`,
        );
        return rows.map((row) => {
          const h = IssueHistoryDbRow.parse(row);
          return {
            id: h.id,
            issueId: h.issue_id,
            teamId: h.team_id,
            actorKind: h.actor_kind,
            actorId: h.actor_id,
            apiKeyId: h.api_key_id,
            kind: h.kind,
            changes: h.changes,
            syncGroups: h.sync_groups,
          };
        });
      },
      issueLifecycles: async () => {
        const { rows } = await db.query(
          `SELECT id,
                  to_char(archived_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS archived_at,
                  to_char(deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS deleted_at
             FROM issues ORDER BY id`,
        );
        return rows.map((row) => {
          const issue = IssueLifecycleDbRow.parse(row);
          return { id: issue.id, archivedAt: issue.archived_at, deletedAt: issue.deleted_at };
        });
      },
      autoArchive: async (issueId) => {
        const { rows } = await db.query<{ closed: boolean; status_id: string | null }>(
          `SELECT s.category IN ('completed', 'canceled', 'duplicate') AS closed,
                  (SELECT c.id FROM workflow_statuses c
                    WHERE c.team_id = i.team_id AND c.category = 'completed'
                    ORDER BY c.position COLLATE "C", c.id LIMIT 1) AS status_id
             FROM issues i JOIN workflow_statuses s ON s.id = i.status_id
            WHERE i.id = $1 AND i.archived_at IS NULL AND i.deleted_at IS NULL`,
          [issueId],
        );
        const issue = rows[0];
        const user = users[0];
        if (issue === undefined || user === undefined) return false;
        // Closing is a logged `issue.update`, as a person would do it: every replica learns it.
        if (!issue.closed && issue.status_id !== null) {
          await runOp(user, 'issue.update', { issue: issueId, status: issue.status_id });
        }
        // Due is the executor's clock 13 months ahead (the default period is 6), so no unlogged
        // write is needed. The operation re-checks under the lock: an edit that reopened the
        // issue meanwhile makes it CONFLICT, and nothing is archived.
        const result = await dueExecutor().execute(
          'issue.autoArchive',
          { issue: issueId },
          systemActor(),
        );
        return result.ok;
      },
      events: async (type) => {
        const { rows } = await db.query(
          'SELECT type, data FROM event_outbox WHERE type = $1 ORDER BY id',
          [type],
        );
        return rows.map((row) => OutboxEventDbRow.parse(row));
      },
      workflow: async () => {
        const teams = await db.query('SELECT id, key, default_status_id FROM teams ORDER BY id');
        const statuses = await db.query(
          'SELECT id, team_id, name, category FROM workflow_statuses ORDER BY id',
        );
        const labels = await db.query('SELECT id, team_id, name FROM labels ORDER BY id');
        return {
          teams: teams.rows.map((row) => {
            const team = WorkflowTeamRow.parse(row);
            return { id: team.id, key: team.key, defaultStatusId: team.default_status_id };
          }),
          statuses: statuses.rows.map((row) => {
            const status = WorkflowStatusRow.parse(row);
            return {
              id: status.id,
              teamId: status.team_id,
              name: status.name,
              category: status.category,
            };
          }),
          labels: labels.rows.map((row) => {
            const label = WorkflowLabelRow.parse(row);
            return { id: label.id, teamId: label.team_id, name: label.name };
          }),
        };
      },
      compactLog: async () => {
        // Every row older than year 9999: all but the newest (`pruneSyncLog` keeps it).
        await pruneSyncLog(
          drizzle({ client: db, casing: 'snake_case' }),
          new Date('9999-12-31T00:00:00Z'),
        );
      },
      restart: async () => {
        await shutdown();
        await start();
      },
      stop: async () => {
        if (stopped) return;
        stopped = true;
        try {
          await shutdown();
        } finally {
          await db.end();
        }
      },
    };
  } catch (error) {
    await shutdown().catch(() => undefined);
    await db.end().catch(() => undefined);
    throw error;
  }
}

const LogLine = z.object({
  msg: z.string().optional(),
  err: z.object({ message: z.string().optional() }).optional(),
});

/**
 * A logger for `startTestServer` that calls `onError` with each line logged at
 * error level or above, as "message: error message". It is the server's own
 * logger (`createLogger`), redaction included; warnings and below are dropped.
 */
export function errorLogger(onError: (summary: string) => void): Logger {
  return createLogger(
    { logLevel: 'error' },
    {
      write: (line: string) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          onError(line.trim());
          return;
        }
        const entry = LogLine.safeParse(parsed);
        if (!entry.success) {
          onError(line.trim());
          return;
        }
        const { msg = '(no message)', err } = entry.data;
        onError(err?.message === undefined ? msg : `${msg}: ${err.message}`);
      },
    },
  );
}

/** A role-`web` server: the hub and HTTP, no job worker and no SMTP. */
function testServerConfig(databaseUrl: string, setupToken: string): Config {
  // `loadConfig` validates a plain object here; it reads `process.env` only by default.
  const config = loadConfig({
    SURFACE_URL: 'http://127.0.0.1',
    SESSION_SECRET: randomBytes(32).toString('hex'),
    DATABASE_URL: databaseUrl,
    SURFACE_SETUP_TOKEN: setupToken,
    SURFACE_ROLE: 'web',
    LOG_LEVEL: 'silent',
    METRICS_ENABLED: 'false',
    TRUST_PROXY: 'false',
    HOST: '127.0.0.1',
    // Debug operations run outside production only (SPEC-003 §6 step 2).
    NODE_ENV: 'test',
  });
  // Port 0 (any free port) is outside `PORT`'s range check, so it is set after validation.
  // DATA_DIR must exist and be writable (SPEC-004 E5).
  return { ...config, port: 0, webDir: '/nonexistent-web-dir', dataDir: tmpdir() };
}

/**
 * First-run setup (the Admin, the workspace and its first team), then the other users as
 * members of that team, written through the repo layer (rule 2), then a session for each.
 */
async function signIn(
  db: pg.Pool,
  config: Config,
  token: string,
  count: number,
): Promise<TestUser[]> {
  const admin = setupInputSchema.parse({
    token,
    workspace: { name: 'Sync simulation' },
    admin: {
      name: 'Sim Admin',
      email: 'sim-0@example.com',
      password: randomBytes(16).toString('hex'),
    },
    team: { name: 'Simulation', key: 'SIM' },
  });
  const outcome = await pgSetupStore(db).complete(admin, { userAgent: 'sync-sim', ip: undefined });
  if (!outcome.ok) {
    throw new Error(
      outcome.reason === 'complete'
        ? 'This database is already set up. Pass a fresh one, such as createTestDatabase().'
        : 'First-run setup refused the configured setup token.',
    );
  }

  const { rows } = await db.query<{ user_id: string; team_id: string }>(
    `SELECT m.user_id, m.team_id FROM team_memberships m JOIN users u ON u.id = m.user_id
      WHERE u.email = $1`,
    [admin.admin.email],
  );
  const first = rows[0];
  if (first === undefined) throw new Error('First-run setup left the Admin without a team.');
  const people = [{ id: first.user_id, email: admin.admin.email }];
  for (let n = 1; n < count; n += 1) people.push({ id: uuidv7(), email: `sim-${n}@example.com` });

  await transactionRunner(db)(async (client) => {
    const repo = syncRepo(drizzle({ client, casing: 'snake_case' }), new Date());
    for (const person of people.slice(1)) {
      await repo.insert('User', {
        id: person.id,
        email: person.email,
        name: person.email,
        displayName: person.email.split('@')[0] ?? person.email,
        syncGroups: [],
      });
      await repo.insert('UserPreferences', { id: person.id, syncGroups: [] });
      await repo.insert('TeamMembership', {
        id: uuidv7(),
        teamId: first.team_id,
        userId: person.id,
        syncGroups: [],
      });
    }
    await repo.flush({});
  });

  // The Admin keeps the session setup created; the others sign in here.
  const store = pgAuthStore(db);
  const users: TestUser[] = [];
  for (const [n, person] of people.entries()) {
    const session =
      n === 0
        ? outcome.session
        : await store.createSession({
            userId: person.id,
            userAgent: 'sync-sim',
            ip: undefined,
            now: new Date(),
          });
    const csrf = csrfToken(config.sessionSecret, session.id);
    users.push({
      id: person.id,
      email: person.email,
      cookie: `${SESSION_COOKIE}=${session.token}; ${CSRF_COOKIE}=${csrf}`,
      csrfToken: csrf,
    });
  }
  return users;
}
