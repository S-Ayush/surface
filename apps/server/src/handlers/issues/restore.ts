import { issueRestore } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { issueOutput } from './access.js';
import { lifecycleContext } from './lifecycle-access.js';
import { restoreIssue } from './lifecycle-core.js';
import { issueTeamOf } from './shared.js';

/** SPEC-015 §4.2: Archived or Deleted → Live (before `purgeAfter`); a live issue is a no-op. */
export default handler(issueRestore, async (ctx) => {
  const { row } = await restoreIssue(lifecycleContext(ctx), issueTeamOf(ctx).id);
  return issueOutput(ctx, row);
});
