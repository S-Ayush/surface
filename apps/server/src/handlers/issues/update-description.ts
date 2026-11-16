import { issueUpdateDescription } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { identifierOf } from '../../issues/lifecycle.js';
import { issueWriteContext } from './access.js';
import { descriptionDoc, updateDescription } from './core.js';
import { issueTeamOf } from './shared.js';

/**
 * `issue.updateDescription` (SPEC-011 §3.3, §6.1). The document is converted and validated before
 * the issue lock, so no lock is held while a 200 KB text is parsed.
 */
export default handler(issueUpdateDescription, async (ctx, input) => {
  const description = descriptionDoc(input.description);
  const { row, version } = await updateDescription(issueWriteContext(ctx), {
    issueId: issueTeamOf(ctx).id,
    baseVersion: input.baseVersion,
    description,
  });
  return { issue: { id: row.id, identifier: await identifierOf(ctx.tx, row) }, version };
});
