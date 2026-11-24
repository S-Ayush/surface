/**
 * Reference types (SPEC-003 §4): inputs name other entities in human-friendly forms (`ENG`,
 * `me`, an email, a status name), and the executor resolves them to rows before the
 * permission check. Parsed input keeps the reference as the caller wrote it, so inputs stay
 * plain JSON for the mutation queue and idempotency records; the resolvers do the lookup.
 */
import { z } from 'zod';

/** JSON Schema / Zod metadata key naming the reference type of a field (SPEC-003 §10). */
export const SURFACE_REF_KEY = 'x-surface-ref';
/** Metadata key naming the input field a scoped reference resolves within (SPEC-003 §4). */
export const SURFACE_REF_SCOPE_KEY = 'x-surface-ref-scope';
/** Metadata key on a `UserRef` that also accepts deactivated users. */
export const SURFACE_REF_ALLOW_INACTIVE_KEY = 'x-surface-ref-allow-inactive';
/**
 * Metadata key on a `FileRef` that also resolves a detached attachment file of an issue the
 * caller sees (SPEC-014 D28): only `attachment.createFile`'s `file`, for the undo of a removal.
 */
export const SURFACE_REF_ALLOW_DETACHED_KEY = 'x-surface-ref-allow-detached';

export const REF_TYPES = [
  'TeamRef',
  'UserRef',
  'StatusRef',
  'LabelRef',
  'IssueRef',
  'CycleRef',
  'ProjectRef',
  'InitiativeRef',
  'DocumentRef',
  'ViewRef',
  'InviteRef',
  'SessionRef',
  'FileRef',
  'CommentRef',
  'AttachmentRef',
] as const;

export type RefType = (typeof REF_TYPES)[number];

export function isRefType(value: unknown): value is RefType {
  return typeof value === 'string' && (REF_TYPES as readonly string[]).includes(value);
}

/**
 * Reference types whose entities exist (M0's, `IssueRef` from PLAN-011 S3, `CommentRef` from
 * PLAN-013 S3 and `AttachmentRef` from PLAN-014 S4a). The others are declared for docs and lint.
 */
export const AVAILABLE_REF_TYPES: ReadonlySet<RefType> = new Set([
  'TeamRef',
  'UserRef',
  'StatusRef',
  'LabelRef',
  'IssueRef',
  'InviteRef',
  'SessionRef',
  'FileRef',
  'CommentRef',
  'AttachmentRef',
]);

/** First milestone where an unavailable reference type can be resolved. */
export const REF_AVAILABLE_FROM: Readonly<Record<RefType, string>> = {
  TeamRef: 'M0',
  UserRef: 'M0',
  StatusRef: 'M0',
  LabelRef: 'M0',
  IssueRef: 'M1',
  CycleRef: 'M1',
  ProjectRef: 'M3',
  InitiativeRef: 'M3',
  DocumentRef: 'M3',
  ViewRef: 'M2',
  InviteRef: 'M0',
  SessionRef: 'M0',
  FileRef: 'M0',
  CommentRef: 'M1',
  AttachmentRef: 'M1',
};

/**
 * A row a reference resolved to. `syncGroups` is the row's visibility, used by `p.canSee`.
 * Server and client resolvers both return this shape.
 */
export interface RefEntity {
  readonly id: string;
  readonly [field: string]: unknown;
}

// ---------------------------------------------------------------------------------------------
// Formats

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TEAM_KEY = /^[A-Za-z]{2,5}$/;
const IDENTIFIER = /^([A-Za-z]{2,5})-([1-9][0-9]*)$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** What a reference string means before lookup. Lookups are case-insensitive. */
export type ParsedRef =
  | { readonly by: 'id'; readonly id: string }
  | { readonly by: 'key'; readonly key: string }
  | { readonly by: 'me' }
  | { readonly by: 'email'; readonly email: string }
  | { readonly by: 'name'; readonly name: string }
  | { readonly by: 'groupLabel'; readonly group: string; readonly name: string }
  | { readonly by: 'identifier'; readonly key: string; readonly number: number }
  | { readonly by: 'number'; readonly number: number }
  | { readonly by: 'relative'; readonly which: 'current' | 'next' | 'previous' };

/** `uuid` or a team key (any case; keys are stored uppercase). */
export function parseTeamRef(value: string): ParsedRef | undefined {
  const v = value.trim();
  if (isUuid(v)) return { by: 'id', id: v.toLowerCase() };
  if (TEAM_KEY.test(v)) return { by: 'key', key: v.toUpperCase() };
  return undefined;
}

/** `uuid`, `me`, an email, or a display name, tried in that order. */
export function parseUserRef(value: string): ParsedRef | undefined {
  const v = value.trim();
  if (v === '') return undefined;
  if (isUuid(v)) return { by: 'id', id: v.toLowerCase() };
  if (v.toLowerCase() === 'me') return { by: 'me' };
  if (EMAIL.test(v)) return { by: 'email', email: v.toLowerCase() };
  return { by: 'name', name: v };
}

