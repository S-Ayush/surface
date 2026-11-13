/**
 * An issue's lifecycle (SPEC-015 §4): its state, the 30-day boundary, the transitions of §4.2,
 * the refusal messages, and the lifecycle rule table of §4.3 as data. Shared by the server's
 * `lockIssueForWrite` and handlers and by the client (optimistic code, `ui.available`), so both
 * sides decide the same way. PLAN-011 S3 added the state and the edit refusal; PLAN-015 S1 adds
 * the rest.
 */

/** Live, Archived or Deleted. A purged issue has no row, so no state. */
export const ISSUE_LIFECYCLES = ['live', 'archived', 'deleted'] as const;
export type IssueLifecycle = (typeof ISSUE_LIFECYCLES)[number];

export interface LifecycleFields {
  /** Any truthy value means set: an ISO string on the client, a `Date` on the server. */
  readonly archivedAt: unknown;
  readonly deletedAt: unknown;
}

const isSet = (value: unknown): boolean => value !== null && value !== undefined;

/** Deleted whenever `deletedAt` is set, whatever `archivedAt` is (SPEC-015 §4.1). */
export function lifecycleOf(issue: LifecycleFields): IssueLifecycle {
  if (isSet(issue.deletedAt)) return 'deleted';
  return isSet(issue.archivedAt) ? 'archived' : 'live';
}

/**
 * Why a direct edit of an issue (or of its children) is refused in `state`, or undefined when it
 * is live (SPEC-015 §4.3). `identifier` is `ENG-42`. It holds even for an edit that changes
 * nothing (SPEC-011 E12).
 */
export function editRefusal(identifier: string, state: IssueLifecycle): string | undefined {
  switch (state) {
    case 'live':
      return undefined;
    case 'archived':
      return `${identifier} is archived. Restore it to edit it.`;
    case 'deleted':
      return `${identifier} was deleted. Restore it to edit it.`;
  }
}

// ---------------------------------------------------------------------------------------------
// The 30-day boundary (SPEC-015 §4.2)

/** How long a deleted issue stays restorable: 30 × 24 h, so daylight saving never shifts it. */
export const RETENTION_HOURS = 720;
const RETENTION_MS = RETENTION_HOURS * 60 * 60 * 1000;

/** `deletedAt + 720 h`, in UTC. From then on the issue can't be restored and may be purged. */
export function purgeAfter(deletedAt: Date | string): Date {
  const at = typeof deletedAt === 'string' ? Date.parse(deletedAt) : deletedAt.getTime();
  if (Number.isNaN(at)) throw new Error(`Not a timestamp: ${String(deletedAt)}`);
  return new Date(at + RETENTION_MS);
}

/** A deleted issue's `deletedAt` as a timestamp the boundary reads, or undefined when not set. */
function deletedAtOf(issue: LifecycleFields): Date | string | undefined {
  const value = issue.deletedAt;
  return value instanceof Date || typeof value === 'string' ? value : undefined;
}

/**
 * Whether `issue.restore` would bring the issue back to Live at `now`: an archived issue always
 * (no time limit), a deleted one only while `now < purgeAfter` (D6), a live one never (there is
 * nothing to restore; the restore is a no-op).
 */
