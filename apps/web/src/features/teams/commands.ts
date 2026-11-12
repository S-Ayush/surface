// Command-menu entries for the team operations (SPEC-005 §4.1; session C's handoff, PLAN-005 S6).
// `team.create` opens the create-team form, which TeamsHost answers (features/hosts.ts). "Rename
// team…" (`team.update`) opens the team's General settings, where its rename form is: the menu's
// pages are lists, with no text field. `team.leave` and `team.removeMember` get `ui` once they can
// predict their effect (lint rule 3; SPEC-001 D6).
import { Team } from '@surface/domain/model';
import { teamJoin } from '@surface/operations';
import { toast } from '@surface/ui';
import type { CommandContext } from '../../command-menu/model.js';
import type { OperationCommand } from '../../command-menu/sources/operations.js';
import { submitMutation, toastIfFailed } from './submit.js';

/** The team a command acts on: the focused team (a team page's context chip). */
const targetTeamId = ({ target }: CommandContext): string | undefined =>
  target.kind === 'team' ? target.ids[0] : undefined;

/** The focused team as the permission pre-check needs it. */
function targetTeamRefs(ctx: CommandContext) {
  const id = targetTeamId(ctx);
  return id === undefined ? {} : { team: { id } };
}

/** Open the focused team's General settings. Its key comes from the replica, not the label. */
function rename(ctx: CommandContext): void {
  const id = targetTeamId(ctx);
  const team = id === undefined ? undefined : ctx.store?.pool.get(Team, id);
  if (team === undefined) return;
  ctx.navigate?.(`/settings/teams/${encodeURIComponent(team.key)}/general`);
}

/** Join the focused team. */
async function join(ctx: CommandContext): Promise<void> {
  const id = targetTeamId(ctx);
  if (id === undefined || ctx.store === null) return;
  // The menu lists Join on every team page: an operation entry has no `when` of its own yet
  // (handoff to session C). Until then, joining a team you're in says so instead of doing nothing.
  const mine = ctx.teams().find((team) => team.id === id);
  if (mine !== undefined) {
    toast({ message: `You're already a member of ${mine.key}.` });
    return;
  }
  // A server refusal is the shell's toast (SPEC-002 §3.5); a change the store didn't take isn't.
  toastIfFailed(await submitMutation(ctx.store, teamJoin, { team: id }));
}

export const TEAM_COMMANDS: Readonly<Record<string, OperationCommand>> = {
  'team.create': { opens: 'form:create-team' },
  'team.join': { refs: targetTeamRefs, run: (ctx) => join(ctx) },
  'team.update': { refs: targetTeamRefs, run: (ctx) => rename(ctx) },
};
