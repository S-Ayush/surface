// The team ⋯ menu (SPEC-001 §3.7): "Join team" for a non-member, "Leave team" for a member, and the
// team's settings. Mounted by the shell in the team page header (features/hosts.ts TEAM_MENU).
// The last member of a private team can't leave (E12, D3).
import { teamJoin } from '@surface/operations';
import { IconButton, Menu, type MenuEntry } from '@surface/ui';
import { useNavigate } from '@tanstack/react-router';
import { MoreHorizontal } from 'lucide-react';
import { useApp } from '../../app/context.js';
import { submitMutation, toastIfFailed } from './submit.js';
import { useLeaveTeam } from './useLeaveTeam.js';
import { useTeamDetails } from './useTeams.js';

/** The team the menu is for, as the shell passes it. */
export type TeamMenuProps = {
  readonly team: { readonly id: string; readonly key: string; readonly name: string };
};

/** Menu items carry no description, so a blocked Leave says why in its label (E12). */
export const LEAVE_BLOCKED_LABEL = 'Leave team (add a member first)';

/** The menu's items, for a member or not, and whether this member may leave (E12). */
export function teamMenuItems(
  state: { readonly member: boolean; readonly canEnd: boolean },
  actions: { readonly join: () => void; readonly leave: () => void; readonly settings: () => void },
): MenuEntry[] {
  return [
    state.member
      ? {
          type: 'item',
          label: state.canEnd ? 'Leave team' : LEAVE_BLOCKED_LABEL,
          disabled: !state.canEnd,
          onSelect: actions.leave,
        }
      : { type: 'item', label: 'Join team', onSelect: actions.join },
    { type: 'item', label: 'Team settings', onSelect: actions.settings },
  ];
}

export function TeamMenu({ team }: TeamMenuProps) {
  const app = useApp();
  const navigate = useNavigate();
  const details = useTeamDetails(team.key);
  const leaving = useLeaveTeam({
    key: team.key,
    name: team.name,
    private: details?.team.private ?? false,
  });
  if (details === null || details === undefined) return null;

  const join = async () => {
    const store = app.store;
    if (store === null) return;
    // A server refusal is the shell's toast (SPEC-002 §3.5); a change the store didn't take isn't.
    toastIfFailed(await submitMutation(store, teamJoin, { team: team.key }));
  };

  return (
    <>
      <Menu
        align="end"
        trigger={
          <IconButton aria-label={`${team.name} options`} icon={<MoreHorizontal />} size="sm" />
        }
        items={teamMenuItems(details, {
          join: () => void join(),
          leave: leaving.leave,
          settings: () =>
            void navigate({ to: '/settings/teams/$key/general', params: { key: team.key } }),
        })}
      />
      {leaving.dialog}
    </>
  );
}
