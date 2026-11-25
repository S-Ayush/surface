// Command-menu entries for the team operations (SPEC-005 §4.1; session C's handoff, PLAN-005 S6).
// `team.create` opens the create-team form, which TeamsHost answers (features/hosts.ts). "Rename
// team…" (`team.update`) opens the team's General settings, where its rename form is: the menu's
// pages are lists, with no text field. "Leave team…" asks first, as a page with one choice, as
// leaving does everywhere else for a private team; "Remove member…" is a page of the team's
// members. Both predict their effect (`store.find`, PLAN-001 S8 follow-up).
import { Team, TeamMembership, User } from '@surface/domain/model';
import { teamJoin, teamLeave, teamRemoveMember } from '@surface/operations';
import { toast } from '@surface/ui';
import type { CommandContext, CommandPage } from '../../command-menu/model.js';
import type { OperationCommand } from '../../command-menu/sources/operations.js';
import { canEndMembershipOf, LAST_PRIVATE_MEMBER, teamMembers } from './model.js';
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

/** The focused team with its members, read from the replica when the page shows. */
function focusedTeam(ctx: CommandContext) {
  const id = targetTeamId(ctx);
  const store = ctx.store;
  const team = id === undefined || store === null ? undefined : store.pool.get(Team, id);
  if (store === null || team === undefined) return undefined;
  const memberships = store.pool.all(TeamMembership);
  return {
    team,
    store,
    members: teamMembers(team.id, memberships, store.pool.all(User)),
    canEnd: canEndMembershipOf(team, memberships),
  };
}

/** Leave the focused team, once chosen: the page is the "are you sure" step. */
function leavePage(ctx: CommandContext): CommandPage {
  const found = focusedTeam(ctx);
  const name = found?.team.name ?? 'this team';
  const me = ctx.actor?.userId;
  const member = found?.members.some((m) => m.id === me) === true;
  return {
    title: `Leave ${name}`,
    empty: !member
      ? 'You’re not a member of this team.'
      : found?.canEnd === false
        ? LAST_PRIVATE_MEMBER
        : undefined,
    items: () => {
      if (found === undefined || !member || !found.canEnd) return [];
      const { team, store } = found;
      return [
        {
          id: 'leave',
          // Private: only a member can add you back (useLeaveTeam asks the same).
          title: team.private
            ? `Leave ${team.key}: only a member can add you back`
            : `Leave ${team.key}`,
          run: async () => {
            // A server refusal is the shell's toast; a change the store didn't take isn't.
            toastIfFailed(await submitMutation(store, teamLeave, { team: team.id }));
          },
        },
      ];
    },
  };
}

/** Remove one of the focused team's members. */
function removePage(ctx: CommandContext): CommandPage {
  const found = focusedTeam(ctx);
  return {
    title: 'Remove member',
    placeholder: 'Find a member…',
    empty: found?.canEnd === false ? LAST_PRIVATE_MEMBER : 'This team has no members.',
    items: () => {
      if (found === undefined || !found.canEnd) return [];
      const { team, store, members } = found;
      return members.map((member) => ({
        id: member.id,
        title: member.name,
        keywords: [member.displayName, member.email],
        run: async () => {
          toastIfFailed(
            await submitMutation(store, teamRemoveMember, { team: team.id, user: member.id }),
          );
        },
      }));
    },
  };
}

export const TEAM_COMMANDS: Readonly<Record<string, OperationCommand>> = {
  'team.create': { opens: 'form:create-team' },
  // Team administration is reached by typing, not pre-suggested (SPEC-005 §4.2).
  'team.join': { suggest: false, refs: targetTeamRefs, run: (ctx) => join(ctx) },
  'team.leave': { suggest: false, refs: targetTeamRefs, page: (ctx) => leavePage(ctx) },
  'team.removeMember': { suggest: false, refs: targetTeamRefs, page: (ctx) => removePage(ctx) },
  'team.update': { suggest: false, refs: targetTeamRefs, run: (ctx) => rename(ctx) },
};
