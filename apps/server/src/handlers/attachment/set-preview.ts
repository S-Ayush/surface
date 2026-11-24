import { attachmentSetPreview } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { attachmentOutput, attachmentTargetOf, attachmentWriteContext } from './access.js';
import { setAttachmentPreview } from './core.js';

export default handler(attachmentSetPreview, async (ctx, input) => {
  const row = await setAttachmentPreview(
    attachmentWriteContext(ctx),
    attachmentTargetOf(ctx, input.attachment),
    input.previewFile,
  );
  return attachmentOutput(ctx, row);
});
