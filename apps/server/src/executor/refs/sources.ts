/**
 * Per-type lookups for the server resolvers (SPEC-003 §4). Every query filters by visibility
 * in SQL (`sync_groups && $groups`), so a row the actor can't see behaves exactly like a row
 * that doesn't exist: `NOT_FOUND`, with the same message (permissions.md §5, CLAUDE.md rule 4).
 *
 * Tables and columns follow PLAN-001 S1 (`teams`, `users`, `workflow_statuses`, `labels`).
 * Names match case-insensitively; an exact-case match wins over other case variants.
 * Candidates sort with `COLLATE "C"` so their order doesn't depend on the database locale.
 */
import {
  parseNamedRef,
  parseTeamRef,
  parseUserRef,
  REF_AVAILABLE_FROM,
  type RefEntity,
  type RefType,
} from '@surface/domain';
import type { Queryable } from '../../db/pool.js';
import { SurfaceError, type ErrorCandidate } from '../errors.js';

/** Who is resolving. A structural subset of the executor's `Actor` (PLAN-003 S3). */
export interface ResolveActor {
  readonly kind: 'user' | 'api' | 'mcp' | 'system';
  /** The user, or the API key's owner. Absent for the system actor. */
  readonly userId?: string;
  readonly groups: readonly string[];
}

export interface LookupContext {
  readonly db: Queryable;
  readonly actor: ResolveActor;
  /** Input path of the value, for error issues (`['labels', 1]`). */
  readonly path: readonly (string | number)[];
  /** The resolved scope team, for scoped references. */
  readonly scopeTeam?: RefEntity;
  readonly allowInactive: boolean;
}

const MAX_CANDIDATES = 10;

export async function lookup(
  type: RefType,
  value: unknown,
  ctx: LookupContext,
): Promise<RefEntity> {
  switch (type) {
    case 'TeamRef':
      return lookupTeam(stringValue(value), ctx);
    case 'UserRef':
      return lookupUser(stringValue(value), ctx);
    case 'StatusRef':
      return lookupStatus(stringValue(value), ctx);
    case 'LabelRef':
      return lookupLabel(stringValue(value), ctx);
    case 'IssueRef':
    case 'CycleRef':
    case 'ProjectRef':
    case 'InitiativeRef':
    case 'DocumentRef':
    case 'ViewRef':
      // A definition bug: no operation may use these before their entities exist.
      throw new Error(`${type} is not available until ${REF_AVAILABLE_FROM[type]}`);
  }
}

/** `null` means "every group": the system actor is not subject to visibility (permissions.md §1). */
function visibleGroups(actor: ResolveActor): readonly string[] | null {
  return actor.kind === 'system' ? null : actor.groups;
}

function stringValue(value: unknown): string {
  // Input was validated against the ref schema; anything else is a planner or schema bug.
  if (typeof value !== 'string')
    throw new Error(`Reference value must be a string, got ${typeof value}`);
  return value;
}

function invalid(ctx: LookupContext, message: string, candidates?: ErrorCandidate[]): SurfaceError {
  return new SurfaceError('INVALID_INPUT', message, {
    issues: [{ path: ctx.path, message }],
    ...(candidates ? { candidates } : {}),
  });
}

function notFound(ctx: LookupContext, message: string): SurfaceError {
  return new SurfaceError('NOT_FOUND', message, { issues: [{ path: ctx.path, message }] });
}

/**
 * One row from a case-insensitive name match: the only row, else the only exact-case row,
 * else ambiguity with candidates.
 */
function pickByName<Row extends RefEntity>(
  rows: readonly Row[],
  exact: (row: Row) => boolean,
): Row | { ambiguous: readonly Row[] } | undefined {
  if (rows.length <= 1) return rows[0];
  const exactRows = rows.filter(exact);
  const [first] = exactRows;
  if (exactRows.length === 1 && first) return first;
  return { ambiguous: exactRows.length > 1 ? exactRows : rows };
}

function isAmbiguous<Row>(
  picked: Row | { ambiguous: readonly Row[] },
): picked is { ambiguous: readonly Row[] } {
  return typeof picked === 'object' && picked !== null && 'ambiguous' in picked;
}

function candidates<Row extends RefEntity>(
  rows: readonly Row[],
  label: (row: Row) => string,
): ErrorCandidate[] {
  return rows.slice(0, MAX_CANDIDATES).map((row) => ({ id: row.id, label: label(row) }));
}

