import { commentUpdate } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { commentOutput, commentTargetOf, commentWriteContext } from './access.js';
import { updateComment } from './core.js';

export default handler(commentUpdate, async (ctx, input) => {
  const row = await updateComment(commentWriteContext(ctx), {
    ...commentTargetOf(ctx),
    baseVersion: input.baseVersion,
    body: input.body,
  });
  return commentOutput(ctx, row);
});