/** `uuid` or an exact name: statuses, labels, projects, initiatives, documents, views. */
export function parseNamedRef(value: string): ParsedRef | undefined {
  const v = value.trim();
  if (v === '') return undefined;
  if (isUuid(v)) return { by: 'id', id: v.toLowerCase() };
  return { by: 'name', name: v };
}

/**
 * `uuid`, `Group/Label` (spaces around the `/` ignored, SPEC-010 D19), or an exact name. A name
 * has no `/` of its own (SPEC-010 §4.2), so the first `/` always separates the group.
 */
export function parseLabelRef(value: string): ParsedRef | undefined {
  const v = value.trim();
  if (v === '') return undefined;
  if (isUuid(v)) return { by: 'id', id: v.toLowerCase() };
  const slash = v.indexOf('/');
  if (slash < 0) return { by: 'name', name: v };
  const group = v.slice(0, slash).trim();
  const name = v.slice(slash + 1).trim();
  return group === '' || name === '' ? undefined : { by: 'groupLabel', group, name };
}

/** `uuid` only: invites and sessions have no name to look up (PLAN-001 S5). */
export function parseIdRef(value: string): ParsedRef | undefined {
  const v = value.trim();
  return isUuid(v) ? { by: 'id', id: v.toLowerCase() } : undefined;
}

/** `uuid` or an identifier like `ENG-123`. */
export function parseIssueRef(value: string): ParsedRef | undefined {
  const v = value.trim();
  if (isUuid(v)) return { by: 'id', id: v.toLowerCase() };
  const match = IDENTIFIER.exec(v);
  if (match?.[1] && match[2]) {
    return { by: 'identifier', key: match[1].toUpperCase(), number: Number(match[2]) };
  }
  return undefined;
}

/** `uuid`, a cycle number, or `current` / `next` / `previous`. */
export function parseCycleRef(value: string | number): ParsedRef | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? { by: 'number', number: value } : undefined;
  }
  const v = value.trim();
  if (isUuid(v)) return { by: 'id', id: v.toLowerCase() };
  const lower = v.toLowerCase();
  if (lower === 'current' || lower === 'next' || lower === 'previous') {
    return { by: 'relative', which: lower };
  }
  if (/^[1-9][0-9]*$/.test(v)) return { by: 'number', number: Number(v) };
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Schemas

interface RefMeta {
  readonly [SURFACE_REF_KEY]: RefType;
  readonly description: string;
  readonly [SURFACE_REF_SCOPE_KEY]?: string;
  readonly [SURFACE_REF_ALLOW_INACTIVE_KEY]?: true;
  readonly [SURFACE_REF_ALLOW_DETACHED_KEY]?: true;
}

function refString(
  type: RefType,
  description: string,
  parse: (value: string) => ParsedRef | undefined,
  invalid: string,
  extra: Partial<RefMeta> = {},
) {
  return z
    .string()
    .max(320)
    .refine((value) => parse(value) !== undefined, { message: invalid })
    .meta({ [SURFACE_REF_KEY]: type, description, ...extra });
}

export const TeamRef = refString(
  'TeamRef',
  'Team key like ENG (any case), or a team id',
  parseTeamRef,
  'Use a team key like ENG, or a team id',
);

export const UserRef = refString(
  'UserRef',
  'User id, email, display name, or "me". Active users only',
  parseUserRef,
  'Use a user id, an email, a display name, or "me"',
);

/** A `UserRef` that also resolves deactivated users (e.g. `user.reactivate`). */
export const UserRefIncludingInactive = refString(
  'UserRef',
  'User id, email, display name, or "me". Includes deactivated users',
  parseUserRef,
  'Use a user id, an email, a display name, or "me"',
  { [SURFACE_REF_ALLOW_INACTIVE_KEY]: true },
);

/** Scoped to the team in the input field `team` by default; see `scopedTo`. */
export const StatusRef = refString(
  'StatusRef',
  'Status name in the team, like In Progress (any case), or a status id',
  parseNamedRef,
  'Use a status name or a status id',
  { [SURFACE_REF_SCOPE_KEY]: 'team' },
);

/** Team label first, then workspace label. Scoped to the input field `team` when present. */
export const LabelRef = refString(
  'LabelRef',
  "Label name (the team's labels first, then workspace labels), Group/Label for a label inside a group, or a label id",
  parseLabelRef,
  'Use a label name, Group/Label, or a label id',
  { [SURFACE_REF_SCOPE_KEY]: 'team' },
);

export const IssueRef = refString(
  'IssueRef',
  'Issue identifier like ENG-123 (old identifiers work after a team move), or an issue id',
  parseIssueRef,
  'Use an issue identifier like ENG-123, or an issue id',
);

