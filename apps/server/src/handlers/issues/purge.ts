import { issuePurge } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { purgeIssue } from '../../issues/purge.js';
import { lifecycleContext } from './lifecycle-access.js';
import { issueTeamOf } from './shared.js';

/** SPEC-015 §4.5: Deleted → Purged, Admin only (the permission); live or archived is CONFLICT. */
export default handler(issuePurge, async (ctx) => {
  const { access, repo, actor, now, emit } = lifecycleContext(ctx);
  await purgeIssue(
    {
      access,
      tx: ctx.tx,
      files: ctx.files,
      repo,
      actor,
      now,
      emit,
      audit: (...line) => ctx.audit(...line),
    },
    issueTeamOf(ctx).id,
  );
  const output: { readonly purged: true } = { purged: true };
  return output;
});
