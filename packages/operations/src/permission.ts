import {
  bindPredicates,
  type Actor,
  type PermissionPredicates,
  type RefEntity,
  type ResolvedRef,
  type ResolvedRefs,
} from '@surface/domain';
import type { AnyOperation } from './define.js';

// Defined in `@surface/domain` so the client store and the server share them.
export type { PermissionPredicates, RefEntity, ResolvedRef, ResolvedRefs };

export type PermissionResult =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/**
 * Runs an operation's `permission` predicate for an actor (SPEC-003 §5, executor step 8) and
 * builds the `FORBIDDEN` reason from who would have been allowed and the operation's summary:
 * "Only Admins or members of Engineering can update a team's name…".
 */
export function evaluatePermission(
  def: AnyOperation,
  actor: Actor,
  refs: ResolvedRefs,
  input: unknown,
): PermissionResult {
  const bound = bindPredicates(actor);
  if (def.permission(bound.p, refs, input)) return { allowed: true };
  return {
    allowed: false,
    reason: bound.reason() ?? forbiddenReason(bound.allowedWho(), def.summary),
  };
}

export function forbiddenReason(allowedWho: readonly string[], summary: string): string {
  const action = summary.charAt(0).toLowerCase() + summary.slice(1).replace(/\.$/, '');
  if (allowedWho.length === 0) return `You don't have permission to ${action}.`;
  return `Only ${joinOr(allowedWho)} can ${action}.`;
}

function joinOr(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${items.at(-1) ?? ''}`;
}
