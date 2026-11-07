/**
 * One executor transaction (SPEC-003 §6 steps 6 and 12, E5).
 *
 * - Queries run `REPEATABLE READ READ ONLY`: one snapshot for resolution and handler, and any
 *   write fails (AC-4, E3).
 * - Mutations run `READ COMMITTED`: concurrent updates of a row wait for its lock and the last
 *   write wins, which is the field-level rule of sync-protocol §5. Handlers that read, then
 *   write based on what they read, lock the rows they depend on (`SELECT … FOR UPDATE`).
 * - Serialization failures and deadlocks roll back and rerun `fn` from scratch, up to
 *   `retries` times with jitter, then become `CONFLICT`.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import type { PoolClient } from 'pg';
import type { Pool } from '../db/pool.js';
import { SurfaceError } from './errors.js';

export interface TransactionOptions {
  readonly readOnly: boolean;
  /** Extra attempts after a serialization failure or deadlock. */
  readonly retries: number;
  /** Milliseconds to wait before retry `attempt` (1-based). */
  readonly backoff: (attempt: number) => number;
}

/** 40001 serialization_failure, 40P01 deadlock_detected. */
const RETRYABLE = new Set(['40001', '40P01']);

/** 10–50 ms, growing with the attempt. Jitter only: no security relevance. */
export function jitterBackoff(attempt: number): number {
  return attempt * (10 + Math.floor(Math.random() * 40));
}

export async function inTransaction<T>(
  pool: Pool,
  options: TransactionOptions,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await client.query(
          options.readOnly
            ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
            : 'BEGIN ISOLATION LEVEL READ COMMITTED READ WRITE',
        );
      } catch (error) {
        // A connection that can't even BEGIN is unusable: destroy it.
        broken = error instanceof Error ? error : new Error(String(error));
        throw error;
      }
      try {
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          // The connection is unusable; destroy it instead of returning it to the pool.
          broken =
            rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
          throw error;
        }
        if (!isRetryable(error)) throw error;
        if (attempt >= options.retries) {
          throw new SurfaceError(
            'CONFLICT',
            'This changed at the same time as another update. Try again.',
          );
        }
        await sleep(options.backoff(attempt + 1));
      }
    }
  } finally {
    client.release(broken);
  }
}

export function isRetryable(error: unknown): boolean {
  const code = postgresCode(error);
  return code !== undefined && RETRYABLE.has(code);
}

/** The Postgres SQLSTATE of an error, looking through wrappers (Drizzle sets `cause`). */
export function postgresCode(error: unknown): string | undefined {
  for (let e: unknown = error; typeof e === 'object' && e !== null; e = Reflect.get(e, 'cause')) {
    const code: unknown = Reflect.get(e, 'code');
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

/** Runs `fn` in one read-write transaction on one connection, and resolves to its result. */
export type WithTransaction = <T>(fn: (client: PoolClient) => Promise<T>) => Promise<T>;

/**
 * Transactions for routes outside the executor (sign-in, magic link, reset; PLAN-001 S4), so a
 * route's writes and the email it queues (`EmailOutbox.enqueue(client, …)`) commit or roll back
 * together. Like the executor's: `READ COMMITTED`, a serialization failure or deadlock reruns
 * `fn`, so `fn` must have no effect outside the transaction.
 */
export function transactionRunner(
  pool: Pool,
  options: Partial<Omit<TransactionOptions, 'readOnly'>> = {},
): WithTransaction {
  const settings: TransactionOptions = {
    readOnly: false,
    retries: options.retries ?? 3,
    backoff: options.backoff ?? jitterBackoff,
  };
  return (fn) => inTransaction(pool, settings, fn);
}
