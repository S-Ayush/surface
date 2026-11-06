/**
 * `surface migrate`: the database part of startup (SPEC-004 §8 steps 2–4), then exit.
 * Used by CI and for manual upgrades. It runs `prepareDatabase()`, exactly like
 * `serve`, so extensions are created under the same migrations lock.
 * Output is the server's JSON log, so it reads the same in `docker compose logs`.
 */
import type { Logger } from 'pino';
import { buildInfo, type BuildInfo } from '../build-info.js';
import type { Config } from '../config.js';
import type { Migration } from '../db/migrate.js';
import { createPool, waitForDatabase } from '../db/pool.js';
import { prepareDatabase } from '../db/prepare.js';
import { createLogger } from '../logger.js';
import { StartupError } from '../startup-error.js';
import { EXIT } from './io.js';

export interface MigrateCommandOptions {
  logger?: Logger;
  info?: BuildInfo;
  migrations?: Migration[];
  /** How long to wait for the database (E1); 60 s by default, like `serve`. */
  databaseWaitMs?: number;
}

export async function migrateCommand(
  config: Config,
  options: MigrateCommandOptions = {},
): Promise<number> {
  const logger = options.logger ?? createLogger(config);
  const info = options.info ?? buildInfo();
  // One connection holds the lock; the second answers anything else.
  const pool = createPool(config.databaseUrl, logger, { max: 2 });
  try {
    await waitForDatabase(pool, {
      log: logger,
      databaseUrl: config.databaseUrl,
      ...(options.databaseWaitMs === undefined ? {} : { timeoutMs: options.databaseWaitMs }),
    });
    const { applied, postgresVersion } = await prepareDatabase(pool, {
      log: logger,
      appVersion: info.version,
      ...(options.migrations === undefined ? {} : { migrations: options.migrations }),
    });
    logger.info(
      { applied: applied.length, postgresVersion, version: info.version },
      applied.length > 0 ? 'migrations applied' : 'nothing to migrate',
    );
    return EXIT.ok;
  } catch (error) {
    if (error instanceof StartupError) logger.fatal(error.message);
    else logger.fatal({ err: error }, 'migration failed');
    return EXIT.failure;
  } finally {
    await pool.end().catch(() => undefined);
  }
}