// ---------------------------------------------------------------------------------------------
// Teams

interface TeamRow extends RefEntity {
  key: string;
  name: string;
  private: boolean;
  syncGroups: string[];
}

async function lookupTeam(value: string, ctx: LookupContext): Promise<TeamRow> {
  const ref = parseTeamRef(value);
  const groups = visibleGroups(ctx.actor);
  let rows: TeamRow[] = [];
  if (ref?.by === 'id') {
    ({ rows } = await ctx.db.query<TeamRow>(
      `SELECT id, key, name, private, sync_groups AS "syncGroups"
         FROM teams
        WHERE id = $1 AND ($2::text[] IS NULL OR sync_groups && $2::text[])`,
      [ref.id, groups],
    ));
  } else if (ref?.by === 'key') {
    ({ rows } = await ctx.db.query<TeamRow>(
      `SELECT id, key, name, private, sync_groups AS "syncGroups"
         FROM teams
        WHERE key = $1 AND ($2::text[] IS NULL OR sync_groups && $2::text[])`,
      [ref.key, groups],
    ));
  }
  const [team] = rows;
  if (!team)
    throw notFound(ctx, `Team "${value}" not found. Use a team key like ENG, or a team id.`);
  return team;
}

// ---------------------------------------------------------------------------------------------
// Users

interface UserRow extends RefEntity {
  email: string;
  name: string;
  displayName: string;
  role: string;
  active: boolean;
  syncGroups: string[];
}

async function lookupUser(value: string, ctx: LookupContext): Promise<UserRow> {
  const ref = parseUserRef(value);
  const groups = visibleGroups(ctx.actor);
  let rows: UserRow[] = [];

  if (ref?.by === 'me' && ctx.actor.userId === undefined) {
    // SPEC-003 E1
    throw invalid(ctx, "'me' requires a user actor");
  }
  const id = ref?.by === 'id' ? ref.id : ref?.by === 'me' ? ctx.actor.userId : undefined;
  if (id !== undefined) {
    ({ rows } = await ctx.db.query<UserRow>(
      `SELECT id, email, name, display_name AS "displayName", role, active, sync_groups AS "syncGroups"
         FROM users
        WHERE id = $1 AND ($2::text[] IS NULL OR sync_groups && $2::text[])`,
      [id, groups],
    ));
  } else if (ref?.by === 'email') {
    ({ rows } = await ctx.db.query<UserRow>(
      `SELECT id, email, name, display_name AS "displayName", role, active, sync_groups AS "syncGroups"
         FROM users
        WHERE email = $1 AND ($2::text[] IS NULL OR sync_groups && $2::text[])`,
      [ref.email, groups],
    ));
  } else if (ref?.by === 'name') {
    ({ rows } = await ctx.db.query<UserRow>(
      `SELECT id, email, name, display_name AS "displayName", role, active, sync_groups AS "syncGroups"
         FROM users
        WHERE lower(display_name) = lower($1) AND ($2::text[] IS NULL OR sync_groups && $2::text[])
        ORDER BY display_name COLLATE "C", id`,
      [ref.name, groups],
    ));
  }

  const picked = pickByName(rows, (row) => row.displayName === value.trim());
  if (picked === undefined) {
    throw notFound(
      ctx,
      `User "${value}" not found. Use an email, a display name, "me", or a user id.`,
    );
  }
  if (isAmbiguous(picked)) {
    throw invalid(
      ctx,
      `${picked.ambiguous.length} users match "${value}". Use the email or the user id instead.`,
      candidates(picked.ambiguous, (u) => `${u.displayName} (${u.email})`),
    );
  }
  if (!picked.active && !ctx.allowInactive) {
    throw invalid(
      ctx,
      `${picked.displayName} is deactivated. Choose an active user, or reactivate them first.`,
    );
  }
  return picked;
}

// ---------------------------------------------------------------------------------------------
// Workflow statuses (scoped to a team)

interface StatusRow extends RefEntity {
  teamId: string;
  name: string;
  category: string;
  syncGroups: string[];
}

