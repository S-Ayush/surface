/** The workspace handlers' shared reads (PLAN-001 S7). */
import type { WorkspaceSchema } from '@surface/operations';
import type { z } from 'zod';
import { workspace } from '../../db/schema/index.js';
import type { HandlerContext } from '../../executor/context.js';
import { SurfaceError } from '../../executor/errors.js';
import type { ModelRow } from '../../sync/models.js';

export function workspaceOutput(row: ModelRow<'Workspace'>): z.input<typeof WorkspaceSchema> {
  return {
    id: row.id,
    name: row.name,
    logoFileId: row.logoFileId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The workspace (INV-01: exactly one), read with the actor's visibility. Operations run only
 * after setup, which creates it, so a missing one is a server fault.
 */
export async function theWorkspace(ctx: HandlerContext): Promise<ModelRow<'Workspace'>> {
  const [row] = await ctx.tx.select({ id: workspace.id }).from(workspace).limit(1);
  const found = row && (await ctx.query.get('Workspace', row.id));
  if (!found) throw new SurfaceError('INTERNAL', 'The workspace is missing.');
  return found;
}
