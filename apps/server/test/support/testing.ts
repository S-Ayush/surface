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
import { transactionRunner } from '../../src/executor/transaction.js';
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
  /** Every `debug_items` row, by id. */
  items(): Promise<DebugItemRow[]>;
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

const ItemRow = z.object({
  id: z.string(),
  title: z.string(),
  counter: z.number(),
  archived: z.boolean(),
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
    return {
      get url() {
        return url;
      },
      users,
      schemaHash: serverSyncRegistry({ syncFixtures: true }).schemaHash,
      run: async (user, name, input) => {
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
      },
      head: async () => {
        const { rows } = await db.query<{ head: string | null }>(
          'SELECT max(sync_id)::text AS head FROM sync_log',
        );
        return Number(rows[0]?.head ?? 0);
      },
      items: async () => {
        const { rows } = await db.query(
          `SELECT id, title, counter, archived_at IS NOT NULL AS archived, sync_groups
             FROM debug_items ORDER BY id`,
        );
        return rows.map((row) => {
          const item = ItemRow.parse(row);
          return {
            id: item.id,
            title: item.title,
            counter: item.counter,
            archived: item.archived,
            syncGroups: item.sync_groups,
          };
        });
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
