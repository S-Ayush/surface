/**
 * Actors and permission predicates (SPEC-003 §5, permissions.md). Shared by the server
 * executor and the client's command-menu pre-check, so both apply the same rules.
 */
import type { RefEntity } from './refs.js';

export type ActorKind = 'user' | 'api' | 'mcp' | 'system';
export type Role = 'admin' | 'member';

/** What an API key may do (permissions.md §3.5). Wired to real keys in M6. */
export interface ApiKeyScope {
  /** The key's id, recorded as `actor.apiKeyId` in events and audit (events.md envelope). */
  readonly id: string;
  readonly scope: 'read' | 'read_write';
  /** Teams the key is limited to. Empty means every team the owner can see. */
  readonly teamIds: readonly string[];
  readonly allowDestructive: boolean;
}

/**
 * Who runs an operation. `api` and `mcp` actors act as their key's owner (`userId`, `role`),
 * narrowed by `apiKey`. The system actor (automations, jobs) is not subject to checks.
 */
export interface Actor {
  readonly kind: ActorKind;
  readonly userId?: string;
  readonly role?: Role;
  /**
   * The actor's **home** sync groups (permissions.md §2): `workspace`, `user:<id>` and each
   * private team they are a member of. A sync connection always has these. Visibility filters use
   * `visibleGroups(actor)`, which adds every public team's group (SPEC-011 §5.6).
   */
  readonly groups: readonly string[];
  /**
   * Ids of every public team in the workspace, when the actor was built (SPEC-011 §5.6, §5.7).
   * Their issues are in `team:<id>`, which any active user may see but which is not a home group:
   * a sync connection receives it only while its client subscribes to the team.
   */
  readonly publicTeams: readonly string[];
  /**
   * Ids of every team the user is a member of, public or private. `p.teamMember` needs this
   * because public-team membership is not a sync group.
   */
  readonly memberOf: readonly string[];
  readonly apiKey?: ApiKeyScope;
  /**
   * The session a `user` actor signed in with, so "Revoke all others" and a password change
   * can keep it (PLAN-001 S3 follow-up). Absent for API keys, MCP and the system.
   */
  readonly sessionId?: string;
}

export const WORKSPACE_GROUP = 'workspace';
export const teamGroup = (teamId: string): string => `team:${teamId}`;
export const userGroup = (userId: string): string => `user:${userId}`;

export interface Membership {
  readonly teamId: string;
  readonly private: boolean;
}

/** Sync groups of an active user: workspace, their own, and each private team they belong to. */
export function syncGroupsFor(userId: string, memberships: readonly Membership[]): string[] {
  return [
    WORKSPACE_GROUP,
    userGroup(userId),
    ...memberships.filter((m) => m.private).map((m) => teamGroup(m.teamId)),
  ];
}

export interface UserActorInput {
  readonly userId: string;
  readonly role: Role;
  readonly memberships: readonly Membership[];
  /**
   * Every public team's id (SPEC-011 §5.6). The server reads them with the session; the web
   * client's pre-check actor needs none, since nothing there filters issues by them.
   */
  readonly publicTeams?: readonly string[];
  /** Set for API and MCP calls (M6). */
  readonly via?: { readonly kind: 'api' | 'mcp'; readonly apiKey: ApiKeyScope };
  /** The session behind a signed-in request; ignored for API and MCP calls. */
  readonly sessionId?: string;
}

/** The actor for an active user, from a session (PLAN-001 S3) or an API key (M6). */
export function userActor({
  userId,
  role,
  memberships,
  publicTeams = [],
  via,
  sessionId,
}: UserActorInput): Actor {
  return {
    kind: via?.kind ?? 'user',
    userId,
    role,
    groups: syncGroupsFor(userId, memberships),
    publicTeams: [...publicTeams],
    memberOf: memberships.map((m) => m.teamId),
    ...(via ? { apiKey: via.apiKey } : {}),
    ...(sessionId !== undefined && !via ? { sessionId } : {}),
  };
}

const SYSTEM_ACTOR: Actor = Object.freeze({
  kind: 'system',
  groups: Object.freeze([]),
  publicTeams: Object.freeze([]),
  memberOf: Object.freeze([]),
});

/** Automations and jobs: not subject to checks, always attributed in history. */
export function systemActor(): Actor {
  return SYSTEM_ACTOR;
}

/**
 * Every sync group the actor may see (SPEC-011 §5.6): its home groups plus `team:<id>` of every
 * public team. Every read path filters with these (`sync_groups && $groups`), never with a sync
 * connection's groups, which hold only the subscribed public teams (§5.7). The system actor sees
 * everything: callers serving it skip the filter instead.
 */