/**
 * An invite, by id only (PLAN-001 S5): its email would let anyone who may call the operation
 * probe which addresses have pending invites, since lookup runs before the permission check.
 * Server-only, so the client never resolves one.
 */
export const InviteRef = refString(
  'InviteRef',
  'Invite id, from invite.list',
  parseIdRef,
  'Use an invite id from invite.list',
);

/**
 * One of your own sessions, by id from session.list (PLAN-001 S6). Ids only: sessions have
 * nothing people type. Another user's session is NOT_FOUND. Server-only, like InviteRef.
 */
export const SessionRef = refString(
  'SessionRef',
  'Session id, from session.list',
  parseIdRef,
  'Use a session id from session.list',
);

/**
 * An uploaded file, by the id `POST /files/upload` returned (ADR-0014; PLAN-001 S6: avatars and the
 * workspace logo). Ids only, and only a file you uploaded resolves. Server-only, like InviteRef.
 */
export const FileRef = refString(
  'FileRef',
  'File id, from POST /files/upload',
  parseIdRef,
  'Use a file id from POST /files/upload',
);

/**
 * A `FileRef` that also resolves a detached attachment file of an issue the caller sees (SPEC-014
 * D28), so `attachment.createFile` can undo a removal (§3.5). Opt-in: every other `FileRef` answers
 * `NOT_FOUND` for such a file, exactly like an unknown id.
 */
export const FileRefIncludingDetached = refString(
  'FileRef',
  'File id, from POST /files/upload, or the file of an attachment removed from the same issue',
  parseIdRef,
  'Use a file id from POST /files/upload',
  { [SURFACE_REF_ALLOW_DETACHED_KEY]: true },
);

/**
 * A comment, by id only (SPEC-013 §6.1, §12): resolved to a comment of an issue the caller can
 * see; anything else is NOT_FOUND, worded as for a comment that doesn't exist.
 */
export const CommentRef = refString(
  'CommentRef',
  'Comment id, from comment.list',
  parseIdRef,
  'Use a comment id from comment.list',
);

/**
 * An attachment, by id only (SPEC-014 §6.2, PLAN-014 S4a): resolved to an attachment of an issue
 * the caller can see; anything else is NOT_FOUND, worded as for an attachment that doesn't exist.
 */
export const AttachmentRef = refString(
  'AttachmentRef',
  'Attachment id, from issue.get',
  parseIdRef,
  'Use an attachment id from issue.get',
);

export const CycleRef = z
  .union([z.string().max(64), z.number().int().positive()])
  .refine((value) => parseCycleRef(value) !== undefined, {
    message: 'Use a cycle number, "current", "next", "previous", or a cycle id',
  })
  .meta({
    [SURFACE_REF_KEY]: 'CycleRef',
    description: 'Cycle number, "current", "next", "previous", or a cycle id. Scoped to the team',
    [SURFACE_REF_SCOPE_KEY]: 'team',
  });

function namedRef(type: RefType, noun: string) {
  return refString(
    type,
    `Exact ${noun} name, or a ${noun} id`,
    parseNamedRef,
    `Use a ${noun} name or a ${noun} id`,
  );
}

export const ProjectRef = namedRef('ProjectRef', 'project');
export const InitiativeRef = namedRef('InitiativeRef', 'initiative');
export const DocumentRef = namedRef('DocumentRef', 'document');
export const ViewRef = namedRef('ViewRef', 'view');

/**
 * Re-scopes a scoped reference to another input field, e.g. a status that belongs to the
 * team in `toTeam`: `scopedTo(StatusRef, 'toTeam')`. The scope field must be a `TeamRef` at the
 * top level of the input: the resolver looks it up by key, not by dot-path.
 */
export function scopedTo<T extends z.ZodType>(ref: T, field: string): T {
  return ref.meta({ ...ref.meta(), [SURFACE_REF_SCOPE_KEY]: field });
}

// ---------------------------------------------------------------------------------------------
// Client resolution (implemented over the client store in PLAN-002 S6)

/** The outcome of looking one reference up. */
export type RefLookup =
  | { readonly status: 'found'; readonly entity: RefEntity }
  | { readonly status: 'notFound' }
  | { readonly status: 'ambiguous'; readonly candidates: readonly RefEntity[] };

export interface RefLookupOptions {
  /** Team id for scoped references (statuses, team labels, cycles). */
  readonly scopeTeamId?: string;
  /** `UserRef` only: also match deactivated users. */
  readonly allowInactive?: boolean;
}

/**
 * Resolves references against the local replica, for `optimistic()` and command-menu parsing
 * (SPEC-003 §4). It follows the server's rules: same formats, same ambiguity, and rows outside
 * the replica are `notFound`. `me` is the signed-in user.
 */
export interface ClientRefResolver {
  resolve(type: RefType, value: string | number, options?: RefLookupOptions): RefLookup;
}
