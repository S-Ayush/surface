import { labelDelete } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { labelAccess, labelOutput } from './access.js';
import { deleteLabel } from './core.js';
import { resolvedLabel } from './resolved-label.js';

export default handler(labelDelete, async (ctx, input) => {
  const { label, removedFromIssues } = await deleteLabel(labelAccess(ctx), ctx.repo, {
    teamRef: input.team,
    label: resolvedLabel(ctx),
  });
  return { label: labelOutput(label), removedFromIssues };
});
