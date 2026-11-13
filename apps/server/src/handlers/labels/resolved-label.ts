import type { HandlerContext } from '../../executor/context.js';
import { resolved } from '../teams/shared.js';

/** The label the executor resolved for `label`: its id, and its team (null for the workspace). */
export function resolvedLabel(ctx: HandlerContext): { id: string; teamId: string | null } {
  const row = resolved(ctx.refs['label'], 'label');
  const teamId = row['teamId'];
  if (teamId !== null && typeof teamId !== 'string') {
    throw new Error('Label reference is missing teamId');
  }
  return { id: row.id, teamId };
}
