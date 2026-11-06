/**
 * Rate limiting (SPEC-003 §6 step 4, §9). The executor depends only on `RateLimiter`;
 * `tokenBucket` is the in-memory implementation for a single process. Several replicas would
 * each allow the full rate; a Postgres-backed limiter can implement the same interface then.
 */
import type { Actor } from '@surface/domain';
import type { OperationKind } from '@surface/operations';

export type RateDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface RateLimiter {
  take(actor: Actor, kind: OperationKind): RateDecision;
}

export const unlimited: RateLimiter = { take: () => ({ allowed: true }) };

/** Requests per minute per actor (SPEC-003 §9 defaults). */
export interface RateLimits {
  readonly queriesPerMinute: number;
  readonly mutationsPerMinute: number;
}

export const DEFAULT_RATE_LIMITS: RateLimits = { queriesPerMinute: 600, mutationsPerMinute: 120 };

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/** Buckets idle this long are full again, so they can be forgotten. */
const IDLE_MS = 60_000;

/**
 * One bucket per actor and kind, holding a minute's allowance and refilling continuously, so
 * bursts up to the per-minute limit pass. Session users are exempt from the query limit
 * (§9: the app issues many small reads); the system actor is never limited.
 */
export function tokenBucket(
  limits: RateLimits = DEFAULT_RATE_LIMITS,
  clock: () => number = Date.now,
): RateLimiter {
  const buckets = new Map<string, Bucket>();
  let lastSweep = clock();

  const sweep = (now: number) => {
    if (now - lastSweep < IDLE_MS) return;
    lastSweep = now;
    for (const [key, bucket] of buckets) {
      if (now - bucket.updatedAt >= IDLE_MS) buckets.delete(key);
    }
  };

  return {
    take(actor, kind) {
      if (actor.kind === 'system') return { allowed: true };
      if (kind === 'query' && actor.kind === 'user') return { allowed: true };
      const capacity = kind === 'query' ? limits.queriesPerMinute : limits.mutationsPerMinute;
      const perMs = capacity / 60_000;
      const now = clock();
      sweep(now);

      // Keys limit per key, so one user's scripts don't starve their browser session.
      const who = actor.apiKey?.id ?? actor.userId ?? 'anonymous';
      const key = `${kind}:${actor.kind}:${who}`;
      const bucket = buckets.get(key) ?? { tokens: capacity, updatedAt: now };
      bucket.tokens = Math.min(capacity, bucket.tokens + (now - bucket.updatedAt) * perMs);
      bucket.updatedAt = now;
      buckets.set(key, bucket);

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return { allowed: true };
      }
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((1 - bucket.tokens) / perMs / 1000)),
      };
    },
  };
}
