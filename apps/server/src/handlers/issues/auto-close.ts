import { issueAutoClose } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { issueOutput } from './access.js';
import { autoContext } from './auto-access.js';
import { autoCloseIssue } from './auto-core.js';
import { issueTeamOf } from './shared.js';

/** SPEC-015 §6.3: a stale live issue → the team's auto-close status; else CONFLICT. */
export default handler(issueAutoClose, async (ctx) => {
  const target = issueTeamOf(ctx);
  const row = await autoCloseIssue(autoContext(ctx), { issueId: target.id, teamId: target.teamId });
  return issueOutput(ctx, row);
});
