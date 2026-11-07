import { suggestTeamKey } from '@surface/domain';
import { teamSuggestKey } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { takenKeys } from './shared.js';

export default handler(teamSuggestKey, async (ctx, input) => {
  const taken = await takenKeys(ctx.tx);
  return { key: suggestTeamKey(input.name, (key) => taken.has(key)) ?? null };
});
