import { purgeAfter } from '@surface/domain';
import { issueDelete } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { issueOutput } from './access.js';
import { lifecycleContext } from './lifecycle-access.js';
import { deleteIssue } from './lifecycle-core.js';
import { issueTeamOf } from './shared.js';

/** SPEC-015 §4.2: Live or Archived → Deleted; a deleted issue is a no-op. */
export default handler(issueDelete, async (ctx) => {
  const { row } = await deleteIssue(lifecycleContext(ctx), issueTeamOf(ctx).id);
  // Set by this delete, or by the earlier one a no-op found.
  if (row.deletedAt === null) throw new Error(`Issue ${row.id} is not deleted after issue.delete`);
  return {
    issue: await issueOutput(ctx, row),
    purgeAfter: purgeAfter(row.deletedAt).toISOString(),
  };
});
