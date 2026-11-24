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
  ATTACHMENT_MESSAGES,
  parseIdRef,
  parseIssueRef,
  parseLabelRef,
  parseNamedRef,
  parseTeamRef,
  parseUserRef,
  REF_AVAILABLE_FROM,
  visibleGroups,
  type Actor,
  type RefEntity,
  type RefType,
} from '@surface/domain';
import type { Queryable } from '../../db/pool.js';
import { fileReaderOf, reattachableFile, visibleFile } from '../../files/store.js';
import { SurfaceError, type ErrorCandidate } from '../errors.js';

/** What resolution needs from the actor: `me`, the groups for visibility, and key narrowing. */
export type ResolveActor = Pick<Actor, 'kind' | 'userId' | 'groups' | 'publicTeams' | 'apiKey'>;

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
    case 'InviteRef':
      return lookupInvite(stringValue(value), ctx);
    case 'SessionRef':
      return lookupSession(stringValue(value), ctx);
    case 'FileRef':
      return lookupFile(stringValue(value), ctx);
    case 'IssueRef':
      return lookupIssue(stringValue(value), ctx);
    case 'CommentRef':
      return lookupComment(stringValue(value), ctx);
    case 'AttachmentRef':
      return lookupAttachment(stringValue(value), ctx);
    case 'CycleRef':
    case 'ProjectRef':
    case 'InitiativeRef':
    case 'DocumentRef':
    case 'ViewRef':
      // A definition bug: no operation may use these before their entities exist.
      throw new Error(`${type} is not available until ${REF_AVAILABLE_FROM[type]}`);
  }
}

/**
 * The groups a ref may resolve in: every group the actor may see, every public team's included
 * (SPEC-011 §5.6). `null` means "every group": the system actor is not subject to visibility
 * (permissions.md §1).
 */
