// Read models for the team screens (SPEC-001 §3.7), as plain functions over the store's rows, like
// app/workspace.ts: reading them inside an observing component tracks exactly what is used, so a
// join, leave or rename in another tab shows here as its delta lands (AC-12, AC-13).
import {
  bindPredicates,
  canEndMembership,
  type Actor,
  type ColorHue,
  type ResolvedRefs,
} from '@surface/domain';
import { teamAddMember, teamRemoveMember, teamUpdate } from '@surface/operations';
import type { MembershipRow, TeamRow as ShellTeamRow } from '../../app/workspace.js';

export type { MembershipRow };

type Live = { readonly $archived?: boolean };

/** The shell's team row (app/workspace.ts) and the settings the team screens show. */
export type TeamRow = ShellTeamRow & {
  readonly icon: string | null;
  readonly color: ColorHue;
  readonly timezone: string;
};
/** Users as the member lists show them (the shell's row has no profile fields). */
export type UserRow = Live & {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly email: string;
  readonly active: boolean;
};

const live = <T extends Live>(rows: readonly T[]): T[] =>
  rows.filter((row) => row.$archived !== true);

const byName = (a: { name: string; key?: string }, b: { name: string; key?: string }) =>
  a.name.localeCompare(b.name, 'en') || (a.key ?? '').localeCompare(b.key ?? '', 'en');

export type TeamListItem = {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly icon: string | null;
  readonly color: ColorHue;
  readonly private: boolean;
  readonly memberCount: number;
  /** The signed-in user is a member. */
  readonly member: boolean;
};

/**
 * Settings → Teams: every team the user can see (the store holds only those), with a member count
 * and whether the user is in it, by name then key.
 */
export function browseTeams(
  teams: readonly TeamRow[],
  memberships: readonly MembershipRow[],
  userId: string,
): TeamListItem[] {
  const counts = new Map<string, number>();
  const mine = new Set<string>();
  for (const membership of live(memberships)) {
    counts.set(membership.teamId, (counts.get(membership.teamId) ?? 0) + 1);
    if (membership.userId === userId) mine.add(membership.teamId);
  }
  return live(teams)
    .map((team) => ({
      id: team.id,
      key: team.key,
      name: team.name,
      icon: team.icon,
      color: team.color,
      private: team.private,
      memberCount: counts.get(team.id) ?? 0,
      member: mine.has(team.id),
    }))
    .sort(byName);
}

export type MemberItem = {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly email: string;
};

const memberItem = ({ id, name, displayName, email }: UserRow): MemberItem => ({
  id,
  name,
  displayName,
  email,
});

/** A team's members, by name. Memberships whose user the store lacks are skipped. */
export function teamMembers(
  teamId: string,
  memberships: readonly MembershipRow[],
  users: readonly UserRow[],
): MemberItem[] {
  const ids = new Set(
    live(memberships)
      .filter((membership) => membership.teamId === teamId)
      .map((membership) => membership.userId),
  );
  return live(users)
    .filter((user) => ids.has(user.id))
    .map(memberItem)
    .sort(byName);
}

/** Who "Add member" offers: active people not yet in the team, by name. */
export function addableUsers(
  teamId: string,
  memberships: readonly MembershipRow[],
  users: readonly UserRow[],
): MemberItem[] {
  const members = new Set(
    live(memberships)
      .filter((membership) => membership.teamId === teamId)
      .map((membership) => membership.userId),
  );
  return live(users)
    .filter((user) => user.active && !members.has(user.id))
    .map(memberItem)
    .sort(byName);
}

/** What the signed-in user may do with a team: the operations' own permissions (SPEC-001 §5). */
export type TeamAccess = {
  /** Change name, icon, color and time zone (`team.update`). */
  readonly edit: boolean;
  /** Add and remove members (`team.addMember`, `team.removeMember`). */
  readonly manageMembers: boolean;
};

/**
 * Runs the operations' permission predicates on the actor, as the command menu's pre-check does,
 * so the screens and the server agree on who may act (members of the team, and Admins). The
 * server still decides; this only hides what it would refuse.
 */
export function teamAccess(actor: Actor | null, team: { readonly id: string }): TeamAccess {
  if (actor === null) return { edit: false, manageMembers: false };
  const { p } = bindPredicates(actor);
  const refs: ResolvedRefs = { team };
  const allows = (permission: (refs: ResolvedRefs) => boolean) => {
    try {
      return permission(refs);
    } catch {
      // A predicate that needs the input is the server's to decide.
      return true;
    }
  };
  return {
    edit: allows((r) => teamUpdate.permission(p, r, { team: team.id })),
    manageMembers:
      allows((r) => teamAddMember.permission(p, r, { team: team.id, user: 'me' })) &&
      allows((r) => teamRemoveMember.permission(p, r, { team: team.id, user: 'me' })),
  };
}

/**
 * Whether one more membership of the team may end (SPEC-001 E12, D3): the last member of a
 * private team can neither leave nor be removed. Counted from the store, which a member of a
 * private team holds in full.
 */
export function canEndMembershipOf(
  team: { readonly id: string; readonly private: boolean },
  memberships: readonly MembershipRow[],
): boolean {
  const count = live(memberships).filter((membership) => membership.teamId === team.id).length;
  return canEndMembership(team, count);
}

/** Why "Leave" or "Remove" is unavailable on the last member of a private team (E12). */
/** "1 member", "3 members". */
export const memberCountText = (count: number): string =>
  count === 1 ? '1 member' : `${count} members`;

export const LAST_PRIVATE_MEMBER =
  'A private team needs at least one member. Add someone before leaving or removing the last member.';