export function visibleGroups(actor: Pick<Actor, 'groups' | 'publicTeams'>): readonly string[] {
  const groups = new Set(actor.groups);
  for (const teamId of actor.publicTeams) groups.add(teamGroup(teamId));
  return [...groups];
}

/** Whether a row with `rowGroups` is visible to an actor (`sync_groups && visibleGroups`). */
export function canSeeGroups(actor: Actor, rowGroups: readonly string[]): boolean {
  if (actor.kind === 'system') return true;
  const visible = new Set(visibleGroups(actor));
  return rowGroups.some((g) => visible.has(g));
}

// ---------------------------------------------------------------------------------------------
// Predicates

/** One resolved reference field: a single row, or the rows of a list of references. */
export type ResolvedRef = RefEntity | readonly RefEntity[];

/** Resolved references keyed by input field path (`{ team }` for `input.team`). */
export interface ResolvedRefs {
  readonly [field: string]: ResolvedRef | undefined;
}

/**
 * The predicate helper `p` bound to the actor (SPEC-003 §5). Every predicate returns `false`
 * for a missing reference, and for a list of references every element must pass. The system
 * actor passes every predicate.
 */
export interface PermissionPredicates {
  /** Any authenticated active user. */
  any(): boolean;
  /** The actor's role is Admin. */
  admin(): boolean;
  /** The reference is the actor. */
  self(user: ResolvedRef | undefined): boolean;
  /** The actor is a member of the team. */
  teamMember(team: ResolvedRef | undefined): boolean;
  /** The entity's sync groups intersect the actor's. Checked implicitly for every ref. */
  canSee(entity: ResolvedRef | undefined): boolean;
  /** The actor owns the entity (`creatorId` unless another field is named). */
  owner(entity: ResolvedRef | undefined, field?: string): boolean;
  /**
   * The actor's API key, if any, covers every team (permissions §3.5): a key narrowed by
   * `teamIds` fails it. Workspace-wide changes (workspace labels) need it, because they affect
   * teams the key can't see.
   */
  allTeamsKey(): boolean;
}

/** Predicates bound to an actor, plus who would have passed the ones that failed. */
export interface BoundPredicates {
  readonly p: PermissionPredicates;
  /**
   * Who the failed predicates allow, in call order and without repeats ("Admins",
   * "members of Engineering"). Used to build the `FORBIDDEN` reason.
   */
  allowedWho(): readonly string[];
  /** A complete `FORBIDDEN` reason a failed predicate gave in place of "Only … can …", if any. */
  reason(): string | undefined;
}

/** Binds the predicate helper `p` to an actor. Use a fresh binding per check. */
export function bindPredicates(actor: Actor): BoundPredicates {
  const who: string[] = [];
  let fixedReason: string | undefined;
  const system = actor.kind === 'system';

  /** Records `phrase` when the check fails, and returns the check. */
  const check = (passed: boolean, phrase: string | undefined): boolean => {
    if (system) return true;
    if (!passed && phrase !== undefined && !who.includes(phrase)) who.push(phrase);
    return passed;
  };
  const every = (ref: ResolvedRef | undefined, test: (row: RefEntity) => boolean): boolean => {
    if (ref === undefined) return false;
    if (isRow(ref)) return test(ref);
    return ref.length > 0 && ref.every(test);
  };
  const isUser = actor.kind !== 'system' && actor.userId !== undefined;

  const p: PermissionPredicates = {
    any: () => check(isUser, 'signed-in users'),
    admin: () => check(isUser && actor.role === 'admin', 'Admins'),
    self: (user) =>
      check(isUser && every(user, (row) => row.id === actor.userId), 'that user themselves'),
    teamMember: (team) =>
      check(
        isUser && every(team, (row) => actor.memberOf.includes(row.id)),
        `members of ${teamName(team)}`,
      ),
    canSee: (entity) =>
      check(
        every(entity, (row) => canSeeGroups(actor, stringArray(row.syncGroups))),
        'people who can see it',
      ),
    owner: (entity, field = 'creatorId') =>
      check(
        isUser && every(entity, (row) => row[field] === actor.userId),
        field === 'creatorId' ? 'its creator' : 'its owner',
      ),
    allTeamsKey: () => {
      if (system || actor.apiKey === undefined || actor.apiKey.teamIds.length === 0) return true;
      fixedReason ??=
        'This API key is limited to some teams. Changing workspace labels needs a key for all teams.';
      return false;
    },
  };
  return { p, allowedWho: () => [...who], reason: () => fixedReason };
}

function isRow(ref: ResolvedRef): ref is RefEntity {
  return 'id' in ref;
}

function teamName(team: ResolvedRef | undefined): string {
  if (team !== undefined && isRow(team) && typeof team.name === 'string') return team.name;
  return 'the team';
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
