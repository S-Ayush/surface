/**
 * Server reference resolution (SPEC-003 §4, executor step 7). Runs inside the executor's
 * transaction so the snapshot matches the handler's. Scopes resolve before the references
 * that use them; invisible rows are `NOT_FOUND`; ambiguous names are `INVALID_INPUT` with
 * candidates.
 */
import type { RefEntity } from '@surface/domain';
import type { AnyOperation, ResolvedRef, ResolvedRefs } from '@surface/operations';
import type { Queryable } from '../../db/pool.js';
import { refPlan, type RefLocation } from './plan.js';
import { lookup, type ResolveActor } from './sources.js';

export { refNotFound, type ResolveActor } from './sources.js';
export { refPlan, RefPlanError, type RefLocation } from './plan.js';

/**
 * Resolves every reference in `input` (already parsed by `def.input`). Fields that are absent
 * or `null` are left out of the result.
 */
export async function resolveRefs(
  def: AnyOperation,
  input: unknown,
  actor: ResolveActor,
  tx: Queryable,
): Promise<ResolvedRefs> {
  const resolved: Record<string, ResolvedRef> = {};
  for (const location of refPlan(def)) {
    const value = valueAt(input, location.path);
    if (value === undefined || value === null) continue;

    const scopeTeam = scopeTeamOf(location, resolved);
    const context = { db: tx, actor, scopeTeam, allowInactive: location.allowInactive };

    if (location.many) {
      if (!Array.isArray(value)) throw new Error(`${def.name}: ${location.key} must be an array`);
      const rows: RefEntity[] = [];
      for (const [index, item] of value.entries()) {
        // Sequential: one connection, and the first failure should be the one reported.
        rows.push(
          await lookup(location.type, item, { ...context, path: [...location.path, index] }),
        );
      }
      resolved[location.key] = rows;
    } else {
      resolved[location.key] = await lookup(location.type, value, {
        ...context,
        path: location.path,
      });
    }
  }
  return resolved;
}

/**
 * The team a scoped reference resolves within: the resolved `TeamRef`, or for an `IssueRef`
 * scope the issue's own team (`{ id, key }`), never a team named elsewhere in the input
 * (SPEC-003 §4, PLAN-011 S4).
 */
export function scopeTeamOf(location: RefLocation, resolved: ResolvedRefs): RefEntity | undefined {
  if (location.scope === undefined) return undefined;
  const scope = single(resolved[location.scope]);
  if (scope === undefined) return undefined;
  if (location.scopeType !== 'IssueRef') return scope;
  const teamId = scope['teamId'];
  const key = scope['teamKey'];
  if (typeof teamId !== 'string' || typeof key !== 'string') {
    throw new Error(`An IssueRef scope must carry teamId and teamKey`);
  }
  return { id: teamId, key };
}

/** The value at a field path of the parsed input. */
export function valueAt(input: unknown, path: RefLocation['path']): unknown {
  let current: unknown = input;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function single(ref: ResolvedRef | undefined): RefEntity | undefined {
  return ref === undefined || isList(ref) ? undefined : ref;
}

function isList(ref: ResolvedRef): ref is readonly RefEntity[] {
  return Array.isArray(ref);
}
