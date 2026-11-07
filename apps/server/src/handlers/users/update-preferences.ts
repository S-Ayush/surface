// `user.updatePreferences` (SPEC-005 §6, PLAN-005 S7): the actor's own `UserPreferences` row.
import {
  mergePreferences,
  readPreferences,
  userUpdatePreferences,
  type Preferences,
} from '@surface/operations';
import { eq } from 'drizzle-orm';
import { users } from '../../db/schema/index.js';
import { handler } from '../../executor/context.js';
import { SurfaceError } from '../../executor/errors.js';
import { single } from '../../executor/refs/resolve.js';

export default handler(userUpdatePreferences, async (ctx, input) => {
  const userId = ctx.actor.userId;
  if (userId === undefined) {
    throw new SurfaceError('FORBIDDEN', 'Only a signed-in person has preferences.');
  }
  // Read, merge, write: two changes at once (two tabs) would otherwise each keep only their own
  // field. The user row always exists, so it also covers creating a missing preferences row.
  await ctx.tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .for('no key update');

  const changes: Partial<Preferences> = {
    ...(input.theme === undefined ? {} : { theme: input.theme }),
    ...(input.fontSize === undefined ? {} : { fontSize: input.fontSize }),
    // Resolved and visibility-checked by the executor (a hidden team is NOT_FOUND).
    ...(input.homeTeam === undefined
      ? {}
      : { homeTeamId: input.homeTeam === null ? null : homeTeamId(single(ctx.refs['homeTeam'])) }),
  };
  const row = await ctx.query.get('UserPreferences', userId);
  const values = mergePreferences(row?.values, changes);
  if (row === undefined) {
    // Setup creates the first Admin's row; anyone else gets theirs on their first change.
    await ctx.repo.insert('UserPreferences', { id: userId, values, syncGroups: [] });
  } else if (JSON.stringify(values) !== JSON.stringify(row.values)) {
    await ctx.repo.update('UserPreferences', userId, { values });
  }
  return readPreferences(values);
});

function homeTeamId(team: { readonly id: string } | undefined): string {
  if (team === undefined) throw new Error('homeTeam was not resolved');
  return team.id;
}
