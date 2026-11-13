/** `comment.resolve` and `comment.reopen` (SPEC-013 §4.3): both answer the thread's root. */
import { commentReopen, commentResolve } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { commentOutput, commentTargetOf, commentWriteContext } from './access.js';
import { setThreadResolved } from './core.js';

export const resolveHandler = handler(commentResolve, async (ctx) => {
  const row = await setThreadResolved(commentWriteContext(ctx), commentTargetOf(ctx), true);
  return commentOutput(ctx, row);
});

export const reopenHandler = handler(commentReopen, async (ctx) => {
  const row = await setThreadResolved(commentWriteContext(ctx), commentTargetOf(ctx), false);
  return commentOutput(ctx, row);
});
