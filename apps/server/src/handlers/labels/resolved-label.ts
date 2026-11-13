import type { HandlerContext } from '../../executor/context.js';
import { resolved } from '../teams/shared.js';

function scopeOf(row: Record<string, unknown>, what: string): string | null {
  const teamId = row['teamId'];
  if (teamId !== null && typeof teamId !== 'string') {
    throw new Error(`${what} reference is missing teamId`);
  }
  return teamId;
}

/** The label the executor resolved for `label`: its id, name and team (null for the workspace). */
export function resolvedLabel(ctx: HandlerContext): {
  id: string;
  teamId: string | null;
  name?: string;
} {
  const row = resolved(ctx.refs['label'], 'label');
  const name = row['name'];
  return {
    id: row.id,
    teamId: scopeOf(row, 'Label'),
    ...(typeof name === 'string' ? { name } : {}),
  };
}

/** The group the executor resolved for `group`, and the scope it was resolved in. */
export function resolvedGroup(ctx: HandlerContext): { id: string; teamId: string | null } {
  const row = resolved(ctx.refs['group'], 'group');
  return { id: row.id, teamId: scopeOf(row, 'Group') };
}