function groupsFilter(actor: ResolveActor): readonly string[] | null {
  return actor.kind === 'system' ? null : visibleGroups(actor);
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

/**
 * The `NOT_FOUND` for a reference. One template per type, shared with the executor's key-scope
 * backstop, so every path that hides a row says exactly the same thing (permissions.md §5).
 */
export function refNotFound(
  type: RefType,
  value: string,
  path: readonly (string | number)[],
  scopeTeam?: RefEntity,
): SurfaceError {
  const teamKey = scopeTeam ? String(scopeTeam.key) : undefined;
  const message = ((): string => {
    switch (type) {
      case 'TeamRef':
        return `Team "${value}" not found. Use a team key like ENG, or a team id.`;
      case 'UserRef':
        return `User "${value}" not found. Use an email, a display name, "me", or a user id.`;
      case 'StatusRef':
        return `Status "${value}" not found in ${teamKey ?? 'the team'}. Use a status name of that team, or a status id.`;
      case 'LabelRef':
        return `Label "${value}" not found in ${teamKey ? `${teamKey} or the workspace labels` : 'the workspace labels'}. Use a label name or a label id.`;
      case 'InviteRef':
        return `Invite "${value}" not found. Use an invite id from invite.list.`;
      case 'SessionRef':
        return `Session "${value}" not found. Use a session id from session.list.`;
      case 'FileRef':
        // SPEC-014 §6.4: the same words for an unknown file and one `createFile` can't take.
        return `File "${value}" not found. ${ATTACHMENT_MESSAGES.fileNotFound}`;
      case 'IssueRef':
        return `Issue "${value}" not found. Use an issue identifier like ENG-123, or an issue id.`;
      case 'CommentRef':
        return `Comment "${value}" not found. Use a comment id from comment.list.`;
      case 'AttachmentRef':
        return `Attachment "${value}" not found. Use an attachment id from issue.get.`;
      case 'CycleRef':
      case 'ProjectRef':
      case 'InitiativeRef':
      case 'DocumentRef':
      case 'ViewRef':
        return `${type.replace(/Ref$/, '')} "${value}" not found.`;
    }
  })();
  return new SurfaceError('NOT_FOUND', message, { issues: [{ path, message }] });
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
  const groups = groupsFilter(ctx.actor);
  // permissions.md §3.5: a key limited to some teams sees no others, public ones included.
  // Statuses and labels resolve within a team ref, so this one filter covers them too.
  const keyTeams = ctx.actor.apiKey?.teamIds.length ? ctx.actor.apiKey.teamIds : null;
  let rows: TeamRow[] = [];
  if (ref?.by === 'id') {
    ({ rows } = await ctx.db.query<TeamRow>(
      `SELECT id, key, name, private, sync_groups AS "syncGroups"
         FROM teams
        WHERE id = $1 AND ($2::text[] IS NULL OR sync_groups && $2::text[])
          AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))`,
      [ref.id, groups, keyTeams],
    ));
  } else if (ref?.by === 'key') {
    ({ rows } = await ctx.db.query<TeamRow>(
      `SELECT id, key, name, private, sync_groups AS "syncGroups"
         FROM teams
        WHERE key = $1 AND ($2::text[] IS NULL OR sync_groups && $2::text[])
          AND ($3::uuid[] IS NULL OR id = ANY($3::uuid[]))`,
      [ref.key, groups, keyTeams],
    ));
  }
  const [team] = rows;
  if (!team) throw refNotFound('TeamRef', value, ctx.path);
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
  const groups = groupsFilter(ctx.actor);
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
    throw refNotFound('UserRef', value, ctx.path);
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

/**
 * An invite by id (PLAN-001 S5, session E). Invites are server-only and workspace-wide, with no
 * sync groups; who may act on one is the operation's permission (Admins). Accepted, revoked and
 * expired invites resolve too: what an operation does with them is the handler's call.
 */
async function lookupInvite(value: string, ctx: LookupContext): Promise<RefEntity> {
  const ref = parseIdRef(value);
  const { rows } =
    ref?.by === 'id'
      ? await ctx.db.query<{ id: string }>('SELECT id FROM invites WHERE id = $1', [ref.id])
      : { rows: [] };
  const row = rows[0];
  if (row === undefined) throw refNotFound('InviteRef', value, ctx.path);
  return { id: row.id };
}

/**
 * One of the actor's own live sessions (PLAN-001 S6). Another user's session, an ended one, or
 * any session for an actor without a user (the system actor) is not found: nobody learns which
 * session ids exist.
 */
async function lookupSession(value: string, ctx: LookupContext): Promise<RefEntity> {
  const ref = parseIdRef(value);
  const userId = ctx.actor.userId;
  const { rows } =
    ref?.by === 'id' && userId !== undefined
      ? await ctx.db.query<{ id: string; userId: string }>(
          `SELECT id, user_id AS "userId" FROM sessions
            WHERE id = $1 AND user_id = $2 AND expires_at > now()`,
          [ref.id, userId],
        )
      : { rows: [] };
  const row = rows[0];
  if (row === undefined) throw refNotFound('SessionRef', value, ctx.path);
  return { id: row.id, userId: row.userId };
}

/**
 * A file the actor can see (PLAN-001 S6, PLAN-014 S1; SPEC-014 §4.2): the same rule as
 * `GET /files/:id`, after key narrowing, so any avatar or logo in use resolves, and someone
 * else's upload that nothing uses yet doesn't. Seeing isn't owning: handlers that store a file id
 * also check `uploaderId` (`user.updateProfile`, `workspace.update`; SPEC-003 §4), so another
 * user's file can't be borrowed. An actor without a user (the system) reads no file here.
 *
 * One addition to the download rule (SPEC-014 D28): a detached attachment file of an issue the
 * actor sees resolves too, unreadable as ever, so `attachment.createFile` can undo a removal
 * (§3.5). `detached: true` tells the handlers; every other handler refuses such a file.
 */
async function lookupFile(value: string, ctx: LookupContext): Promise<RefEntity> {
  const ref = parseIdRef(value);
  const reader = fileReaderOf(ctx.actor);
  if (ref?.by !== 'id' || reader === undefined) throw refNotFound('FileRef', value, ctx.path);
  const file = await visibleFile(ctx.db, ref.id, reader);
  if (file !== undefined) {
    return { id: file.id, purpose: file.purpose, uploaderId: file.uploaderId };
  }
  const detached = await reattachableFile(ctx.db, ref.id, reader);
  if (detached === undefined) throw refNotFound('FileRef', value, ctx.path);
  return { ...detached, detached: true };
}

async function lookupStatus(value: string, ctx: LookupContext): Promise<StatusRow> {
  const team = ctx.scopeTeam;
  if (!team) throw invalid(ctx, `Status "${value}" needs a team. Set the team as well.`);
  const teamKey = String(team.key);
  const ref = parseNamedRef(value);
  const groups = groupsFilter(ctx.actor);
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
    throw refNotFound('StatusRef', value, ctx.path, team);
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
// Issues (PLAN-011 S3)

interface IssueRow extends RefEntity {
  teamId: string;
  teamKey: string;
  number: number;
  syncGroups: string[];
}

/**
 * An issue by identifier (`ENG-42`, any case) or id, in every lifecycle state (SPEC-015 §4.3:
 * reads see archived and deleted issues). Visibility is the issue row's own groups, and a key
 * limited to some teams sees no issue of another team, public ones included (SPEC-011 §5.6). A
 * missing issue, one in a private team the actor isn't in and one outside the key's teams are the
 * same `NOT_FOUND` (E13).
 */
/** `issues.number` is a Postgres `integer`. */
const MAX_ISSUE_NUMBER = 2_147_483_647;

function isIssueNumberInRange(n: number): boolean {
  return Number.isSafeInteger(n) && n <= MAX_ISSUE_NUMBER;
}

async function lookupIssue(value: string, ctx: LookupContext): Promise<IssueRow> {
  const ref = parseIssueRef(value);
  const groups = groupsFilter(ctx.actor);
  const keyTeams = ctx.actor.apiKey?.teamIds.length ? ctx.actor.apiKey.teamIds : null;
  const select = `SELECT i.id, i.team_id AS "teamId", t.key AS "teamKey", i.number,
                         i.sync_groups AS "syncGroups"
                    FROM issues i JOIN teams t ON t.id = i.team_id`;
  const visible = `($2::text[] IS NULL OR i.sync_groups && $2::text[])
                   AND ($3::uuid[] IS NULL OR i.team_id = ANY($3::uuid[]))`;
  let rows: IssueRow[] = [];
  if (ref?.by === 'id') {
    ({ rows } = await ctx.db.query<IssueRow>(`${select} WHERE i.id = $1 AND ${visible}`, [
      ref.id,
      groups,
      keyTeams,
    ]));
  } else if (ref?.by === 'identifier' && isIssueNumberInRange(ref.number)) {
    // Team keys are unique and the number is unique per team, so at most one row. A number past
    // the `integer` column can't match, and Postgres would fail on it, so it isn't queried (E13).
    ({ rows } = await ctx.db.query<IssueRow>(
      `${select} WHERE t.key = $1 AND i.number = $4 AND ${visible}`,
      [ref.key, groups, keyTeams, ref.number],
    ));
  }
  const [issue] = rows;
  if (!issue) throw refNotFound('IssueRef', value, ctx.path);
  return issue;
}

// ---------------------------------------------------------------------------------------------
// Comments (PLAN-013 S3)

interface CommentRow extends RefEntity {
  issueId: string;
  teamId: string;
  parentCommentId: string | null;
}

/**
 * A comment by id, of an issue the actor can see (SPEC-013 §6.1, §12): both the issue row and the
 * comment row must meet the actor's visible groups (`visibleGroups`, every public team's
 * included), and a key limited to some teams sees no comment of another team. A
 * missing comment, one on a private team's issue the actor can't see and one outside the key's
 * teams are the same `NOT_FOUND` (permissions.md §5). Soft-deleted comments resolve (`deleted`):
 * resolve and reopen work on a placeholder root; the handlers refuse the rest.
 */
async function lookupComment(value: string, ctx: LookupContext): Promise<CommentRow> {
  const ref = parseIdRef(value);
  const groups = groupsFilter(ctx.actor);
  const keyTeams = ctx.actor.apiKey?.teamIds.length ? ctx.actor.apiKey.teamIds : null;
  const { rows } =
    ref?.by === 'id'
      ? await ctx.db.query<CommentRow>(
          `SELECT c.id, c.issue_id AS "issueId", c.team_id AS "teamId",
                  c.parent_comment_id AS "parentCommentId"
             FROM comments c JOIN issues i ON i.id = c.issue_id
            WHERE c.id = $1
              AND ($2::text[] IS NULL OR (i.sync_groups && $2::text[] AND c.sync_groups && $2::text[]))
              AND ($3::uuid[] IS NULL OR c.team_id = ANY($3::uuid[]))`,
          [ref.id, groups, keyTeams],
        )
      : { rows: [] };
  const [comment] = rows;
  if (!comment) throw refNotFound('CommentRef', value, ctx.path);
  return comment;
}

// ---------------------------------------------------------------------------------------------
// Attachments (PLAN-014 S4a)

interface AttachmentRow extends RefEntity {
  issueId: string;
  teamId: string;
  teamName: string;
  creatorId: string;
  kind: string;
  fileId: string | null;
}

/**
 * An attachment by id, of an issue the actor can see (SPEC-014 §6.2, §5): the issue row and the
 * attachment row must both meet the actor's visible groups, and a key limited to some teams sees
 * no attachment of another team. A missing attachment, one of a private team's issue the actor
 * can't see and one outside the key's teams are the same `NOT_FOUND` (permissions.md §5).
 * `teamName` words a refusal ("members of Engineering").
 */
async function lookupAttachment(value: string, ctx: LookupContext): Promise<AttachmentRow> {
  const ref = parseIdRef(value);
  const groups = groupsFilter(ctx.actor);
  const keyTeams = ctx.actor.apiKey?.teamIds.length ? ctx.actor.apiKey.teamIds : null;
  const { rows } =
    ref?.by === 'id'
      ? await ctx.db.query<AttachmentRow>(
          `SELECT a.id, a.issue_id AS "issueId", a.team_id AS "teamId", t.name AS "teamName",
                  a.creator_id AS "creatorId", a.kind, a.file_id AS "fileId"
             FROM attachments a
             JOIN issues i ON i.id = a.issue_id
             JOIN teams t ON t.id = a.team_id
            WHERE a.id = $1
              AND ($2::text[] IS NULL OR (i.sync_groups && $2::text[] AND a.sync_groups && $2::text[]))
              AND ($3::uuid[] IS NULL OR a.team_id = ANY($3::uuid[]))`,
          [ref.id, groups, keyTeams],
        )
      : { rows: [] };
  const [attachment] = rows;
  if (!attachment) throw refNotFound('AttachmentRef', value, ctx.path);
  return attachment;
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
  const ref = parseLabelRef(value);
  const groups = groupsFilter(ctx.actor);
  // An API key limited to teams sees their labels and workspace labels only, as for issues.
  const keyTeams = ctx.actor.apiKey?.teamIds.length ? ctx.actor.apiKey.teamIds : null;
  let rows: LabelRow[] = [];
  const columns = `l.id, l.team_id AS "teamId", l.parent_id AS "parentId", p.name AS "groupName",
              l.name, l.is_group AS "isGroup", l.sync_groups AS "syncGroups"`;
  // `$2` is null without a team scope, so only workspace labels (team_id IS NULL) match by name.
  if (ref?.by === 'id') {
    // SPEC-010 §6: an id resolves to any label the actor can see, with or without a team.
    ({ rows } = await ctx.db.query<LabelRow>(
      `SELECT ${columns}
         FROM labels l LEFT JOIN labels p ON p.id = l.parent_id
        WHERE l.id = $1 AND ($2::text[] IS NULL OR l.sync_groups && $2::text[])
          AND ($3::uuid[] IS NULL OR l.team_id IS NULL OR l.team_id = ANY($3::uuid[]))`,
      [ref.id, groups, keyTeams],
    ));
  } else if (ref?.by === 'name' || ref?.by === 'groupLabel') {
    ({ rows } = await ctx.db.query<LabelRow>(
      `SELECT ${columns}
         FROM labels l LEFT JOIN labels p ON p.id = l.parent_id
        WHERE lower(l.name) = lower($1) AND (l.team_id IS NULL OR l.team_id = $2::uuid)
          AND ($3::text[] IS NULL OR l.sync_groups && $3::text[])
          AND ($4::text IS NULL OR lower(p.name) = lower($4))
          AND ($5::uuid[] IS NULL OR l.team_id IS NULL OR l.team_id = ANY($5::uuid[]))
        ORDER BY p.name COLLATE "C" NULLS FIRST, l.name COLLATE "C", l.id`,
      [ref.name, team?.id ?? null, groups, ref.by === 'groupLabel' ? ref.group : null, keyTeams],
    ));
  }

  // SPEC-003 §4: the team's labels win over workspace labels with the same name.
  const teamRows = ref?.by === 'id' ? [] : rows.filter((row) => row.teamId !== null);
  const pool = teamRows.length > 0 ? teamRows : rows;

  const picked = pickByName(pool, (row) => row.name === (ref && 'name' in ref ? ref.name : ''));
  if (picked === undefined) {
    throw refNotFound('LabelRef', value, ctx.path, team);
  }
  if (isAmbiguous(picked)) {
    const names = candidates(picked.ambiguous, (l) =>
      l.groupName ? `${l.groupName}/${l.name}` : l.name,
    );
    // E9: "2 labels named 'Small': Size/Small, Scope/Small. Use Group/Label or the label id."
    throw invalid(
      ctx,
      `${picked.ambiguous.length} labels named '${picked.ambiguous[0]?.name ?? value}': ${names
        .map((c) => c.label)
        .join(', ')}. Use Group/Label or the label id.`,
      names,
    );
  }
  return picked;
}
