/**
 * Server startup (SPEC-004 §8). `startServer()` listens first, so `/healthz`
 * answers and `/readyz` reports 503 while the database is prepared, then runs
 * the startup sequence. `serve()` adds signal handling and exits on failure.
 */
import type { FastifyInstance } from 'fastify';
import type { Logger } from 'pino';
import { buildApp } from './app.js';
import { buildInfo, type BuildInfo } from './build-info.js';
import type { Config } from './config.js';
import { loadMigrations, migrationStatus, type Migration } from './db/migrate.js';
import { createPool, waitForDatabase, type Pool } from './db/pool.js';
import { prepareDatabase } from './db/prepare.js';
import { Lifecycle } from './lifecycle.js';
import { createLogger } from './logger.js';
import { installProcessHandlers } from './shutdown.js';
import { StartupError } from './startup-error.js';

export interface StartOptions {
  logger?: Logger;
  info?: BuildInfo;
  migrations?: Migration[];
  /** How long to wait for the database before giving up (E1). */
  databaseWaitMs?: number;
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

  lifecycle.onShutdown('resources', 'database pool', () => pool.end());
  lifecycle.addReadinessCheck('db', async () => {
    await pool.query('SELECT 1');
    return 'ok';
  });
  lifecycle.addReadinessCheck('migrations', () => migrationStatus(pool, migrations));

  const app = await buildApp({ config, lifecycle, logger, info });
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

    // PLAN-001 S2: log the setup token while setup is incomplete.
    // Job worker and sync hub start here in later slices (by SURFACE_ROLE).

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
