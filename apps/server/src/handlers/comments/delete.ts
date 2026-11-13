import { commentDelete } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { commentTargetOf, commentWriteContext } from './access.js';
import { deleteComment } from './core.js';

export default handler(commentDelete, (ctx) =>
  deleteComment(commentWriteContext(ctx), commentTargetOf(ctx)),
);
