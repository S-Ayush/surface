import { attachmentDelete } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { attachmentTargetOf, attachmentWriteContext } from './access.js';
import { deleteAttachment } from './core.js';

export default handler(attachmentDelete, async (ctx, input) => {
  const row = await deleteAttachment(
    attachmentWriteContext(ctx),
    attachmentTargetOf(ctx, input.attachment),
  );
  return { attachment: row.id };
});
