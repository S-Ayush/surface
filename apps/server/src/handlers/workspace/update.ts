import { workspaceUpdate } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { SurfaceError } from '../../executor/errors.js';
import { refNotFound } from '../../executor/refs/sources.js';
import { resolved } from '../teams/shared.js';
import { theWorkspace, workspaceOutput } from './shared.js';

// SPEC-001 §3.6: Settings → Workspace (the executor checked `p.admin()`). The name and the logo
// sync to every client, where the sidebar and the browser tab show them. The logo is a file
// uploaded with `POST /files/upload?purpose=logo` (PLAN-001 S6), resolved by the executor (FileRef).
export default handler(workspaceUpdate, async (ctx, input) => {
  const current = await theWorkspace(ctx);
  const changes: { name?: string; logoFileId?: string | null } = {};
  if (input.name !== undefined && input.name !== current.name) changes.name = input.name;
  if (input.logo === null && current.logoFileId !== null) changes.logoFileId = null;
  if (input.logo !== undefined && input.logo !== null) {
    // Any file the actor can see resolves (SPEC-014 §4.2); only their own upload or the current
    // logo may be set, so another user's file is never pinned by the RESTRICT key. Anything else
    // answers like an unknown id (SPEC-003 §4).
    const file = resolved(ctx.refs['logo'], 'logo');
    if (file.id !== current.logoFileId) {
      if (ctx.actor.userId === undefined || file['uploaderId'] !== ctx.actor.userId) {
        throw refNotFound('FileRef', input.logo, ['logo']);
      }
      if (file['purpose'] !== 'logo') {
        const message = 'That file isn’t a logo. Upload it again as the logo.';
        throw new SurfaceError('INVALID_INPUT', message, { issues: [{ path: ['logo'], message }] });
      }
      changes.logoFileId = file.id;
    }
  }
  if (changes.name === undefined && changes.logoFileId === undefined) {
    return workspaceOutput(current);
  }
  const updated = await ctx.repo.update('Workspace', current.id, changes);
  ctx.emit({
    type: 'workspace.updated',
    subject: { type: 'workspace', id: current.id },
    changes: {
      ...(changes.name === undefined ? {} : { name: { from: current.name, to: changes.name } }),
      ...(changes.logoFileId === undefined
        ? {}
        : { logoFileId: { from: current.logoFileId, to: changes.logoFileId } }),
    },
  });
  return workspaceOutput(updated);
});
