/**
 * Issue history entries (SPEC-011 §4.4; PLAN-011 S6): what an entry's `changes` holds, and the two
 * folds. Pure, so the server's writer (`apps/server/src/issues/history.ts`) and the tests share
 * one rule set; optimistic code never predicts history (§6.2).
 *
 * - A **reference is stored with its display name** (`status`, `assignee`, `labels`), so an entry
 *   stays readable after the row is renamed or deleted (E16).
 * - An `updated` entry maps each changed field to `{ from, to }`; labels are `{ added, removed }`;
 *   the description is `description: true`, never its text.
 * - A `created` entry holds `{ to }` for each field set at creation that differs from its default,
 *   and `description: true` when the description isn't empty.
 * - Attachments (SPEC-014 §6.3) are `attachments: { added, removed }`, each `{ id, kind, title }`
 *   with the title as it was; a creator fold keeps the net change (an attachment added and removed
 *   within the window leaves nothing).
 * - `deleted`, `restored` and `archived` entries have empty `changes`, and are never folded.
 *
 * **Folds** (FR-ISS-05, Q10) run in the updating transaction, after the issue row lock, and fold
 * only into the issue's **latest** entry (D15):
 * 1. Creator fold: a change by the issue's creator, as the same actor that wrote the `created`
 *    entry, within 3 minutes of creation, while `created` is still the latest entry.
 * 2. Description fold: a description-only change by the same actor as the latest entry, when that
 *    entry is a description-only `updated` entry at most 10 minutes old (from its `updatedAt`).
 */
import { z } from 'zod';
import { ATTACHMENT_KINDS, type HistoryAttachment } from './attachment.js';
import type { HistoryActorKind, IssueHistoryKind } from './issue.js';
import { STATUS_CATEGORIES, type StatusCategory } from './status-category.js';

/** The creator fold's window, from the issue's creation (§4.4, Q10). */
export const CREATOR_FOLD_MS = 3 * 60_000;
/** The description fold's window, from the latest entry's `updatedAt` (§4.4, Q10). */
export const DESCRIPTION_FOLD_MS = 10 * 60_000;

/** A user (or another row with a name), as an entry stores it. */
export interface HistoryNamed {
  readonly id: string;
  readonly name: string;
}

export interface HistoryStatus extends HistoryNamed {
  readonly category: StatusCategory;
}

export interface HistoryLabel extends HistoryNamed {
  readonly color: string;
}

/** The value of each issue field an entry can name, with references as named snapshots. */
export interface HistoryFieldValues {
  readonly title: string;
  readonly status: HistoryStatus;
  readonly priority: number;
  readonly assignee: HistoryNamed | null;
  readonly labels: readonly HistoryLabel[];
  readonly estimate: number | null;
  readonly dueDate: string | null;
}

export type HistoryField = keyof HistoryFieldValues;

/** In the order entries list them, then `description`. */
export const HISTORY_FIELDS = [
  'title',
  'status',
  'priority',
  'assignee',
  'labels',
  'estimate',
  'dueDate',
] as const satisfies readonly HistoryField[];

/**
 * What an operation changed, with names: `{ from, to }` per changed field (only changed fields),
 * and for the description only whether the new one is empty (`description: true` in the entry;
 * an empty one is the creator fold's default).
 */
export type HistoryDiff = {
  readonly [K in HistoryField]?: {
    readonly from: HistoryFieldValues[K];
    readonly to: HistoryFieldValues[K];
  };
} & {
  readonly description?: { readonly empty: boolean };
  /** Attachments added or removed (SPEC-014 §6.3), with their titles at the time. */
  readonly attachments?: AttachmentChange;
};

/** An entry's attachment change (SPEC-014 §6.3). */
export interface AttachmentChange {
  readonly added: readonly HistoryAttachment[];
  readonly removed: readonly HistoryAttachment[];
}

/** An entry's `changes` as stored (JSON). Later kinds may add fields this type doesn't name. */
export type HistoryChanges = Readonly<Record<string, unknown>>;

