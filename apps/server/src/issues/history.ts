/**
 * The issue history writer (SPEC-011 §4.4; PLAN-011 S6). Every IssueHistory row is written here,
 * through the repo, in the operation's transaction. The rules (what an entry holds, the two folds)
 * are the domain's (`packages/domain/src/issue-history.ts`); this module reads what they need and
 * writes what they decide.
 *
 * - `writeCreatedHistory`: `issue.create`'s `created` entry.
 * - `writeUpdatedHistory`: one `updated` entry per changing operation, or a fold into the latest
 *   entry. **Call it after the issue row lock** (`lockIssueForWrite`), in any mode: the fold reads
 *   the latest entry, and only the issue lock keeps two folds from racing (§4.4). PLAN-015 S3's
 *   auto-close job calls it as the system actor with the status change (`cascade` mode lock).
 * - `writeLifecycleEntry`: `deleted`, `restored` and `archived` (the auto-archive job, actor
 *   `system`): empty `changes`, never folded.
 *
 * Names are snapshotted when the entry is written (E16): every row named is visible to whoever
 * sees the issue in M1 (its team's statuses and labels, workspace labels, users), so an entry
 * never stores what one of its viewers can't see.
 */
import {
  type AttachmentChange,
  historyEntryFor,
  historyWrite,
  type Actor,
  type HistoryActorFacts,
  type HistoryDiff,
  type HistoryEntryFacts,
  type HistoryLabel,
  type HistoryNamed,
  type HistoryStatus,
  type IssueChangeSet,
  type IssueHistoryKind,
} from '@surface/domain';
import { desc, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { issueHistory, labels, users, workflowStatuses } from '../db/schema/index.js';
import { uuidv7 } from '../db/uuidv7.js';
import type { HandlerContext } from '../executor/context.js';
import type { ModelRow } from '../sync/models.js';
import type { Repo } from '../sync/repo.js';

export type IssueHistoryRow = ModelRow<'IssueHistory'>;

/** The named rows an entry snapshots, by id. */
export interface HistoryNames {
  readonly statuses: ReadonlyMap<string, HistoryStatus>;
  readonly users: ReadonlyMap<string, HistoryNamed>;
  readonly labels: ReadonlyMap<string, HistoryLabel>;
}

/** What the writer reads, in the operation's transaction. Plain reads: no lock is taken. */
export interface HistoryAccess {
  /** The issue's latest entry, by creation (`createdAt`, then id). */
  latestHistory(issueId: string): Promise<IssueHistoryRow | undefined>;
  /** The names of the given statuses, users and labels; missing ones are left out. */
  historyNames(ids: {
    readonly statusIds: readonly string[];
    readonly userIds: readonly string[];
    readonly labelIds: readonly string[];
  }): Promise<HistoryNames>;
}

/** Everything the writer needs from the operation. */
export interface HistoryWriteContext {
  readonly access: HistoryAccess;
  readonly repo: Repo;
  readonly actor: Actor;
  readonly now: Date;
}

/** The issue fields the writer reads. */
export type HistoryIssue = Pick<ModelRow<'Issue'>, 'id' | 'teamId' | 'creatorId' | 'createdAt'>;

/**
 * Who writes an entry (§4.4): the actor's kind, its user (the key's owner for `api` and `mcp`,
 * none for `system`) and its API key.
 */
export function historyActorOf(actor: Actor): HistoryActorFacts {
  if (actor.kind === 'system') return { actorKind: 'system', actorId: null, apiKeyId: null };
  const actorId = actor.userId;
  if (actorId === undefined) throw new Error(`A ${actor.kind} actor without a user writes history`);
  const keyed = actor.kind === 'api' || actor.kind === 'mcp';
  return { actorKind: actor.kind, actorId, apiKeyId: keyed ? (actor.apiKey?.id ?? null) : null };
}

/** `HistoryAccess` over a transaction. */
export function historyAccess(tx: NodePgDatabase): HistoryAccess {
  return {
    async latestHistory(issueId) {
      const [row] = await tx
        .select()
        .from(issueHistory)
        .where(eq(issueHistory.issueId, issueId))
        .orderBy(desc(issueHistory.createdAt), desc(issueHistory.id))
        .limit(1);
      return row;
    },
    async historyNames({ statusIds, userIds, labelIds }) {
      const statusRows =
        statusIds.length === 0
          ? []
          : await tx
              .select({
                id: workflowStatuses.id,
                name: workflowStatuses.name,
                category: workflowStatuses.category,
              })
              .from(workflowStatuses)
              .where(inArray(workflowStatuses.id, [...statusIds]));
      const userRows =
        userIds.length === 0
          ? []
          : await tx
              .select({ id: users.id, name: users.name })
              .from(users)
              .where(inArray(users.id, [...userIds]));
      const labelRows =
        labelIds.length === 0
          ? []
          : await tx
              .select({ id: labels.id, name: labels.name, color: labels.color })
              .from(labels)
              .where(inArray(labels.id, [...labelIds]));
      return {
        statuses: new Map(statusRows.map((s) => [s.id, s])),
        users: new Map(userRows.map((u) => [u.id, u])),
        labels: new Map(labelRows.map((l) => [l.id, l])),
      };
    },
  };
}

/** The writer's context for a handler. */
export function historyWriteContext(ctx: HandlerContext): HistoryWriteContext {
  return { access: historyAccess(ctx.tx), repo: ctx.repo, actor: ctx.actor, now: ctx.now() };
}

// ---------------------------------------------------------------------------------------------

function named<T>(map: ReadonlyMap<string, T>, id: string, what: string): T {
  const found = map.get(id);
  // Statuses and users can't be deleted under an issue (foreign keys): a miss is a bug.
  if (found === undefined) throw new Error(`History names a missing ${what} ${id}`);
  return found;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
const nullableString = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;
const nullableNumber = (value: unknown): number | null =>
  typeof value === 'number' ? value : null;

/**
 * `issueChangeSet`'s id-level changes with their names (§4.4), plus the description's emptiness.
 * A label the cascade removed meanwhile is left out of the names, like an output does.
 */
async function namedDiff(
  access: HistoryAccess,
  changes: IssueChangeSet,
  description: { readonly empty: boolean } | undefined,
): Promise<HistoryDiff> {
  const statusIds = changes.statusId ? strings([changes.statusId.from, changes.statusId.to]) : [];
  const userIds = changes.assigneeId
    ? strings([changes.assigneeId.from, changes.assigneeId.to])
    : [];
  const labelIds = changes.labelIds
    ? [...strings(changes.labelIds.from), ...strings(changes.labelIds.to)]
    : [];
  const names = await access.historyNames({ statusIds, userIds, labelIds });
  const person = (id: unknown) => (typeof id === 'string' ? named(names.users, id, 'user') : null);
  const labelsOf = (ids: unknown) => strings(ids).flatMap((id) => names.labels.get(id) ?? []);
  const diff: {
    -readonly [K in keyof HistoryDiff]: HistoryDiff[K];
  } = {};
  if (changes.title) {
    diff.title = { from: String(changes.title.from), to: String(changes.title.to) };
  }
  if (changes.statusId) {
    diff.status = {
      from: named(names.statuses, String(changes.statusId.from), 'status'),
      to: named(names.statuses, String(changes.statusId.to), 'status'),
    };
  }
  if (changes.priority) {
    diff.priority = { from: Number(changes.priority.from), to: Number(changes.priority.to) };
  }
  if (changes.assigneeId) {
    diff.assignee = { from: person(changes.assigneeId.from), to: person(changes.assigneeId.to) };
  }
  if (changes.labelIds) {
    diff.labels = { from: labelsOf(changes.labelIds.from), to: labelsOf(changes.labelIds.to) };
  }
  if (changes.estimate) {
    diff.estimate = {
      from: nullableNumber(changes.estimate.from),
      to: nullableNumber(changes.estimate.to),
    };
  }
  if (changes.dueDate) {
    diff.dueDate = {
      from: nullableString(changes.dueDate.from),
      to: nullableString(changes.dueDate.to),
    };
  }
  if (description !== undefined) diff.description = description;
  return diff;
}

async function insertEntry(
  ctx: HistoryWriteContext,
  issue: Pick<HistoryIssue, 'id' | 'teamId'>,
  kind: IssueHistoryKind,
  changes: Readonly<Record<string, unknown>>,
): Promise<IssueHistoryRow> {
  const actor = historyActorOf(ctx.actor);
  return ctx.repo.insert('IssueHistory', {
    id: uuidv7(),
    issueId: issue.id,
    // The repo stores the issue row's team whatever is passed (§5.1, D4).
    teamId: issue.teamId,
    ...actor,
    kind,
    changes,
  });
}

/** The values an issue was created with, as `issue.create` wrote them. */
export interface CreatedIssue extends HistoryIssue {
  readonly title: string;
  readonly statusId: string;
  readonly priority: number;
  readonly assigneeId: string | null;
  readonly labelIds: readonly string[];
  readonly estimate: number | null;
  readonly dueDate: string | null;
}

/**
 * `issue.create`'s `created` entry (§4.4): `{ to }` of each field that differs from its default,
 * `description: true` when the description isn't empty. Written after the Issue and its content.
 */
export async function writeCreatedHistory(
  ctx: HistoryWriteContext,
  issue: CreatedIssue,
  options: { readonly defaultStatusId: string; readonly descriptionEmpty: boolean },
): Promise<IssueHistoryRow> {
  const names = await ctx.access.historyNames({
    statusIds: [issue.statusId],
    userIds: issue.assigneeId === null ? [] : [issue.assigneeId],
    labelIds: issue.labelIds,
  });
  const entry = historyEntryFor({
    kind: 'created',
    values: {
      title: issue.title,
      status: named(names.statuses, issue.statusId, 'status'),
      priority: issue.priority,
      assignee: issue.assigneeId === null ? null : named(names.users, issue.assigneeId, 'user'),
      labels: issue.labelIds.flatMap((id) => names.labels.get(id) ?? []),
      estimate: issue.estimate,
      dueDate: issue.dueDate,
      descriptionEmpty: options.descriptionEmpty,
    },
    defaults: { statusId: options.defaultStatusId },
  });
  return insertEntry(ctx, issue, entry.kind, entry.changes);
}

/**
 * One `updated` entry for an operation's changes (§4.4), or a fold into the issue's latest entry.
 * Writes nothing when nothing changed (E12). **Call it after the issue row lock.**
 *
 * - `changes`: `issueChangeSet(before, after)` of the issue fields (ids; the names are read here).
 * - `options.description`: set when the operation changed the description, with whether the new
 *   one is empty.
 * - `options.defaultStatusId`: the team's default status, for the creator fold of a status change
 *   (a status equal to it leaves the `created` entry). Without it, a status is never a default.
 * - `options.attachments`: attachments added or removed (SPEC-014 §6.3; PLAN-014 S4a), with their
 *   titles as they are now. They fold into `created` like any field (the creator's, within 3
 *   minutes), and never into a description-only entry.
 *
 * Returns the written or folded entry, or undefined when nothing was written.
 */
export async function writeUpdatedHistory(
  ctx: HistoryWriteContext,
  issue: HistoryIssue,
  changes: IssueChangeSet,
  options: {
    readonly description?: { readonly empty: boolean } | undefined;
    readonly defaultStatusId?: string | undefined;
    readonly attachments?: AttachmentChange | undefined;
  } = {},
): Promise<IssueHistoryRow | undefined> {
  const fields = await namedDiff(ctx.access, changes, options.description);
  const diff: HistoryDiff =
    options.attachments === undefined ? fields : { ...fields, attachments: options.attachments };
  const latest = await ctx.access.latestHistory(issue.id);
  const write = historyWrite({
    latest: latest === undefined ? undefined : entryFacts(latest),
    issue,
    actor: historyActorOf(ctx.actor),
    now: ctx.now,
    diff,
    defaults: { statusId: options.defaultStatusId },
  });
  switch (write.action) {
    case 'none':
      return undefined;
    case 'fold':
      // A `U` with a new `updatedAt` (the repo sets it): the fold's time window moves with it.
      return ctx.repo.update('IssueHistory', write.id, { changes: write.changes });
    case 'insert':
      return insertEntry(ctx, issue, 'updated', write.changes);
  }
}

/**
 * The entry of a lifecycle transition (SPEC-015 §4.8): `deleted`, `restored`, or `archived` (the
 * auto-archive job, actor `system`). Empty `changes`, never folded, and never a fold target.
 */
export function writeLifecycleEntry(
  ctx: HistoryWriteContext,
  kind: 'deleted' | 'restored' | 'archived',
  issue: Pick<HistoryIssue, 'id' | 'teamId'>,
): Promise<IssueHistoryRow> {
  const entry = historyEntryFor({ kind });
  return insertEntry(ctx, issue, entry.kind, entry.changes);
}

function entryFacts(row: IssueHistoryRow): HistoryEntryFacts {
  return {
    id: row.id,
    kind: row.kind,
    changes: row.changes,
    actorKind: row.actorKind,
    actorId: row.actorId,
    apiKeyId: row.apiKeyId,
    updatedAt: row.updatedAt,
  };
}
