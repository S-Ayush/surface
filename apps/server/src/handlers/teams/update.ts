import { teamUpdate } from '@surface/operations';
import { handler } from '../../executor/context.js';
import { refNotFound } from '../../executor/refs/sources.js';
import type { ModelPatch } from '../../sync/models.js';
import { teamOutput, teamRef } from './shared.js';

export default handler(teamUpdate, async (ctx, input) => {
  const ref = teamRef(ctx.refs['team']);
  const team = await ctx.query.get('Team', ref.id);
  // Resolved and visible at step 7; gone only if archived or deleted since. Same words as the
  // resolver's, so a vanished team reads like any unknown one (permissions.md §5).
  if (!team) throw refNotFound('TeamRef', input.team, ['team']);

  // Only what differs is written and reported (events.md `changes`).
  const patch: ModelPatch<'Team'> = {};
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (input.name !== undefined && input.name !== team.name) {
    patch.name = input.name;
    changes['name'] = { from: team.name, to: input.name };
  }
  if (input.icon !== undefined && input.icon !== team.icon) {
    patch.icon = input.icon;
    changes['icon'] = { from: team.icon, to: input.icon };
  }
  if (input.color !== undefined && input.color !== team.color) {
    patch.color = input.color;
    changes['color'] = { from: team.color, to: input.color };
  }
  if (input.timezone !== undefined && input.timezone !== team.timezone) {
    patch.timezone = input.timezone;
    changes['timezone'] = { from: team.timezone, to: input.timezone };
  }
  if (Object.keys(changes).length === 0) return teamOutput(team);

  const updated = await ctx.repo.update('Team', team.id, patch);
  ctx.emit({ type: 'team.updated', subject: { type: 'team', id: team.id }, changes });
  return teamOutput(updated);
});
