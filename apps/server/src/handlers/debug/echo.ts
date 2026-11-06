import { debugEcho } from '@surface/operations';
import { handler } from '../../executor/context.js';

export default handler(debugEcho, (ctx, input) =>
  Promise.resolve({ text: input.text, actorKind: ctx.actor.kind }),
);
