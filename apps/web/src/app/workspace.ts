// Read models for the shell, as plain functions over rows: the store's instances (MobX-backed)
// fit these shapes, so reading them inside a component or reaction tracks exactly what is used.
import { userActor, type Actor, type UserRole } from '@surface/domain';
import type { TeamSummary } from '../command-menu/model.js';

type Live = { readonly $archived?: boolean };
export type TeamRow = Live & {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly private: boolean;
};
export type MembershipRow = Live & { readonly teamId: string; readonly userId: string };
export type UserRow = Live & {
  readonly id: string;
  readonly role: UserRole;
  readonly active: boolean;
};

const live = <T extends Live>(rows: readonly T[]) => rows.filter((row) => row.$archived !== true);

/**
 * The user's teams in sidebar order. M0 has no stored order (drag to reorder is M2), so teams sort
 * by name, then key: stable for everyone and on every device.
 */
export function myTeams(
  teams: readonly TeamRow[],
  memberships: readonly MembershipRow[],
  userId: string,
): TeamSummary[] {
  const mine = new Set(
    live(memberships)
      .filter((membership) => membership.userId === userId)
      .map((membership) => membership.teamId),
  );
  return live(teams)
    .filter((team) => mine.has(team.id))
    .sort((a, b) => a.name.localeCompare(b.name, 'en') || a.key.localeCompare(b.key, 'en'))
    .map(({ id, key, name }) => ({ id, key, name }));
}

/** The signed-in user as the permission predicates see them, or null without an active row. */
export function actorOf(
  user: UserRow | undefined,
  teams: readonly TeamRow[],
  memberships: readonly MembershipRow[],
): Actor | null {
  if (user === undefined || user.$archived === true || !user.active) return null;
  const byId = new Map(live(teams).map((team) => [team.id, team]));
  return userActor({
    userId: user.id,
    role: user.role,
    memberships: live(memberships)
      .filter((membership) => membership.userId === user.id)
      .flatMap((membership) => {
        const team = byId.get(membership.teamId);
        return team ? [{ teamId: team.id, private: team.private }] : [];
      }),
    // Every public team the replica holds (all of them: Team rows are in `workspace`), archived
    // ones too as on the server (`auth/store.ts`), so `p.canSee` accepts an on-demand public
    // team's issue as the server does (SPEC-011 §5.6).
    publicTeams: teams.filter((team) => !team.private).map((team) => team.id),
  });
}

/** The team a `/team/:key` URL names. Keys are upper case; the URL may not be. */
export function teamByKey<T extends TeamRow>(teams: readonly T[], key: string): T | undefined {
  const wanted = key.toUpperCase();
  return live(teams).find((team) => team.key === wanted);
}

/**
 * The home team (SPEC-005 §3) while it is in the replica: not archived and still visible. A
 * public team the user hasn't joined counts; its page is open to them.
 */
export function homeTeamOf<T extends TeamRow>(
  homeTeamId: string | null,
  teams: readonly T[],
): T | undefined {
  return homeTeamId === null ? undefined : live(teams).find((row) => row.id === homeTeamId);
}

/** The home view's path: the home team's page, otherwise My issues. */
export function homePath(homeTeamId: string | null, teams: readonly TeamRow[]): string {
  const team = homeTeamOf(homeTeamId, teams);
  return team === undefined ? '/my-issues' : `/team/${team.key}`;
}

/** What a team page has seen: the team (by key, upper case) and whether it was ever shown. */
export type TeamView = { readonly key: string; readonly seen: boolean };

/**
 * What a team page shows (SPEC-005 E5), from what it saw before: the team; not-found if it was
 * never visible; or "lost" when it disappears while open (deleted, archived, or a private team
 * the user left), which sends the user home with a toast. Moving to another team starts over.
 */
export function observeTeam(
  previous: TeamView | null,
  key: string,
  present: boolean,
): { readonly view: TeamView; readonly state: 'show' | 'not-found' | 'lost' } {
  const wanted = key.toUpperCase();
  const seen = present || (previous?.key === wanted && previous.seen);
  return {
    view: { key: wanted, seen },
    state: present ? 'show' : seen ? 'lost' : 'not-found',
  };
}

export const lostTeamMessage = (key: string) => `You no longer have access to ${key.toUpperCase()}`;
