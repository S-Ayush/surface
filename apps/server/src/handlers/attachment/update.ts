import { attachmentUpdate } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { attachmentOutput, attachmentTargetOf, attachmentWriteContext } from './access.js';
import { renameAttachment } from './core.js';

export default handler(attachmentUpdate, async (ctx, input) => {
  const row = await renameAttachment(
    attachmentWriteContext(ctx),
    attachmentTargetOf(ctx, input.attachment),
    input.title,
  );
  return attachmentOutput(ctx, row);
});
