/**
 * API-key narrowing (SPEC-003 §5, permissions.md §3.5). Unit-tested in M0; real keys arrive
 * in M6. The executor runs `keyScopeProblem` at step 3, `narrowToKeyTeams` before resolving,
 * and `refOutsideKeyTeams` right after resolving (step 7).
 */
import { teamGroup, type Actor, type RefEntity, type RefType } from '@surface/domain';
import type { AnyOperation, ResolvedRefs } from '@surface/operations';
import type { RefLocation } from './refs/plan.js';

/** `FORBIDDEN` reason when the key may not run this operation at all, else `undefined`. */
export function keyScopeProblem(def: AnyOperation, actor: Actor): string | undefined {
  const key = actor.apiKey;
  if (key === undefined) return undefined;
  if (key.scope === 'read' && def.kind === 'mutation') {
    return `This API key is read-only, so it can't run ${def.name}. Use a read-write key.`;
  }
  if (def.destructive && !key.allowDestructive) {
    return `This API key can't run destructive operations like ${def.name}. Use a key with "allow destructive" turned on.`;
  }
  return undefined;
}

/**
 * The actor as the key sees it: private-team groups and memberships outside `teamIds` are
 * dropped, so those teams' rows become invisible (`NOT_FOUND`), never `FORBIDDEN`.
 */
export function narrowToKeyTeams(actor: Actor): Actor {
  const teamIds = actor.apiKey?.teamIds;
  if (teamIds === undefined || teamIds.length === 0) return actor;
  const allowedGroups = new Set(teamIds.map(teamGroup));
  return {
    ...actor,
    groups: actor.groups.filter((g) => !g.startsWith('team:') || allowedGroups.has(g)),
    memberOf: actor.memberOf.filter((id) => teamIds.includes(id)),
  };
}

/**
 * Public teams are in the `workspace` group, so narrowing groups can't hide them. This finds
 * the first resolved reference that belongs to a team outside the key's `teamIds`, which the
 * executor reports as `NOT_FOUND` like any other invisible row.
 */
export function refOutsideKeyTeams(
  actor: Actor,
  plan: readonly RefLocation[],
  refs: ResolvedRefs,
): RefLocation | undefined {
  const teamIds = actor.apiKey?.teamIds;
  if (teamIds === undefined || teamIds.length === 0) return undefined;
  return plan.find((location) => {
    const resolved = refs[location.key];
    if (resolved === undefined) return false;
    const rows: readonly RefEntity[] = 'id' in resolved ? [resolved] : resolved;
    return rows.some((row) => {
      const teamId = teamIdOf(location.type, row);
      return teamId !== null && !teamIds.includes(teamId);
    });
  });
}

/** The team a resolved row belongs to, or `null` for workspace-wide rows (users, workspace labels). */
export function teamIdOf(type: RefType, row: RefEntity): string | null {
  switch (type) {
    case 'TeamRef':
      return row.id;
    case 'StatusRef':
    case 'LabelRef':
    case 'CycleRef':
    case 'IssueRef':
      return typeof row.teamId === 'string' ? row.teamId : null;
    case 'UserRef':
    case 'ProjectRef':
    case 'InitiativeRef':
    case 'DocumentRef':
    case 'ViewRef':
      // Projects and documents span teams; their narrowing lands with those entities (M3).
      return null;
  }
}
