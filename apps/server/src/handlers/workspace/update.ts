import { workspaceUpdate } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { theWorkspace, workspaceOutput } from './shared.js';

// SPEC-001 §3.6: Settings → Workspace (the executor checked `p.admin()`). The name syncs to every
// client, where the sidebar and the browser tab show it.
export default handler(workspaceUpdate, async (ctx, input) => {
  const current = await theWorkspace(ctx);
  if (input.name === current.name) return workspaceOutput(current);
  const updated = await ctx.repo.update('Workspace', current.id, { name: input.name });
  ctx.emit({
    type: 'workspace.updated',
    subject: { type: 'workspace', id: current.id },
    changes: { name: { from: current.name, to: input.name } },
  });
  return workspaceOutput(updated);
});
