/**
 * The database part of startup (SPEC-004 §8 steps 3–4), shared by `surface serve`
 * and `surface migrate`.
 */
import type { Logger } from 'pino';
import { checkPostgresVersion, ensureExtensions } from './checks.js';
import { migrate, type Migration } from './migrate.js';
import type { Pool } from './pool.js';

export interface PrepareOptions {
  log: Logger;
  appVersion: string;
  migrations?: Migration[];
}

export interface PrepareResult {
  postgresVersion: string;
  applied: string[];
}

/**
 * Check the Postgres version, then, under the migrations lock, create missing
 * extensions and apply pending migrations. Nothing is changed on an incompatible
 * server, and concurrent replicas never race on CREATE EXTENSION.
 */
export async function prepareDatabase(
  pool: Pool,
  { log, appVersion, migrations }: PrepareOptions,
): Promise<PrepareResult> {
  const postgresVersion = await checkPostgresVersion(pool);
  const { applied } = await migrate(pool, {
    log,
    appVersion,
    ...(migrations === undefined ? {} : { migrations }),
    beforeMigrate: (client) => ensureExtensions(client, log),
  });
  return { postgresVersion, applied };
}
