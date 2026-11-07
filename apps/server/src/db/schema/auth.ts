import { bigint, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Failed sign-ins, for the lockout (ADR-0007, SPEC-001 AC-6, E13): in Postgres so that a restart
 * or a second replica doesn't reset the count. Server-only. One row per failure and key, where the
 * key is `account:<email>` or `ip:<address>` (an IPv6 /64). A row is written before the password is
 * checked and stays as a failure unless the sign-in succeeds. Rows older than the window are
 * deleted whenever one is written (hence the index on `attempted_at`), and an account's rows on
 * its successful sign-in.
 */
export const authAttempts = pgTable(
  'auth_attempts',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    key: text().notNull(),
    attemptedAt: timestamp({ withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    index('auth_attempts_key_attempted_at_idx').on(t.key, t.attemptedAt),
    index('auth_attempts_attempted_at_idx').on(t.attemptedAt),
  ],
);
