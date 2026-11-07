// Read model for Settings → Members (SPEC-001 §3.6), as plain functions over the store's rows,
// like features/teams/model.ts: reading them in an observing component tracks what is used, so a
// role change or a new member in another tab shows here as its delta lands.
import { leavesNoAdmin, type UserRole } from '@surface/domain';

type Live = { readonly $archived?: boolean };

export type MemberUserRow = Live & {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: UserRole;
  readonly active: boolean;
  readonly createdAt: Date | string;
};
export type MemberTeamRow = Live & { readonly id: string; readonly key: string };
export type MemberMembershipRow = Live & { readonly teamId: string; readonly userId: string };

export type RoleFilter = 'all' | UserRole;

export type MemberListItem = {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: UserRole;
  /** Team keys, sorted. */
  readonly teams: readonly string[];
  readonly joined: Date;
  /** The signed-in user. */
  readonly self: boolean;
  /** Making this person a Member would leave no Admin (INV-01, E6). */
  readonly lastAdmin: boolean;
};

export const ROLE_LABEL: Readonly<Record<UserRole, string>> = { admin: 'Admin', member: 'Member' };

const live = <T extends Live>(rows: readonly T[]): T[] =>
  rows.filter((row) => row.$archived !== true);

/**
 * The people Settings → Members lists: active users (deactivating is M7), filtered by role, by
 * name. Each carries its teams' keys, its join date and whether it is the last Admin.
 */
export function memberList(
  users: readonly MemberUserRow[],
  teams: readonly MemberTeamRow[],
  memberships: readonly MemberMembershipRow[],
  me: string,
  filter: RoleFilter = 'all',
): MemberListItem[] {
  const people = live(users).filter((user) => user.active);
  const admins = people.filter((user) => user.role === 'admin').map((user) => user.id);
  const keyOf = new Map(live(teams).map((team) => [team.id, team.key]));
  const teamsOf = new Map<string, string[]>();
  for (const membership of live(memberships)) {
    const key = keyOf.get(membership.teamId);
    if (key === undefined) continue;
    teamsOf.set(membership.userId, [...(teamsOf.get(membership.userId) ?? []), key]);
  }
  return people
    .filter((user) => filter === 'all' || user.role === filter)
    .map((user) => ({
      id: user.id,
      name: user.name,
      displayName: user.displayName,
      email: user.email,
      role: user.role,
      teams: (teamsOf.get(user.id) ?? []).sort((a, b) => a.localeCompare(b, 'en')),
      joined: new Date(user.createdAt),
      self: user.id === me,
      lastAdmin: leavesNoAdmin(admins, user.id, 'member'),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en') || a.email.localeCompare(b.email, 'en'));
}

/** "Joined Nov 7, 2026", in the viewer's locale and time zone. */
export function joinedText(joined: Date, locale?: string): string {
  return `Joined ${joined.toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' })}`;
}

/** "3 people", "1 Admin", "2 Members": what the filtered list shows. */
export function memberCountText(count: number, filter: RoleFilter): string {
  const noun = filter === 'all' ? 'person' : ROLE_LABEL[filter];
  const plural = filter === 'all' ? 'people' : `${ROLE_LABEL[filter]}s`;
  return `${count} ${count === 1 ? noun : plural}`;
}
