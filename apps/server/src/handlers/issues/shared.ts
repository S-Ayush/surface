/** Helpers the issue handlers share: resolved references as ids. */
import type { RefEntity, ResolvedRef } from '@surface/domain';
import type { HandlerContext } from '../../executor/context.js';
import { SurfaceError } from '../../executor/errors.js';
import { resolved } from '../teams/shared.js';

/** The ids of a list of references the executor resolved, in input order (none when absent). */
export function resolvedIds(ref: ResolvedRef | undefined): string[] {
  if (ref === undefined) return [];
  if ('id' in ref) throw new Error('Expected a list of references');
  return ref.map((row: RefEntity) => row.id);
}

/** The id of an optional single reference, or undefined when the input left it out. */
export function optionalId(ctx: HandlerContext, field: string): string | undefined {
  const ref = ctx.refs[field];
  return ref === undefined ? undefined : resolved(ref, field).id;
}

/**
 * The issue's creator: the actor, or for `api`/`mcp` the key's owner (SPEC-011 §4.1). Never
 * null, so an actor without a user (the system) can't create issues until a path for it exists.
 */
export function creatorOf(ctx: HandlerContext): string {
  const { userId } = ctx.actor;
  if (userId === undefined) {
    throw new SurfaceError('FORBIDDEN', 'Only a signed-in user or an API key can create issues.');
  }
  return userId;
}

/** The issue's team, from the resolved `IssueRef` (`teamId` and `teamKey`). */
export function issueTeamOf(ctx: HandlerContext): { readonly id: string; readonly teamId: string } {
  const row = resolved(ctx.refs['issue'], 'issue');
  const teamId = row['teamId'];
  if (typeof teamId !== 'string') throw new Error('Issue reference is missing teamId');
  return { id: row.id, teamId };
}
