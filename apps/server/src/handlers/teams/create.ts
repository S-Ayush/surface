import { NEW_TEAM_SETTINGS, suggestTeamKey } from '@surface/domain';
import { teamCreate } from '@surface/operations';
import { uuidv7 } from '../../db/uuidv7.js';
import { handler } from '../../executor/context.js';
import { SurfaceError } from '../../executor/errors.js';
import { seedTeamWorkflow, teamWorkflow } from './seed.js';
import {
  insertMembership,
  isUniqueViolation,
  keyProblem,
  takenKeys,
  teamOutput,
} from './shared.js';

export default handler(teamCreate, async (ctx, input) => {
  // INV-03 here rather than in the input schema, so every bad key gets the next free
  // suggestion (E11), and a taken key is a sentence, not a constraint name.
  const taken = await takenKeys(ctx.tx);
  const key = input.key ?? suggestTeamKey(input.name, (k) => taken.has(k));
  if (key === undefined) {
    const message = `No key could be made from "${input.name}". Pass a key: 2–5 capital letters, like ENG.`;
    throw new SurfaceError('INVALID_INPUT', message, { issues: [{ path: ['key'], message }] });
  }
  const problem = keyProblem(key, input.name, taken);
  if (problem) throw problem;

  const { userId } = ctx.actor;
  const creator = userId === undefined ? undefined : await ctx.query.get('User', userId);
  const id = input.id ?? uuidv7();
  // INV-05: the team points at its Backlog status, inserted next (the foreign key is deferred).
  const workflow = teamWorkflow(id);
  let team;
  try {
    team = await ctx.repo.insert('Team', {
      ...NEW_TEAM_SETTINGS,
      id,
      key,
      name: input.name,
      icon: input.icon ?? null,
      color: input.color ?? NEW_TEAM_SETTINGS.color,
      timezone: input.timezone ?? creator?.timezone ?? NEW_TEAM_SETTINGS.timezone,
      defaultStatusId: workflow.defaultStatusId,
    });
  } catch (error) {
    // Another team took the key since we looked.
    if (isUniqueViolation(error, 'teams_key_idx')) {
      throw keyProblem(key, input.name, new Set([...taken, key])) ?? error;
    }
    throw error;
  }
  await seedTeamWorkflow(ctx.repo, workflow);
  ctx.emit({ type: 'team.created', subject: { type: 'team', id }, data: { key } });
  // SPEC-001 §3.7: the creator becomes a member. The system actor belongs to no team.
  if (userId !== undefined) await insertMembership(ctx, id, userId);
  return teamOutput(team);
});
