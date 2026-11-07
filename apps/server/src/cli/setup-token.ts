/**
 * `surface setup-token` (SPEC-004 §9, SPEC-001 §3.1): issue a fresh setup token and print the
 * setup link, for an operator who lost the one in the logs. The previous link stops working.
 * Printing the link is the command's purpose; it goes to stdout, not the log.
 */
import type { Config } from '../config.js';
import { createPool } from '../db/pool.js';
import { createLogger } from '../logger.js';
import { pgSetupStore, type SetupStore } from '../setup/store.js';
import { generateSetupToken, setupUrl } from '../setup/token.js';
import { EXIT, type CliIo } from './io.js';

export interface SetupTokenOptions {
  /** A store to use instead of the database (tests). */
  readonly store?: Pick<SetupStore, 'isComplete' | 'issueToken'>;
}

export async function setupTokenCommand(
  io: CliIo,
  config: Config,
  options: SetupTokenOptions = {},
): Promise<number> {
  const pool = options.store
    ? undefined
    : createPool(config.databaseUrl, createLogger(config), { max: 1 });
  const store = options.store ?? (pool && pgSetupStore(pool));
  if (!store) return EXIT.failure;
  try {
    if (await store.isComplete()) {
      io.err(`Setup is already complete. Sign in at ${config.publicUrl}.\n`);
      return EXIT.failure;
    }
    const token = generateSetupToken();
    if (!(await store.issueToken(token))) {
      io.err(`Setup was completed just now. Sign in at ${config.publicUrl}.\n`);
      return EXIT.failure;
    }
    // A configured token comes back when the server restarts (announce.ts), so say so.
    const earlier =
      config.setupToken === undefined
        ? 'Earlier setup links no longer work.'
        : 'Earlier setup links, including the one for SURFACE_SETUP_TOKEN, no longer work until the server restarts.';
    io.out(
      `Open this link to finish setup. ${earlier}\n\n    ${setupUrl(config.publicUrl, token)}\n\n`,
    );
    return EXIT.ok;
  } catch (error) {
    io.err(`${describeFailure(error)}\n`);
    return EXIT.failure;
  } finally {
    await pool?.end().catch(() => undefined);
  }
}

/** A sentence for the operator, without the connection string or other internals. */
function describeFailure(error: unknown): string {
  const code: unknown =
    typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
  if (code === '42P01') {
    return 'The database has no Surface tables yet. Start the server once, or run "surface migrate", then try again.';
  }
  if (typeof code === 'string' && CONNECTION_FAILURES.has(code)) {
    return 'Could not reach the database. Check DATABASE_URL and that PostgreSQL is running, then try again.';
  }
  return 'Could not issue a setup token. Run "surface doctor" to check the database, then try again.';
}

/** Network errors, and Postgres refusing the login or the database (28xxx, 3D000). */
const CONNECTION_FAILURES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  '28P01',
  '28000',
  '3D000',
]);
