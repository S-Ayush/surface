import { attachmentCreateFile } from '@surface/operations';
import { uuidv7 } from '../../db/uuidv7.js';
import { handler } from '../../executor/context.js';
import { issueTeamOf } from '../issues/shared.js';
import { resolved } from '../teams/shared.js';
import { attachmentOutput, attachmentWriteContext } from './access.js';
import { createFileAttachment, creatorIdOf } from './core.js';

// SPEC-014 §6.2: `upload` is the client's own echo of the upload's answer; the server ignores it
// and copies the stored file's facts (D29).
export default handler(attachmentCreateFile, async (ctx, input) => {
  const row = await createFileAttachment(attachmentWriteContext(ctx), {
    id: input.id ?? uuidv7(),
    issueId: issueTeamOf(ctx).id,
    fileRef: input.file,
    fileId: resolved(ctx.refs['file'], 'file').id,
    title: input.title,
    creatorId: creatorIdOf(ctx.actor),
  });
  return attachmentOutput(ctx, row);
});
