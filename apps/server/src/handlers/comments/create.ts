import { commentCreate } from '@surface/operations';
import { uuidv7 } from '../../db/uuidv7.js';
import { handler } from '../../executor/context.js';
import { issueTeamOf } from '../issues/shared.js';
import { commentOutput, commentTargetOf, commentWriteContext } from './access.js';
import { createComment } from './core.js';

export default handler(commentCreate, async (ctx, input) => {
  const row = await createComment(commentWriteContext(ctx), {
    id: input.id ?? uuidv7(),
    issueId: issueTeamOf(ctx).id,
    parentId: input.parent === undefined ? undefined : commentTargetOf(ctx, 'parent').commentId,
    body: input.body,
  });
  return commentOutput(ctx, row);
});
