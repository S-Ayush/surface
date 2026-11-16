import { issueAutoArchive } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { issueOutput } from './access.js';
import { autoContext } from './auto-access.js';
import { autoArchiveIssue } from './auto-core.js';
import { issueTeamOf } from './shared.js';

/** SPEC-015 §6.3: Live → Archived for a closed issue past its team's period; else CONFLICT. */
export default handler(issueAutoArchive, async (ctx) => {
  const target = issueTeamOf(ctx);
  const row = await autoArchiveIssue(autoContext(ctx), {
    issueId: target.id,
    teamId: target.teamId,
  });
  return issueOutput(ctx, row);
});
