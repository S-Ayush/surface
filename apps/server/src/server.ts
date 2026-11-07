/**
 * Server startup (SPEC-004 §8). `startServer()` listens first, so `/healthz`
 * answers and `/readyz` reports 503 while the database is prepared, then runs
 * the startup sequence. `serve()` adds signal handling and exits on failure.
 */
import { registry } from '@surface/operations';
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { buildApp } from './app.js';
import { buildInfo, type BuildInfo } from './build-info.js';
import type { Config } from './config.js';
import { loadMigrations, migrationStatus, type Migration } from './db/migrate.js';
import { createPool, waitForDatabase, type Pool } from './db/pool.js';
import { prepareDatabase } from './db/prepare.js';
import { createExecutor, missingHandlers } from './executor/execute.js';
import { tokenBucket } from './executor/rate-limit.js';
import { HANDLERS } from './handlers/index.js';
import { pgAttemptStore } from './auth/attempts.js';
import { SessionAuth } from './auth/sessions.js';
import { pgAuthStore } from './auth/store.js';
import type { ActorResolver } from './http/ops.js';
import { startJobs, type Jobs } from './jobs/index.js';
import { Lifecycle } from './lifecycle.js';
import { createLogger } from './logger.js';
import { installProcessHandlers } from './shutdown.js';
import { StartupError } from './startup-error.js';
import pg from 'pg';
import { SyncHub } from './sync/hub.js';
import { pgSyncLogSource, sessionCloser } from './sync/hub-source.js';
import { announceSetup } from './setup/announce.js';
import { SetupGate } from './setup/routes.js';
import { pgSetupStore } from './setup/store.js';
import { syncRegistry } from './sync/registry.js';

export interface StartOptions {
  logger?: Logger;
  info?: BuildInfo;
  migrations?: Migration[];
  /** How long to wait for the database before giving up (E1). */
  databaseWaitMs?: number;
  /** Who sent a request, instead of the session cookie (tests that sign in without it). */
  resolveActor?: ActorResolver;
}

export interface RunningServer {
  app: FastifyInstance;
  lifecycle: Lifecycle;
  pool: Pool;
  logger: Logger;
  /** Resolves when the server is ready; rejects with a StartupError otherwise. */
  ready: Promise<void>;
}