/** Who wrote an entry: the operation's actor (§4.4). */
export interface HistoryActorFacts {
  readonly actorKind: HistoryActorKind;
  /** Null for `system`; the key's owner for `api` and `mcp`. */
  readonly actorId: string | null;
  /** For `api` and `mcp`. */
  readonly apiKeyId: string | null;
}

/** What a fold reads of the issue's latest entry. */
export interface HistoryEntryFacts extends HistoryActorFacts {
  readonly id: string;
  readonly kind: IssueHistoryKind;
  readonly changes: unknown;
  readonly updatedAt: Date | string;
}

/** The defaults a `created` entry leaves out (§4.4). `statusId` is the team's default status. */
export interface HistoryDefaults {
  /** Undefined when unknown: a status is then never treated as the default. */
  readonly statusId?: string | undefined;
}

// ---------------------------------------------------------------------------------------------
// Entries

/** Each field's default: what a `created` entry leaves out. assignee, estimate, dueDate: null. */
const IS_DEFAULT: {
  readonly [K in HistoryField]: (
    value: HistoryFieldValues[K],
    defaults: HistoryDefaults,
  ) => boolean;
} = {
  title: () => false,
  status: (value, defaults) => value.id === defaults.statusId,
  priority: (value) => value === 0,
  assignee: (value) => value === null,
  labels: (value) => value.length === 0,
  estimate: (value) => value === null,
  dueDate: (value) => value === null,
};

function isDefault<K extends HistoryField>(
  field: K,
  value: HistoryFieldValues[K],
  defaults: HistoryDefaults,
): boolean {
  const check: (value: HistoryFieldValues[K], defaults: HistoryDefaults) => boolean =
    IS_DEFAULT[field];
  return check(value, defaults);
}

/** The values an issue was created with, and whether its description is empty. */
export interface CreatedValues extends HistoryFieldValues {
  readonly descriptionEmpty: boolean;
}

/** A `created` entry's changes: `{ to }` of each non-default field (§4.4). */
export function createdChanges(values: CreatedValues, defaults: HistoryDefaults): HistoryChanges {
  const changes: Record<string, unknown> = {};
  for (const field of HISTORY_FIELDS) {
    const value = values[field];
    if (!isDefault(field, value, defaults)) changes[field] = { to: value };
  }
  if (!values.descriptionEmpty) changes['description'] = true;
  return changes;
}

const byId = (labels: readonly HistoryLabel[]) => new Set(labels.map((l) => l.id));

/** An `updated` entry's changes; empty when the diff changes nothing. */
export function updatedChanges(diff: HistoryDiff): HistoryChanges {
  const changes: Record<string, unknown> = {};
  for (const field of HISTORY_FIELDS) {
    const change = diff[field];
    if (change === undefined) continue;
    if (field === 'labels') {
      const labels = diff.labels;
      if (labels === undefined) continue;
      const before = byId(labels.from);
      const after = byId(labels.to);
      const added = labels.to.filter((l) => !before.has(l.id));
      const removed = labels.from.filter((l) => !after.has(l.id));
      if (added.length > 0 || removed.length > 0) changes['labels'] = { added, removed };
      continue;
    }
    changes[field] = { from: change.from, to: change.to };
  }
  if (diff.description !== undefined) changes['description'] = true;
  const attachments = diff.attachments;
  if (attachments !== undefined && attachments.added.length + attachments.removed.length > 0) {
    changes['attachments'] = { added: [...attachments.added], removed: [...attachments.removed] };
  }
  return changes;
}

const HistoryAttachmentSchema = z.object({
  id: z.string(),
  kind: z.enum(ATTACHMENT_KINDS),
  title: z.string(),
});
/** A stored attachment change, as the creator fold and the activity line read it. */
const AttachmentChangeSchema = z.object({
  added: z.array(HistoryAttachmentSchema),
  removed: z.array(HistoryAttachmentSchema),
});

