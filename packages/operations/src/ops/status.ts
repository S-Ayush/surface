/**
 * Workflow status operations (SPEC-010 §4.1, §6; PLAN-010 S2). Members of a team and Admins
 * change its workflow; a private team is invisible to everyone else, so a reference to it is
 * `NOT_FOUND` before any permission check. `team.setDefaultStatus` is S4's.
 *
 * Optimistic updates use the same `placeStatus` as the server, so the client predicts the key
 * the server commits. `status.delete` predicts the removal unless the pure rules already refuse
 * it. When the store shows an issue on the status it throws `OptimisticRefusal` with the server's
 * message, so nothing is queued; when it shows none it removes the status, and the server, which
 * sees every issue (the replica holds only some, SPEC-011 §5.7), decides (SPEC-010 E8, AC-17).
 */
import {
  COLOR_HUES,
  EDITABLE_STATUS_CATEGORIES,
  STATUS_CATEGORIES,
  STATUS_CATEGORY_COLORS,
  STATUS_DESCRIPTION_MAX_LENGTH,
  STATUS_NAME_MAX_LENGTH,
  StatusRef,
  TeamRef,
  countStatusIssues,
  isStatusCategory,
  placeStatus,
  statusDeleteProblem,
  statusLimitProblem,
  statusNameProblem,
  type PositionedStatus,
} from '@surface/domain';
import { z } from 'zod';
import { defineOperation } from '../define.js';
import { connectionOf, listInput } from '../list.js';
import { OptimisticRefusal, type OptimisticStore, type StoreRow } from '../optimistic.js';
import { Timestamp } from './shared.js';

const StatusName = z
  .string()
  .trim()
  .min(1, 'Status name is required, like In Review')
  .max(STATUS_NAME_MAX_LENGTH, `Status name must be at most ${STATUS_NAME_MAX_LENGTH} characters`);

/** Empty means none (SPEC-010 §4.1). */
const StatusDescription = z
  .string()
  .trim()
  .max(
    STATUS_DESCRIPTION_MAX_LENGTH,
    `Description must be at most ${STATUS_DESCRIPTION_MAX_LENGTH} characters`,
  );

