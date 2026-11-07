/**
 * `surface reset-password <email>` (SPEC-004 §9, SPEC-001 §3.3): a one-time reset link for an
 * operator, for when no Admin can sign in (the only Admin forgot their password) and the server
 * sends no email. Like an Admin's `user.createResetLink`: valid 1 hour, earlier reset links stop
 * working, and using it logs the user out everywhere. Printing the link is the command's
 * purpose; it goes to stdout, not the log.
 */
import { normaliseEmail } from '@surface/domain';
import type { Config } from '../config.js';
import { createPool } from '../db/pool.js';
import { transactionRunner, type WithTransaction } from '../executor/transaction.js';
import { createLogger } from '../logger.js';
import { activeUserByEmail, issueLink, type LinkDb } from '../mail/link-tokens.js';
import { passwordResetUrl } from '../mail/links.js';
import { EXIT, type CliIo } from './io.js';

/** What the command reads and writes; tests pass a fake. */
export interface ResetPasswordStore {
  readonly withTransaction: WithTransaction;
  activeUserByEmail(db: LinkDb, email: string): Promise<{ id: string } | undefined>;
  issueLink: typeof issueLink;
}

export interface ResetPasswordOptions {
  readonly store?: ResetPasswordStore;
  readonly now?: () => Date;
}

export async function resetPasswordCommand(
  io: CliIo,
  config: Config,
  rawEmail: string,
  options: ResetPasswordOptions = {},
): Promise<number> {
  const pool = options.store
    ? undefined
    : createPool(config.databaseUrl, createLogger(config), { max: 1 });
  const store: ResetPasswordStore | undefined =
    options.store ??
    (pool && { withTransaction: transactionRunner(pool), activeUserByEmail, issueLink });
  if (!store) return EXIT.failure;
  const email = normaliseEmail(rawEmail); // E2
  const now = options.now?.() ?? new Date();
  try {
    const link = await store.withTransaction(async (client) => {
      const user = await store.activeUserByEmail(client, email);
      return user && (await store.issueLink(client, 'passwordReset', user.id, { now }));
    });
    if (link === undefined) {
      io.err(
        `No active user has the email ${email}. Check the address, then try again. Deactivated users can't reset their password.\n`,
      );
      return EXIT.failure;
    }
    io.out(
      `Send this link to ${email}. It works once, for 1 hour, and logs them out everywhere else. Earlier reset links no longer work.\n\n    ${passwordResetUrl(config.publicUrl, link.token)}\n\n`,
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
  return 'Could not create a reset link. Run "surface doctor" to check the database, then try again.';
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
