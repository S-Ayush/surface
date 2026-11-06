/**
 * Rate limiting hook (SPEC-003 §6 step 4, §9). PLAN-003 S6 provides the in-memory token
 * bucket with the SPEC-003 defaults; the executor only depends on this interface.
 */
import type { Actor } from '@surface/domain';
import type { OperationKind } from '@surface/operations';

export type RateDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

export interface RateLimiter {
  take(actor: Actor, kind: OperationKind): RateDecision;
}

export const unlimited: RateLimiter = { take: () => ({ allowed: true }) };
