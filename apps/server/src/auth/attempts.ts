/**
 * Sign-in lockout (ADR-0007, SPEC-001 AC-6, E13, Q8): 5 failed sign-ins in 15 minutes for an
 * account, or 20 from an IP address, lock that key until the oldest of those failures leaves the
 * window. Counted in Postgres (`auth_attempts`), so a restart or another replica sees them.
 *
 * - **The address limit is higher** (the user's decision on Q8): a small team often signs in from
 *   one office or proxy address, and 5 typos there would lock everyone out. The account limit is
 *   what protects a password; the address limit only slows guessing across many accounts.
 *
 * - **Reserved before the password check.** An attempt is recorded, under a per-key lock, before
 *   the password is checked, and counts as a failure unless the sign-in succeeds. Checking first
 *   and recording after would let guesses sent at once all pass the check (S3 review B1).
 * - Attempts while locked aren't checked or counted: an attacker can't extend a lockout forever
 *   by keeping on guessing, and the owner can sign in once it ends.
 * - The account key is the email as typed (normalised), whether or not an account has it, so a
 *   lockout says nothing about which accounts exist (AC-5).
 */
import { isIPv6 } from 'node:net';
import type pg from 'pg';
import { LOCK_CLASSES } from '../db/locks.js';

export const LOCKOUT = {
  /** Per account. */
  maxFailures: 5,
  /** Per IP address (an IPv6 /64). */
  maxAddressFailures: 20,
  windowMs: 15 * 60 * 1000,
} as const;

export const accountKey = (email: string): string => `account:${email}`;

/**
 * An IPv6 client usually holds a whole /64, so it is counted by that prefix: otherwise it could
 * use a new address for every guess. IPv4, and IPv4 mapped into IPv6, by the address.
 */
export function ipKey(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1] !== undefined) return `ip:${mapped[1]}`;
  if (!isIPv6(ip)) return `ip:${ip}`;
  return `ip:${ipv6Prefix64(ip)}::/64`;
}

/** The first four groups of an IPv6 address, without leading zeros (`2001:db8:0:1`). */
function ipv6Prefix64(ip: string): string {
  const address = ip.split('%')[0] ?? ip; // without the zone (`fe80::1%en0`)
  const groups = (part: string) =>
    part === '' ? [] : part.split(':').flatMap((g) => (g.includes('.') ? ['0', '0'] : [g]));
  const [head = '', tail] = address.split('::');
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const full =
    tail === undefined
      ? left
      : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right];
  return full
    .slice(0, 4)
    .map((g) => Number.parseInt(g, 16).toString(16))
    .join(':');
}

/**
 * Whole seconds until `attempts` (of one key) stop locking it, or undefined if they don't.
 * Pure, so the policy is tested without a database.
 */
export function lockedForSeconds(
  attempts: readonly Date[],
  now: Date,
  maxFailures: number = LOCKOUT.maxFailures,
): number | undefined {
  const since = now.getTime() - LOCKOUT.windowMs;
  const recent = attempts
    .map((at) => at.getTime())
    .filter((at) => at > since)
    .sort((a, b) => a - b);
  // The attempt whose expiry brings the count below the limit.
  const decisive = recent[recent.length - maxFailures];
  if (decisive === undefined) return undefined;
  return Math.max(1, Math.ceil((decisive + LOCKOUT.windowMs - now.getTime()) / 1000));
}

/** The longest lock among `keys`, from each key's recent attempts. */
export function longestLock(
  attempts: ReadonlyMap<string, readonly Date[]>,
  keys: readonly string[],
  now: Date,
): number | undefined {
  let longest: number | undefined;
  for (const key of keys) {
    const limit = key.startsWith('ip:') ? LOCKOUT.maxAddressFailures : LOCKOUT.maxFailures;
    const seconds = lockedForSeconds(attempts.get(key) ?? [], now, limit);
    if (seconds !== undefined) longest = Math.max(longest ?? 0, seconds);
  }
  return longest;
}

export type Reservation =
  | { readonly ok: true; readonly attempt: readonly number[] }
  | { readonly ok: false; readonly lockedForSeconds: number };

export interface AttemptStore {
  /**
   * In one step for all `keys`: if any is locked, for how long; otherwise records an attempt for
   * each, which counts as a failure unless `succeeded` forgets it. Forgets every attempt older
   * than the window.
   */
  reserve(keys: readonly string[], now: Date): Promise<Reservation>;
  /** A successful sign-in: forgets this attempt and every failure of `clearKey` (the account). */
  succeeded(attempt: readonly number[], clearKey: string): Promise<void>;
}

export function pgAttemptStore(pool: Pick<pg.Pool, 'connect' | 'query'>): AttemptStore {
  return {
    async reserve(keys, now) {
      const client = await pool.connect();
      let healthy = true;
      // pg-pool listens for errors only on idle clients (see `setup/store.ts`).
      const onError = () => {
        healthy = false;
      };
      client.on('error', onError);
      try {
        await client.query('BEGIN');
        // One lock per key, always taken in the same order so two sign-ins can't deadlock.
        // Concurrent attempts on a key queue here, and each sees the ones before it.
        for (const key of [...new Set(keys)].sort()) {
          await client.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [
            LOCK_CLASSES.authAttempts,
            key,
          ]);
        }
        const windowStart = new Date(now.getTime() - LOCKOUT.windowMs);
        const { rows } = await client.query<{ key: string; attempted_at: Date }>(
          `SELECT key, attempted_at FROM auth_attempts
            WHERE key = ANY($1::text[]) AND attempted_at > $2`,
          [keys, windowStart],
        );
        const byKey = new Map<string, Date[]>();
        for (const row of rows)
          byKey.set(row.key, [...(byKey.get(row.key) ?? []), row.attempted_at]);
        const locked = longestLock(byKey, keys, now);
        if (locked !== undefined) {
          await client.query('ROLLBACK');
          return { ok: false, lockedForSeconds: locked };
        }
        // Pruning here keeps the table to the last 15 minutes without a job (indexed on
        // `attempted_at`, so it doesn't scan the table it is keeping small).
        await client.query('DELETE FROM auth_attempts WHERE attempted_at <= $1', [windowStart]);
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO auth_attempts (key, attempted_at) SELECT unnest($1::text[]), $2
           RETURNING id::text AS id`,
          [keys, now],
        );
        await client.query('COMMIT');
        return { ok: true, attempt: inserted.rows.map((row) => Number(row.id)) };
      } catch (error) {
        healthy = await client.query('ROLLBACK').then(
          () => true,
          () => false,
        );
        throw error;
      } finally {
        client.removeListener('error', onError);
        client.release(!healthy);
      }
    },

    async succeeded(attempt, clearKey) {
      await pool.query('DELETE FROM auth_attempts WHERE id = ANY($1::bigint[]) OR key = $2', [
        attempt,
        clearKey,
      ]);
    },
  };
}