export async function startServer(
  config: Config,
  options: StartOptions = {},
): Promise<RunningServer> {
  const logger = options.logger ?? createLogger(config);
  const info = options.info ?? buildInfo();
  const migrations = options.migrations ?? loadMigrations();
  const lifecycle = new Lifecycle();
  const pool = createPool(config.databaseUrl, logger);

  // Hooks run in registration order: the job worker stops before the pool its handlers use.
  let jobs: Jobs | undefined;
  lifecycle.onShutdown('resources', 'job queue', () => jobs?.stop());
  lifecycle.onShutdown('resources', 'database pool', () => pool.end());
  lifecycle.addReadinessCheck('db', async () => {
    await pool.query('SELECT 1');
    return 'ok';
  });
  lifecycle.addReadinessCheck('migrations', () => migrationStatus(pool, migrations));

  // Every registered operation needs a handler; a gap is a build mistake, caught before listening.
  const unhandled = missingHandlers(registry, HANDLERS);
  if (unhandled.length > 0) {
    throw new StartupError(`No handler is registered for: ${unhandled.join(', ')}.`);
  }
  const authStore = pgAuthStore(pool);
  const sessions = new SessionAuth(authStore, { log: logger });
  const resolveActor = options.resolveActor ?? sessions.resolveActor;
  // Engine fixtures (DebugItem) only outside production, like internal operations.
  const sync = syncRegistry({ includeFixtures: config.nodeEnv !== 'production' });
  // The hub serves WebSockets, so it runs where HTTP traffic is served (SPEC-004 §7 roles).
  const hub =
    config.role === 'worker'
      ? undefined
      : new SyncHub({
          source: pgSyncLogSource({
            pool,
            listenClient: () =>
              new pg.Client({
                connectionString: config.databaseUrl,
                application_name: 'surface-sync-hub',
                // An idle LISTEN connection only notices a dead peer through TCP keepalive; the
                // hub's ping-round poll covers the time until it does.
                keepAlive: true,
                keepAliveInitialDelayMillis: 10_000,
                connectionTimeoutMillis: 10_000,
              }),
          }),
          registry: sync,
          log: logger.child({ component: 'sync-hub' }),
        });
  const setupStore = pgSetupStore(pool);
  const setupGate = new SetupGate(setupStore);
  // Before HTTP stops: clients reconnect elsewhere, or here once we are back (1012).
  if (hub) lifecycle.onShutdown('connections', 'sync hub', () => hub.stop());
  const app = await buildApp({
    config,
    lifecycle,
    logger,
    info,
    sync: {
      pool,
      registry: sync,
      resolveActor,
      sessionIdOf: sessions.sessionIdOf,
      ...(hub ? { hub } : {}),
    },
    setup: { store: setupStore, gate: setupGate },
    auth: {
      auth: sessions,
      store: authStore,
      attempts: pgAttemptStore(pool),
      // Here at once (if this replica has a hub), and on every replica through `NOTIFY`.
      closeSessions: sessionCloser({ hub, pool, log: logger }),
    },
    ops: {
      registry,
      resolveActor,
      createExecutor: (metrics) =>
        createExecutor({
          pool,
          registry,
          handlers: HANDLERS,
          log: logger,
          // Internal (debug) operations exist only outside production (SPEC-003 §6 step 2).
          allowInternal: config.nodeEnv !== 'production',
          rateLimiter: tokenBucket(),
          ...(metrics ? { metrics } : {}),
        }),
    },
  });
  await app.listen({ port: config.port, host: config.host });

  const ready = (async () => {
    await waitForDatabase(pool, {
      log: logger,
      databaseUrl: config.databaseUrl,
      ...(options.databaseWaitMs === undefined ? {} : { timeoutMs: options.databaseWaitMs }),
    });
    // Version check first, then extensions and migrations under one lock, so an
    // unsupported server is reported before anything changes (SPEC-004 §8).
    const { postgresVersion } = await prepareDatabase(pool, {
      log: logger,
      appVersion: info.version,
      migrations,
    });

    // Step 5: where people open the app, log the setup link while setup is incomplete.
    if (config.role !== 'worker') {
      await announceSetup(setupStore, {
        publicUrl: config.publicUrl,
        configuredToken: config.setupToken,
        log: logger,
      });
    }
    await hub?.start();
    if (config.role !== 'web') {
      jobs = await startJobs({ databaseUrl: config.databaseUrl, pool, log: logger });
    }

    lifecycle.markReady();
    // A shutdown that started during startup leaves us draining: don't claim ready.
    if (lifecycle.state !== 'ready') return;
    logger.info(
      {
        version: info.version,
        commit: info.commit,
        url: config.publicUrl,
        role: config.role,
        postgresVersion,
      },
      'Surface is ready',
    );
  })();

  // Mark as handled so a failure before the caller awaits `ready` is not reported
  // as an unhandled rejection. Awaiting `ready` still rejects.
  ready.catch(() => undefined);

  return { app, lifecycle, pool, logger, ready };
}

/** `surface serve`: run until a signal arrives; exit 1 if startup fails. */
export async function serve(config: Config): Promise<void> {
  const server = await startServer(config);
  const { app, lifecycle, logger } = server;
  installProcessHandlers({ app, lifecycle, log: logger });

  try {
    await server.ready;
  } catch (error) {
    if (error instanceof StartupError) logger.fatal(error.message);
    else logger.fatal({ err: error }, 'startup failed');
    lifecycle.beginDraining();
    await app.close().catch(() => undefined);
    await server.pool.end().catch(() => undefined);
    process.exit(1);
  }
}