async function lookupStatus(value: string, ctx: LookupContext): Promise<StatusRow> {
  const team = ctx.scopeTeam;
  if (!team) throw invalid(ctx, `Status "${value}" needs a team. Set the team as well.`);
  const teamKey = String(team.key);
  const ref = parseNamedRef(value);
  const groups = visibleGroups(ctx.actor);
  let rows: StatusRow[] = [];
  if (ref?.by === 'id') {
    ({ rows } = await ctx.db.query<StatusRow>(
      `SELECT id, team_id AS "teamId", name, category, sync_groups AS "syncGroups"
         FROM workflow_statuses
        WHERE id = $1 AND team_id = $2 AND ($3::text[] IS NULL OR sync_groups && $3::text[])`,
      [ref.id, team.id, groups],
    ));
  } else if (ref?.by === 'name') {
    ({ rows } = await ctx.db.query<StatusRow>(
      `SELECT id, team_id AS "teamId", name, category, sync_groups AS "syncGroups"
         FROM workflow_statuses
        WHERE lower(name) = lower($1) AND team_id = $2
          AND ($3::text[] IS NULL OR sync_groups && $3::text[])
        ORDER BY name COLLATE "C", id`,
      [ref.name, team.id, groups],
    ));
  }

  const picked = pickByName(rows, (row) => row.name === value.trim());
  if (picked === undefined) {
    throw notFound(
      ctx,
      `Status "${value}" not found in ${teamKey}. Use a status name of that team, or a status id.`,
    );
  }
  if (isAmbiguous(picked)) {
    throw invalid(
      ctx,
      `${picked.ambiguous.length} statuses in ${teamKey} match "${value}". Use the exact name or the status id.`,
      candidates(picked.ambiguous, (s) => s.name),
    );
  }
  return picked;
}

// ---------------------------------------------------------------------------------------------
// Labels (team labels first, then workspace labels)

interface LabelRow extends RefEntity {
  teamId: string | null;
  parentId: string | null;
  groupName: string | null;
  name: string;
  isGroup: boolean;
  syncGroups: string[];
}

async function lookupLabel(value: string, ctx: LookupContext): Promise<LabelRow> {
  const team = ctx.scopeTeam;
  const ref = parseNamedRef(value);
  const groups = visibleGroups(ctx.actor);
  let rows: LabelRow[] = [];
  // `$2` is null without a team scope, so only workspace labels (team_id IS NULL) match.
  if (ref?.by === 'id') {
    ({ rows } = await ctx.db.query<LabelRow>(
      `SELECT l.id, l.team_id AS "teamId", l.parent_id AS "parentId", p.name AS "groupName",
              l.name, l.is_group AS "isGroup", l.sync_groups AS "syncGroups"
         FROM labels l LEFT JOIN labels p ON p.id = l.parent_id
        WHERE l.id = $1 AND (l.team_id IS NULL OR l.team_id = $2::uuid)
          AND ($3::text[] IS NULL OR l.sync_groups && $3::text[])`,
      [ref.id, team?.id ?? null, groups],
    ));
  } else if (ref?.by === 'name') {
    ({ rows } = await ctx.db.query<LabelRow>(
      `SELECT l.id, l.team_id AS "teamId", l.parent_id AS "parentId", p.name AS "groupName",
              l.name, l.is_group AS "isGroup", l.sync_groups AS "syncGroups"
         FROM labels l LEFT JOIN labels p ON p.id = l.parent_id
        WHERE lower(l.name) = lower($1) AND (l.team_id IS NULL OR l.team_id = $2::uuid)
          AND ($3::text[] IS NULL OR l.sync_groups && $3::text[])
        ORDER BY p.name COLLATE "C" NULLS FIRST, l.name COLLATE "C", l.id`,
      [ref.name, team?.id ?? null, groups],
    ));
  }

  // SPEC-003 §4: the team's labels win over workspace labels with the same name.
  const teamRows = rows.filter((row) => row.teamId !== null);
  const pool = teamRows.length > 0 ? teamRows : rows;
  const where = team ? `${String(team.key)} or the workspace labels` : 'the workspace labels';

  const picked = pickByName(pool, (row) => row.name === value.trim());
  if (picked === undefined) {
    throw notFound(ctx, `Label "${value}" not found in ${where}. Use a label name or a label id.`);
  }
  if (isAmbiguous(picked)) {
    throw invalid(
      ctx,
      `${picked.ambiguous.length} labels in ${where} match "${value}". Use the label id instead.`,
      candidates(picked.ambiguous, (l) => (l.groupName ? `${l.groupName}/${l.name}` : l.name)),
    );
  }
  return picked;
}
