import { attachmentCreateLink } from '@surface/operations';
import { uuidv7 } from '../../db/uuidv7.js';
import { handler } from '../../executor/context.js';
import { issueTeamOf } from '../issues/shared.js';
import { attachmentOutput, attachmentWriteContext } from './access.js';
import { createLinkAttachment, creatorIdOf } from './core.js';

export default handler(attachmentCreateLink, async (ctx, input) => {
  const row = await createLinkAttachment(attachmentWriteContext(ctx), {
    id: input.id ?? uuidv7(),
    issueId: issueTeamOf(ctx).id,
    url: input.url,
    title: input.title,
    creatorId: creatorIdOf(ctx.actor),
  });
  return attachmentOutput(ctx, row);
});