export const StatusSchema = z.object({
  id: z.uuid(),
  teamId: z.uuid(),
  name: z.string(),
  category: z.enum(STATUS_CATEGORIES),
  color: z.enum(COLOR_HUES),
  description: z.string().nullable(),
  /** Fractional-index key, ordered within the category in byte order (SPEC-010 §4.1). */
  position: z.string(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

// ---------------------------------------------------------------------------------------------
// Optimistic helpers

function text(row: StoreRow, field: string): string | undefined {
  const value = row[field];
  return typeof value === 'string' ? value : undefined;
}

/** A status the store holds, in the shape `placeStatus` needs; rows of other shapes are skipped. */
function positioned(rows: readonly StoreRow[]): (PositionedStatus & { name: string })[] {
  const out: (PositionedStatus & { name: string })[] = [];
  for (const row of rows) {
    const id = text(row, 'id');
    const category = text(row, 'category');
    const position = text(row, 'position');
    const name = text(row, 'name');
    if (id !== undefined && isStatusCategory(category) && position !== undefined && name) {
      out.push({ id, category, position, name });
    }
  }
  return out;
}

interface TeamStatuses {
  readonly team: StoreRow;
  readonly teamId: string;
  readonly statuses: (PositionedStatus & { name: string })[];
}

/** The team `ref` names and its statuses; undefined when the store lacks either. */
function teamStatuses(store: OptimisticStore, ref: string): TeamStatuses | undefined {
  const team = store.get('Team', ref);
  const teamId = team === undefined ? undefined : text(team, 'id');
  if (team === undefined || teamId === undefined) return undefined;
  return { team, teamId, statuses: positioned(store.find('WorkflowStatus', { teamId })) };
}

/** A status of the team by id or name (any case), like the server's `StatusRef` lookup. */
function statusIn<T extends { id: string; name: string }>(statuses: readonly T[], ref: string) {
  const lower = ref.trim().toLowerCase();
  return statuses.find((s) => s.id === ref) ?? statuses.find((s) => s.name.toLowerCase() === lower);
}

function groupsOf(team: StoreRow): string[] {
  const groups = team['groups'];
  return Array.isArray(groups) ? groups.filter((g): g is string => typeof g === 'string') : [];
}

// ---------------------------------------------------------------------------------------------

export const statusList = defineOperation({
  name: 'status.list',
  kind: 'query',
  domain: 'status',
  summary: 'List a team’s workflow statuses',
  description:
    'Lists the statuses of a team (Backlog, Todo, In Progress, Done…) with their category, color and position. Default order: category order, then position. Filter by category, name or color; sort by name, position or createdAt. Statuses are never archived, so includeArchived changes nothing. Accepts a team key like ENG or a team id.',
  keywords: ['list statuses', 'workflow states', 'what statuses does a team have', 'issue states'],
  input: z.object({
    ...listInput,
    team: TeamRef,
    category: z.enum(STATUS_CATEGORIES).optional(),
  }),
  output: connectionOf(StatusSchema),
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ team: 'ENG' }, { team: 'ENG', category: 'started' }],
});

export const statusCreate = defineOperation({
  name: 'status.create',
  kind: 'mutation',
  domain: 'status',
  summary: 'Add a status to a team’s workflow',
  description:
    'Adds a status to a category of a team’s workflow: Backlog, Unstarted, Started, Completed or Canceled (never Triage or Duplicate). It goes at the end of the category, or right after the status named in after. The color defaults to the category’s. Names are unique in the team (any case); a team has at most 50 statuses.',
  keywords: ['add status', 'create workflow state', 'new status', 'add column to workflow'],
  input: z.object({
    /** Client-generated UUIDv7 (SPEC-003 §8, E7); generated by the server when absent. */
    id: z
      .uuid({
        version: 'v7',
        error: 'Use a UUIDv7 for id, or leave it out and the server makes one',
      })
      .optional(),
    team: TeamRef,
    name: StatusName,
    category: z.enum(EDITABLE_STATUS_CATEGORIES),
    color: z.enum(COLOR_HUES).optional(),
    description: StatusDescription.optional(),
    after: StatusRef.optional(),
  }),
  output: StatusSchema,
  permission: (p, { team }) => p.admin() || p.teamMember(team),
  destructive: false,
  examples: [{ team: 'ENG', name: 'Blocked', category: 'started', color: 'red' }],
  ui: { title: 'Add status…', icon: 'plus', contexts: ['team'], shortcut: null },
  optimistic: (store, input) => {
    // Without an id the server decides; nothing to predict.
    if (input.id === undefined) return;
    const found = teamStatuses(store, input.team);
    if (found === undefined) return;
    const { team, teamId, statuses } = found;
    const taken = statuses.some((s) => s.name.toLowerCase() === input.name.toLowerCase());
    if (taken || statusLimitProblem(statuses.length) !== undefined) return;
    const after = input.after === undefined ? undefined : statusIn(statuses, input.after)?.id;
    if (input.after !== undefined && after === undefined) return;
    const placed = placeStatus(statuses, input.category, { after });
    if (!placed.ok) return;
    const at = store.now.toISOString();
    store.insert('WorkflowStatus', {
      id: input.id,
      teamId,
      name: input.name,
      category: input.category,
      color: input.color ?? STATUS_CATEGORY_COLORS[input.category],
      description: input.description ? input.description : null,
      position: placed.position,
      groups: groupsOf(team),
      createdAt: at,
      updatedAt: at,
    });
  },
});

export const statusUpdate = defineOperation({
  name: 'status.update',
  kind: 'mutation',
  domain: 'status',
  summary: 'Rename, recolor or describe a status',
  description:
    'Changes the name, color or description of a status (an empty description clears it). The category cannot change. The Duplicate status is managed by the system and cannot be changed. Names are unique in the team (any case).',
  keywords: ['rename status', 'change status color', 'edit status', 'describe status'],
  input: z.object({
    team: TeamRef,
    status: StatusRef,
    name: StatusName.optional(),
    color: z.enum(COLOR_HUES).optional(),
    description: StatusDescription.optional(),
  }),
  output: StatusSchema,
  permission: (p, { team }) => p.admin() || p.teamMember(team),
  destructive: false,
  examples: [{ team: 'ENG', status: 'Blocked', name: 'Blocked by others', color: 'orange' }],
  optimistic: (store, input) => {
    const found = teamStatuses(store, input.team);
    const status = found && statusIn(found.statuses, input.status);
    if (found === undefined || status === undefined) return;
    if (status.category === 'duplicate') return;
    const clash = found.statuses.some(
      (s) => s.id !== status.id && s.name.toLowerCase() === input.name?.toLowerCase(),
    );
    if (clash || (input.name !== undefined && statusNameProblem(input.name) !== undefined)) return;
    // Only what differs, as the server writes: nothing differing means no patch, so no updatedAt.
    const saved = store.get('WorkflowStatus', status.id) ?? {};
    const wanted: Record<string, unknown> = {};
    if (input.name !== undefined) wanted['name'] = input.name;
    if (input.color !== undefined) wanted['color'] = input.color;
    if (input.description !== undefined) {
      wanted['description'] = input.description === '' ? null : input.description;
    }
    const changes = Object.fromEntries(
      Object.entries(wanted).filter(([field, value]) => saved[field] !== value),
    );
    if (Object.keys(changes).length === 0) return;
    store.patch('WorkflowStatus', status.id, { ...changes, updatedAt: store.now.toISOString() });
  },
});

export const statusReorder = defineOperation({
  name: 'status.reorder',
  kind: 'mutation',
  domain: 'status',
  summary: 'Move a status within its category',
  description:
    'Moves a status right before or right after another status of the same category; give exactly one of before and after. Only the moved status changes. Triage and Duplicate cannot be moved.',
  keywords: ['reorder status', 'move status', 'change status order', 'sort workflow'],
  input: z
    .object({
      team: TeamRef,
      status: StatusRef,
      before: StatusRef.optional(),
      after: StatusRef.optional(),
    })
    .refine((v) => (v.before === undefined) !== (v.after === undefined), {
      message: 'Give exactly one of before and after',
      path: ['before'],
    }),
  output: StatusSchema,
  permission: (p, { team }) => p.admin() || p.teamMember(team),
  destructive: false,
  examples: [{ team: 'ENG', status: 'Blocked by others', before: 'In Progress' }],
  optimistic: (store, input) => {
    const found = teamStatuses(store, input.team);
    const status = found && statusIn(found.statuses, input.status);
    if (found === undefined || status === undefined) return;
    const ref = input.before ?? input.after;
    const anchor = ref === undefined ? undefined : statusIn(found.statuses, ref)?.id;
    if (anchor === undefined) return;
    const placed = placeStatus(
      found.statuses,
      status.category,
      input.before === undefined ? { after: anchor } : { before: anchor },
      status.id,
    );
    // Only the moved row is written (AC-3).
    if (!placed.ok || placed.unchanged) return;
    store.patch('WorkflowStatus', status.id, {
      position: placed.position,
      updatedAt: store.now.toISOString(),
    });
  },
});

export const statusDelete = defineOperation({
  name: 'status.delete',
  kind: 'mutation',
  domain: 'status',
  summary: 'Delete a status',
  description:
    'Deletes a status for good. Refused while any issue uses it (archived and recently deleted ones count), for the default status, for the status that closes stale issues, for the last status of a category, and for Triage and Duplicate. Nothing moves and nothing cascades.',
  keywords: ['delete status', 'remove status', 'remove workflow state', 'drop status'],
  input: z.object({ team: TeamRef, status: StatusRef }),
  output: StatusSchema,
  permission: (p, { team }) => p.admin() || p.teamMember(team),
  destructive: true,
  examples: [{ team: 'ENG', status: 'Blocked by others' }],
  optimistic: (store, input) => {
    const found = teamStatuses(store, input.team);
    const status = found && statusIn(found.statuses, input.status);
    if (found === undefined || status === undefined) return;
    const defaultId = text(found.team, 'defaultStatusId') ?? '';
    const autoClose = text(found.team, 'autoCloseStatusId');
    const issues = store.find('Issue', { statusId: status.id }).flatMap((row) => {
      const statusId = text(row, 'statusId');
      return statusId === undefined
        ? []
        : [{ statusId, archivedAt: row['archivedAt'], deletedAt: row['deletedAt'] }];
    });
    const problem = statusDeleteProblem(
      { statuses: found.statuses, statusId: status.id },
      defaultId,
      countStatusIssues(issues, status.id),
      autoClose,
    );
    // The store shows an issue on it: the server will refuse, so nothing is sent (E8).
    if (problem?.reason === 'hasIssues') throw new OptimisticRefusal(problem.message);
    // The server refuses the others too, so the row stays and the server's message shows.
    if (problem) return;
    // None in the store: a guess, since the store holds only some issues; the server decides.
    store.remove('WorkflowStatus', status.id);
  },
});
