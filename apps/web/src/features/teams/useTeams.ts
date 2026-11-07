// Hooks that read the team screens' models from the store and keep them current (app/context's
// useObserved). Rows from another tab or user land as deltas and re-render (AC-12, AC-13).
import { Team, TeamMembership, User } from '@surface/domain/model';
import { useCallback } from 'react';
import { useApp, useObserved } from '../../app/context.js';
import { teamByKey } from '../../app/workspace.js';
import {
  addableUsers,
  browseTeams,
  canEndMembershipOf,
  teamAccess,
  teamMembers,
  type MemberItem,
  type TeamAccess,
  type TeamListItem,
  type TeamRow,
} from './model.js';

/** The store's rows, or `null` while it is not ready to read. */
function useRows() {
  const app = useApp();
  return useCallback(() => {
    const store = app.store;
    const session = app.session;
    if (store === null || store.status !== 'ready' || session === null) return null;
    return {
      me: session.userId,
      teams: store.pool.all(Team),
      memberships: store.pool.all(TeamMembership),
      users: store.pool.all(User),
      actor: app.actor(),
    };
  }, [app]);
}

/** Settings → Teams: every visible team, or `null` while loading. */
export function useBrowseTeams(): TeamListItem[] | null {
  const rows = useRows();
  return useObserved(
    useCallback(() => {
      const r = rows();
      return r === null ? null : browseTeams(r.teams, r.memberships, r.me);
    }, [rows]),
  );
}

export type TeamDetails = {
  readonly team: Omit<TeamRow, '$archived'>;
  readonly members: MemberItem[];
  readonly addable: MemberItem[];
  readonly access: TeamAccess;
  /** The signed-in user is a member. */
  readonly member: boolean;
  /** One more membership may end (E12: not the last member of a private team). */
  readonly canEnd: boolean;
};

/**
 * One team by key (URLs may be lower case), with its members and what the user may do; `null`
 * while loading and `undefined` when no visible team has the key.
 */
export function useTeamDetails(key: string): TeamDetails | null | undefined {
  const rows = useRows();
  return useObserved(
    useCallback(() => {
      const r = rows();
      if (r === null) return null;
      const row = teamByKey(r.teams, key);
      if (row === undefined) return undefined;
      const team = {
        id: row.id,
        key: row.key,
        name: row.name,
        icon: row.icon,
        color: row.color,
        timezone: row.timezone,
        private: row.private,
      };
      const members = teamMembers(team.id, r.memberships, r.users);
      return {
        team,
        members,
        addable: addableUsers(team.id, r.memberships, r.users),
        access: teamAccess(r.actor, team),
        // From memberships, as Settings → Teams counts them (browseTeams).
        member: r.memberships.some(
          (m) => m.teamId === team.id && m.userId === r.me && m.$archived !== true,
        ),
        canEnd: canEndMembershipOf(team, r.memberships),
      };
    }, [rows, key]),
  );
}
