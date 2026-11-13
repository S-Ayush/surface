import { issueGet } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { refNotFound } from '../../executor/refs/sources.js';
import { resolved } from '../teams/shared.js';
import { issueOutput } from './access.js';

/** Any lifecycle state: archived and deleted issues are read-only, not hidden (§6.1). */
export default handler(issueGet, async (ctx, input) => {
  const row = await ctx.query.get('Issue', resolved(ctx.refs['issue'], 'issue').id);
  if (row === undefined) throw refNotFound('IssueRef', input.issue, ['issue']);
  return issueOutput(ctx.tx, row);
});