export function canRestore(issue: LifecycleFields, now: Date): boolean {
  switch (lifecycleOf(issue)) {
    case 'live':
      return false;
    case 'archived':
      return true;
    case 'deleted': {
      const deletedAt = deletedAtOf(issue);
      return deletedAt !== undefined && now.getTime() < purgeAfter(deletedAt).getTime();
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Transitions (SPEC-015 §4.2)

/** What an operation does to an issue's lifecycle, as the rule table groups operations. */
export const LIFECYCLE_ACTIONS = [
  /** A direct edit of the issue or its children (`issue.update`, comments, …). */
  'edit',
  'delete',
  'restore',
  'purge',
  /** The `auto-archive` and `auto-close` jobs: live issues only. */
  'autoArchive',
  /** A settings cascade or system write: applies in every state, changes no state. */
  'cascade',
] as const;
export type LifecycleAction = (typeof LIFECYCLE_ACTIONS)[number];

/** Why an operation is refused, and the §4.2 message for each (`lifecycleRefusal`). */
export type LifecycleConflict = 'archived' | 'deleted' | 'expired' | 'notDeleted';

/** The `archivedAt` and `deletedAt` an issue has after a transition. */
export interface LifecycleStamps<T> {
  readonly archivedAt: T | null;
  readonly deletedAt: T | null;
}

/**
 * The result of an action on an issue in one state:
 * - `applies`: the operation proceeds and leaves the lifecycle alone (an edit of a live issue, a
 *   cascade);
 * - `noop`: nothing changes, so nothing is written, logged, recorded or emitted (§4.2 idempotence);
 * - `skipped`: a job leaves the issue alone (not live any more);
 * - `conflict`: refused with `CONFLICT` and the message of `lifecycleRefusal`;
 * - `moves`: the issue goes to `to`, with these stamps (`purged`: the row is deleted).
 */
export type LifecycleStep<T> =
  | { readonly kind: 'applies' }
  | { readonly kind: 'noop' }
  | { readonly kind: 'skipped' }
  | { readonly kind: 'conflict'; readonly conflict: LifecycleConflict }
  | { readonly kind: 'moves'; readonly to: IssueLifecycle; readonly stamps: LifecycleStamps<T> }
  | { readonly kind: 'purged' };

/**
 * SPEC-015 §4.2 as a function: what `action` does to `issue` at `now`. Delete keeps `archivedAt`
 * (it comes back only with a restore, which clears both, D12). The server handlers and the
 * property test run it; the stamps it returns are what the handler writes.
 */
export function lifecycleStep<T>(
  action: LifecycleAction,
  issue: LifecycleStamps<T>,
  now: Date,
  stamp: T,
): LifecycleStep<T> {
  const state = lifecycleOf(issue);
  switch (action) {
    case 'cascade':
      return { kind: 'applies' };
    case 'edit':
      return state === 'live' ? { kind: 'applies' } : { kind: 'conflict', conflict: state };
    case 'autoArchive':
      return state === 'live'
        ? { kind: 'moves', to: 'archived', stamps: { archivedAt: stamp, deletedAt: null } }
        : { kind: 'skipped' };
    case 'delete':
      return state === 'deleted'
        ? { kind: 'noop' }
        : {
            kind: 'moves',
            to: 'deleted',
            stamps: { archivedAt: issue.archivedAt, deletedAt: stamp },
          };
    case 'restore':
      if (state === 'live') return { kind: 'noop' };
      if (!canRestore(issue, now)) return { kind: 'conflict', conflict: 'expired' };
      return { kind: 'moves', to: 'live', stamps: { archivedAt: null, deletedAt: null } };
    case 'purge':
      return state === 'deleted'
        ? { kind: 'purged' }
        : { kind: 'conflict', conflict: 'notDeleted' };
  }
}

/** The §4.2 message for a refused operation on `identifier` (`ENG-42`). */
export function lifecycleRefusal(identifier: string, conflict: LifecycleConflict): string {
  switch (conflict) {
    case 'archived':
    case 'deleted':
      return editRefusal(identifier, conflict) ?? '';
    case 'expired':
      return `${identifier} was deleted more than 30 days ago and can't be restored.`;
    case 'notDeleted':
      return `Delete ${identifier} first.`;
  }
}

// ---------------------------------------------------------------------------------------------
// The lifecycle rule table (SPEC-015 §4.3)

/**
 * How `lockIssueForWrite` treats an issue's lifecycle (SPEC-015 §4.4):
 * - `edit`: a direct edit by a user, API or MCP actor; archived or deleted is `CONFLICT`;
 * - `lifecycle`: delete, restore, purge and the jobs' transitions; the lock returns the state and
 *   the handler applies `lifecycleStep`;
 * - `cascade`: settings cascades and system writes; no check.
 */
export const ISSUE_LOCK_MODES = ['edit', 'lifecycle', 'cascade'] as const;
export type IssueLockMode = (typeof ISSUE_LOCK_MODES)[number];

/**
 * Why a lock in `mode` refuses an issue in `state` (worded by `lifecycleRefusal`), or undefined
 * when the handler may go on: only `edit` refuses, and only outside Live.
 */
export function lockRefusal(
  mode: IssueLockMode,
  state: IssueLifecycle,
): 'archived' | 'deleted' | undefined {
  return mode === 'edit' && state !== 'live' ? state : undefined;
}

/**
 * The outcome a table row lists for one state, in the words of §4.3. `toLiveBeforePurgeAfter` is
 * restore of a deleted issue: Live before `purgeAfter`, `CONFLICT` from then on.
 */
export type LifecycleOutcome =
  | 'applies'
  | 'conflict'
  | 'noop'
  | 'skipped'
  | 'keepsState'
  | 'toArchived'
  | 'toDeleted'
  | 'toLive'
  | 'toLiveBeforePurgeAfter'
  | 'toPurged';

export interface LifecycleRule {
  /** An operation name, or a job's queue name (`files-cleanup`, `trash-purge`). */
  readonly kind: 'operation' | 'job';
  readonly mode: IssueLockMode;
  readonly action: LifecycleAction;
  readonly live: LifecycleOutcome;
  readonly archived: LifecycleOutcome;
  readonly deleted: LifecycleOutcome;
  /** The spec that owns the operation. */
  readonly spec: string;
  /**
   * The plan slice that wires this row's handler to the lock, while it is not built yet. The
   * table test lists these rows as pending; PLAN-015 S5 checks none is left.
   */
  readonly pending?: string;
}

const EDIT = {
  kind: 'operation',
  mode: 'edit',
  action: 'edit',
  live: 'applies',
  archived: 'conflict',
  deleted: 'conflict',
} as const;

const CASCADE = {
  mode: 'cascade',
  action: 'cascade',
  live: 'applies',
  archived: 'keepsState',
  deleted: 'keepsState',
} as const;

const AUTO = {
  kind: 'operation',
  mode: 'lifecycle',
  action: 'autoArchive',
  live: 'applies',
  archived: 'skipped',
  deleted: 'skipped',
  spec: 'SPEC-015',
  pending: 'PLAN-015 S3',
} as const;

/**
 * SPEC-015 §4.3, one row per operation (or job) that writes an issue or its children. A new
 * operation that does must add its row here, in the same change, and its handler must take the
 * issue lock in the row's mode (`apps/server/test/issue-lifecycle-table.test.ts` fails
 * otherwise). Reads (`issue.get`, `IssueRef`, `/sync/content`, `GET /files/:id`) see every state
 * and take no lock, so they have no row.
 */
export const ISSUE_LIFECYCLE_RULES: Readonly<Record<string, LifecycleRule>> = {
  'issue.update': { ...EDIT, spec: 'SPEC-011' },
  'issue.updateDescription': { ...EDIT, spec: 'SPEC-011', pending: 'PLAN-011 S6' },
  'comment.create': { ...EDIT, spec: 'SPEC-013', pending: 'PLAN-013 S3' },
  'comment.update': { ...EDIT, spec: 'SPEC-013', pending: 'PLAN-013 S3' },
  'comment.delete': { ...EDIT, spec: 'SPEC-013', pending: 'PLAN-013 S3' },
  'comment.resolve': { ...EDIT, spec: 'SPEC-013', pending: 'PLAN-013 S3' },
  'comment.reopen': { ...EDIT, spec: 'SPEC-013', pending: 'PLAN-013 S3' },
  'reaction.set': { ...EDIT, spec: 'SPEC-013', pending: 'PLAN-013 S4' },
  'attachment.createFile': { ...EDIT, spec: 'SPEC-014', pending: 'PLAN-014 S4a' },
  'attachment.createLink': { ...EDIT, spec: 'SPEC-014', pending: 'PLAN-014 S4a' },
  'attachment.update': { ...EDIT, spec: 'SPEC-014', pending: 'PLAN-014 S4a' },
  'attachment.delete': { ...EDIT, spec: 'SPEC-014', pending: 'PLAN-014 S4a' },
  'issue.delete': {
    kind: 'operation',
    mode: 'lifecycle',
    action: 'delete',
    live: 'toDeleted',
    archived: 'toDeleted',
    deleted: 'noop',
    spec: 'SPEC-015',
  },
  'issue.restore': {
    kind: 'operation',
    mode: 'lifecycle',
    action: 'restore',
    live: 'noop',
    archived: 'toLive',
    deleted: 'toLiveBeforePurgeAfter',
    spec: 'SPEC-015',
  },
  'issue.purge': {
    kind: 'operation',
    mode: 'lifecycle',
    action: 'purge',
    live: 'conflict',
    archived: 'conflict',
    deleted: 'toPurged',
    spec: 'SPEC-015',
    pending: 'PLAN-015 S2',
  },
  // Through `removeLabelFromIssues` (`repo.updateWhere`, `touchUpdatedAt: false`), which locks
  // the issues in ascending id; `label.delete` calls it from PLAN-010 S5.
  'label.delete': { ...CASCADE, kind: 'operation', spec: 'SPEC-010', pending: 'PLAN-010 S5' },
  'attachment.setPreview': {
    ...CASCADE,
    kind: 'operation',
    spec: 'SPEC-014',
    pending: 'PLAN-014 S4b',
  },
  'files-cleanup': { ...CASCADE, kind: 'job', spec: 'SPEC-014', pending: 'PLAN-014 S4a' },
  'trash-purge': { ...CASCADE, kind: 'job', spec: 'SPEC-015', pending: 'PLAN-015 S2' },
  'issue.autoArchive': { ...AUTO },
  'issue.autoClose': { ...AUTO },
};

/** The rule of `operation`; throws for one the table doesn't list (a bug, never input). */
export function lifecycleRule(operation: string): LifecycleRule {
  const rule = ISSUE_LIFECYCLE_RULES[operation];
  if (rule === undefined) {
    throw new Error(`${operation} has no row in the lifecycle rule table (SPEC-015 §4.3)`);
  }
  return rule;
}

/** The lock mode the table gives `operation`'s handler. */
export function issueLockModeOf(operation: string): IssueLockMode {
  return lifecycleRule(operation).mode;
}

/**
 * The table's outcome for a step, so a test can compare `lifecycleStep` with a row. A restore of
 * a deleted issue reads as `toLiveBeforePurgeAfter` whichever side of the boundary it falls on.
 */
export function outcomeOf(
  action: LifecycleAction,
  state: IssueLifecycle,
  step: LifecycleStep<unknown>,
): LifecycleOutcome {
  switch (step.kind) {
    case 'applies':
      return action === 'cascade' && state !== 'live' ? 'keepsState' : 'applies';
    case 'noop':
      return 'noop';
    case 'skipped':
      return 'skipped';
    case 'purged':
      return 'toPurged';
    case 'conflict':
      return action === 'restore' && step.conflict === 'expired'
        ? 'toLiveBeforePurgeAfter'
        : 'conflict';
    case 'moves':
      if (action === 'autoArchive') return 'applies';
      if (action === 'restore' && state === 'deleted') return 'toLiveBeforePurgeAfter';
      return step.to === 'archived' ? 'toArchived' : step.to === 'deleted' ? 'toDeleted' : 'toLive';
  }
}
