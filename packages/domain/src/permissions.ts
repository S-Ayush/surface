/**
 * Actors and permission predicates (SPEC-003 §5, permissions.md). Shared by the server
 * executor and the client's command-menu pre-check, so both apply the same rules.
 */
import type { RefEntity } from './refs.js';

export type ActorKind = 'user' | 'api' | 'mcp' | 'system';
export type Role = 'admin' | 'member';

/** What an API key may do (permissions.md §3.5). Wired to real keys in M6. */
export interface ApiKeyScope {
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
  /** Sync groups the actor can see (permissions.md §2). Visibility filters use these. */
  readonly groups: readonly string[];
  /**
   * Ids of every team the user is a member of, public or private. `p.teamMember` needs this
   * because public-team membership is not a sync group.
   */
  readonly memberOf: readonly string[];
  readonly apiKey?: ApiKeyScope;
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
  /** Set for API and MCP calls (M6). */
  readonly via?: { readonly kind: 'api' | 'mcp'; readonly apiKey: ApiKeyScope };
}

/** The actor for an active user, from a session (PLAN-001 S3) or an API key (M6). */
export function userActor({ userId, role, memberships, via }: UserActorInput): Actor {
  return {
    kind: via?.kind ?? 'user',
    userId,
    role,
    groups: syncGroupsFor(userId, memberships),
    memberOf: memberships.map((m) => m.teamId),
    ...(via ? { apiKey: via.apiKey } : {}),
  };
}

const SYSTEM_ACTOR: Actor = Object.freeze({
  kind: 'system',
  groups: Object.freeze([]),
  memberOf: Object.freeze([]),
});

/** Automations and jobs: not subject to checks, always attributed in history. */
export function systemActor(): Actor {
  return SYSTEM_ACTOR;
}

/** Whether a row with `rowGroups` is visible to an actor (`sync_groups && actorGroups`). */
export function canSeeGroups(actor: Actor, rowGroups: readonly string[]): boolean {
  if (actor.kind === 'system') return true;
  return rowGroups.some((g) => actor.groups.includes(g));
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
}

/** Predicates bound to an actor, plus who would have passed the ones that failed. */
export interface BoundPredicates {
  readonly p: PermissionPredicates;
  /**
   * Who the failed predicates allow, in call order and without repeats ("Admins",
   * "members of Engineering"). Used to build the `FORBIDDEN` reason.
   */
  allowedWho(): readonly string[];
}

/** Binds the predicate helper `p` to an actor. Use a fresh binding per check. */
export function bindPredicates(actor: Actor): BoundPredicates {
  const who: string[] = [];
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
  };
  return { p, allowedWho: () => [...who] };
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