/**
 * The net of a stored attachment change and a new one (the creator fold): an attachment added and
 * then removed within the window leaves nothing; undefined when nothing is left.
 */
function foldAttachments(stored: unknown, change: AttachmentChange): AttachmentChange | undefined {
  const parsed = AttachmentChangeSchema.safeParse(stored);
  let added: HistoryAttachment[] = parsed.success ? [...parsed.data.added] : [];
  const removed: HistoryAttachment[] = parsed.success ? [...parsed.data.removed] : [];
  for (const attachment of change.added) {
    if (!added.some((a) => a.id === attachment.id)) added.push(attachment);
  }
  for (const attachment of change.removed) {
    if (added.some((a) => a.id === attachment.id)) {
      added = added.filter((a) => a.id !== attachment.id);
    } else if (!removed.some((r) => r.id === attachment.id)) {
      removed.push(attachment);
    }
  }
  return added.length + removed.length > 0 ? { added, removed } : undefined;
}

/**
 * The creator fold (§4.4 rule 1): each changed field's `to` becomes the new value, and a field
 * whose new value is its default is dropped. `created` is the stored entry's changes.
 */
export function foldIntoCreated(
  created: unknown,
  diff: HistoryDiff,
  defaults: HistoryDefaults,
): HistoryChanges {
  const changes: Record<string, unknown> = isRecord(created) ? { ...created } : {};
  for (const field of HISTORY_FIELDS) {
    const change = diff[field];
    if (change === undefined) continue;
    if (isDefault(field, change.to, defaults)) delete changes[field];
    else changes[field] = { to: change.to };
  }
  if (diff.description !== undefined) {
    if (diff.description.empty) delete changes['description'];
    else changes['description'] = true;
  }
  if (diff.attachments !== undefined) {
    const folded = foldAttachments(changes['attachments'], diff.attachments);
    if (folded === undefined) delete changes['attachments'];
    else changes['attachments'] = folded;
  }
  return changes;
}

export type HistoryEntryInput =
  | {
      readonly kind: 'created';
      readonly values: CreatedValues;
      readonly defaults: HistoryDefaults;
    }
  | { readonly kind: 'updated'; readonly diff: HistoryDiff }
  | { readonly kind: 'deleted' | 'restored' | 'archived' };

/** A new entry of `input.kind` (§4.4): lifecycle kinds have empty `changes`. */
export function historyEntryFor(input: HistoryEntryInput): {
  readonly kind: IssueHistoryKind;
  readonly changes: HistoryChanges;
} {
  switch (input.kind) {
    case 'created':
      return { kind: 'created', changes: createdChanges(input.values, input.defaults) };
    case 'updated':
      return { kind: 'updated', changes: updatedChanges(input.diff) };
    case 'deleted':
    case 'restored':
    case 'archived':
      return { kind: input.kind, changes: {} };
  }
}

// ---------------------------------------------------------------------------------------------
// Folds

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One actor: the same kind, user and API key. */
export function sameHistoryActor(a: HistoryActorFacts, b: HistoryActorFacts): boolean {
  return a.actorKind === b.actorKind && a.actorId === b.actorId && a.apiKeyId === b.apiKeyId;
}

/** True when the diff changes the description and nothing else. */
export function isDescriptionOnly(diff: HistoryDiff): boolean {
  return (
    diff.description !== undefined &&
    diff.attachments === undefined &&
    HISTORY_FIELDS.every((f) => diff[f] === undefined)
  );
}

/** True for an `updated` entry whose changes are `{ description: true }` alone. */
export function isDescriptionOnlyEntry(
  entry: Pick<HistoryEntryFacts, 'kind' | 'changes'>,
): boolean {
  if (entry.kind !== 'updated' || !isRecord(entry.changes)) return false;
  const keys = Object.keys(entry.changes);
  return keys.length === 1 && entry.changes['description'] === true;
}

const ms = (at: Date | string): number => (at instanceof Date ? at : new Date(at)).getTime();

