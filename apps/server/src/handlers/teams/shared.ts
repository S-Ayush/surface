/**
 * Helpers the team handlers share (PLAN-001 S8): output shapes, key conflicts, and membership
 * reads and writes.
 */
import {
  canEndMembership,
  suggestTeamKey,
  teamKeyProblem,
  type RefEntity,
  type ResolvedRef,
} from '@surface/domain';
import type { TeamMembershipStateSchema, TeamSchema } from '@surface/operations';
import { and, count, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { teamMemberships, teams } from '../../db/schema/index.js';
import { uuidv7 } from '../../db/uuidv7.js';
import type { HandlerContext } from '../../executor/context.js';
import { SurfaceError } from '../../executor/errors.js';
import type { ModelRow } from '../../sync/models.js';
import type { z } from 'zod';

type TeamOutput = z.input<typeof TeamSchema>;
type MembershipStateOutput = z.input<typeof TeamMembershipStateSchema>;

export function teamOutput(row: ModelRow<'Team'>): TeamOutput {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    icon: row.icon,
    color: row.color,
    timezone: row.timezone,
    private: row.private,
    defaultStatusId: row.defaultStatusId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** What a resolved team reference must carry. The executor resolved and visibility-checked it. */
export interface TeamRefRow {
  readonly id: string;
  readonly key: string;
  readonly private: boolean;
}

/** The row the executor resolved for `field`: one row, never a list. */
export function resolved(ref: ResolvedRef | undefined, field: string): RefEntity {
  if (ref === undefined || !('id' in ref)) {
    throw new Error(`Reference ${field} was not resolved to one row`);
  }
  return ref;
}

export function teamRef(ref: ResolvedRef | undefined): TeamRefRow {
  const row = resolved(ref, 'team');
  const key = row['key'];
  const isPrivate = row['private'];
  if (typeof key !== 'string' || typeof isPrivate !== 'boolean') {
    throw new Error('Team reference is missing key or private');
  }
  return { id: row.id, key, private: isPrivate };
}

export function membershipState(
  team: TeamRefRow,
  userId: string,
  member: boolean,
): MembershipStateOutput {
  return { teamId: team.id, teamKey: team.key, userId, member };
}

/** The signed-in user; the system actor belongs to no team. */
export function actorUserId(ctx: HandlerContext, action: string): string {
  const { userId } = ctx.actor;
  if (userId === undefined) {
    throw new SurfaceError('FORBIDDEN', `Only a signed-in user can ${action}.`);
  }
  return userId;
}

// ---------------------------------------------------------------------------------------------
// Keys

/** Every key in use, private teams' and archived teams' included: keys are unique (INV-03). */
export async function takenKeys(tx: NodePgDatabase): Promise<Set<string>> {
  const rows = await tx.select({ key: teams.key }).from(teams);
  return new Set(rows.map((r) => r.key));
}

/**
 * Why `key` can't be this team's key (INV-03, SPEC-001 E11), as the error to answer with, or
 * undefined if it can. Malformed and reserved keys are `INVALID_INPUT`, a taken key `CONFLICT`;
 * each suggests the next free key for the name (AC-11). The message names the key only, never
 * the team that has it, which may be private (SPEC-001 D2, permissions.md §5).
 */
export function keyProblem(
  key: string,
  name: string,
  taken: ReadonlySet<string>,
): SurfaceError | undefined {
  const problem = teamKeyProblem(key);
  const isTaken = problem === undefined && taken.has(key);
  if (problem === undefined && !isTaken) return undefined;
  const next = suggestTeamKey(name, (k) => k === key || taken.has(k));
  const what = problem ?? `Team key ${key} is taken`;
  const message = next
    ? `${what}. Try ${next}, or choose another.`
    : `${what}. Choose another: 2–5 capital letters, like ENG.`;
  return new SurfaceError(isTaken ? 'CONFLICT' : 'INVALID_INPUT', message, {
    issues: [{ path: ['key'], message, ...(next ? { hint: `e.g. ${next}` } : {}) }],
  });
}

/** Whether `error` (or its cause) is a unique violation of `constraint`. */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (let e: unknown = error; typeof e === 'object' && e !== null; e = Reflect.get(e, 'cause')) {
    if (Reflect.get(e, 'code') === '23505' && Reflect.get(e, 'constraint') === constraint) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Memberships

/**
 * Locks the team row so membership changes of one team run one at a time: a concurrent second
 * join or leave then sees the first one's result and changes nothing. `NO KEY UPDATE` still lets
 * other rows reference the team (their foreign keys take `KEY SHARE`).
 */
async function lockTeam(ctx: HandlerContext, teamId: string): Promise<void> {
  await ctx.tx
    .select({ id: teams.id })
    .from(teams)
    .where(eq(teams.id, teamId))
    .for('no key update');
}

async function membershipOf(
  ctx: HandlerContext,
  teamId: string,
  userId: string,
): Promise<{ id: string } | undefined> {
  const [row] = await ctx.tx
    .select({ id: teamMemberships.id })
    .from(teamMemberships)
    .where(and(eq(teamMemberships.teamId, teamId), eq(teamMemberships.userId, userId)));
  return row;
}

/** Inserts a membership (the caller knows there is none) and emits `team.member_added`. */
export async function insertMembership(
  ctx: HandlerContext,
  teamId: string,
  userId: string,
): Promise<void> {
  try {
    await ctx.repo.insert('TeamMembership', { id: uuidv7(), teamId, userId, syncGroups: [] });
  } catch (error) {
    // Defence for writers that don't lock the team first (setup, invites): never INTERNAL.
    if (isUniqueViolation(error, 'team_memberships_team_user_key')) {
      throw new SurfaceError(
        'CONFLICT',
        'This membership changed meanwhile. Reload and try again.',
      );
    }
    throw error;
  }
  ctx.emit({ type: 'team.member_added', subject: { type: 'team', id: teamId }, data: { userId } });
}

/** Makes `userId` a member of `team`; a member already changes nothing. */
export async function addMember(
  ctx: HandlerContext,
  team: TeamRefRow,
  userId: string,
): Promise<MembershipStateOutput> {
  await lockTeam(ctx, team.id);
  if (!(await membershipOf(ctx, team.id, userId))) await insertMembership(ctx, team.id, userId);
  return membershipState(team, userId, true);
}

/**
 * Ends `userId`'s membership of `team`; a non-member changes nothing. A private team keeps its
 * last member (SPEC-001 E12, D3): nobody else can see it, so nobody could rejoin it.
 */
export async function removeMember(
  ctx: HandlerContext,
  team: TeamRefRow,
  userId: string,
  lastMemberMessage: string,
): Promise<MembershipStateOutput> {
  await lockTeam(ctx, team.id);
  const membership = await membershipOf(ctx, team.id, userId);
  if (!membership) return membershipState(team, userId, false);
  if (team.private) {
    const [members] = await ctx.tx
      .select({ n: count() })
      .from(teamMemberships)
      .where(eq(teamMemberships.teamId, team.id));
    if (!canEndMembership(team, members?.n ?? 0)) {
      throw new SurfaceError('CONFLICT', lastMemberMessage);
    }
  }
  await ctx.repo.purge('TeamMembership', membership.id);
  ctx.emit({
    type: 'team.member_removed',
    subject: { type: 'team', id: team.id },
    data: { userId },
  });
  return membershipState(team, userId, false);
}
