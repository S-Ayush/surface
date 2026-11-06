import type { RefEntity } from '@surface/domain';

/**
 * A row a reference resolved to (SPEC-003 §4), defined in `@surface/domain` so client
 * resolvers share it. The executor passes these to `permission` after resolution.
 */
export type { RefEntity };

/** One resolved reference field: a single row, or the rows of a list of references. */
export type ResolvedRef = RefEntity | readonly RefEntity[];

/** Resolved references keyed by input field path (`{ team }` for `input.team`). */
export interface ResolvedRefs {
  readonly [field: string]: ResolvedRef | undefined;
}

/**
 * The predicate helper `p` bound to the actor (SPEC-003 §5). PLAN-003 S3 implements it on
 * the server, and the client implements it over its store for the command-menu pre-check.
 * Every predicate returns `false` for a missing reference. For a list of references, every
 * element must pass. A failing predicate records a human-readable reason for `FORBIDDEN`.
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