/** What the writer does with a change (§4.4). */
export type HistoryWrite =
  | { readonly action: 'none' }
  | { readonly action: 'insert'; readonly changes: HistoryChanges }
  | { readonly action: 'fold'; readonly id: string; readonly changes: HistoryChanges };

export interface HistoryWriteInput {
  /** The issue's latest entry (by creation), read under the issue lock; none for a bare issue. */
  readonly latest: HistoryEntryFacts | undefined;
  readonly issue: { readonly creatorId: string; readonly createdAt: Date | string };
  readonly actor: HistoryActorFacts;
  readonly now: Date;
  readonly diff: HistoryDiff;
  readonly defaults: HistoryDefaults;
}

/** True when the creator fold (§4.4 rule 1) takes this change. */
export function foldsIntoCreated(input: HistoryWriteInput): boolean {
  const { latest, issue, actor, now } = input;
  return (
    latest !== undefined &&
    latest.kind === 'created' &&
    actor.actorId !== null &&
    actor.actorId === issue.creatorId &&
    sameHistoryActor(latest, actor) &&
    now.getTime() - ms(issue.createdAt) <= CREATOR_FOLD_MS
  );
}

/** True when the description fold (§4.4 rule 2) takes this change. */
export function foldsDescription(input: HistoryWriteInput): boolean {
  const { latest, actor, now, diff } = input;
  return (
    latest !== undefined &&
    isDescriptionOnly(diff) &&
    isDescriptionOnlyEntry(latest) &&
    sameHistoryActor(latest, actor) &&
    now.getTime() - ms(latest.updatedAt) <= DESCRIPTION_FOLD_MS
  );
}

/**
 * Decides an `updated` change's history write (§4.4): nothing for a change of nothing (E12), a
 * fold into the latest entry when a fold rule takes it (the creator fold first), else a new entry.
 */
export function historyWrite(input: HistoryWriteInput): HistoryWrite {
  const changes = updatedChanges(input.diff);
  if (Object.keys(changes).length === 0) return { action: 'none' };
  const { latest } = input;
  if (latest !== undefined && foldsIntoCreated(input)) {
    return {
      action: 'fold',
      id: latest.id,
      changes: foldIntoCreated(latest.changes, input.diff, input.defaults),
    };
  }
  if (latest !== undefined && foldsDescription(input)) {
    return { action: 'fold', id: latest.id, changes: { description: true } };
  }
  return { action: 'insert', changes };
}

// ---------------------------------------------------------------------------------------------
// Reading stored changes (the activity line formatter, SPEC-012)

const Named = z.object({ id: z.string(), name: z.string() });
const Status = Named.extend({ category: z.enum(STATUS_CATEGORIES) });
const Label = Named.extend({ color: z.string() });
const change = <T extends z.ZodType>(value: T) =>
  z.object({ from: value.optional(), to: value }).optional();

/**
 * The fields of stored `changes` the formatter reads. Loose: a field it can't read is left out
 * (a later kind's field, or a shape it doesn't know), never an error.
 */
export const HistoryChangesSchema = z.looseObject({
  title: change(z.string()).catch(undefined),
  status: change(Status).catch(undefined),
  priority: change(z.number()).catch(undefined),
  assignee: change(Named.nullable()).catch(undefined),
  labels: z
    .union([
      z.object({ added: z.array(Label), removed: z.array(Label) }),
      z.object({ to: z.array(Label) }),
    ])
    .optional()
    .catch(undefined),
  estimate: change(z.number().nullable()).catch(undefined),
  dueDate: change(z.string().nullable()).catch(undefined),
  description: z.literal(true).optional().catch(undefined),
  attachments: AttachmentChangeSchema.optional().catch(undefined),
});

export type ParsedHistoryChanges = z.infer<typeof HistoryChangesSchema>;

/** Stored `changes`, read leniently (anything unreadable is left out). */
export function parseHistoryChanges(changes: unknown): ParsedHistoryChanges {
  const parsed = HistoryChangesSchema.safeParse(isRecord(changes) ? changes : {});
  return parsed.success ? parsed.data : {};
}
