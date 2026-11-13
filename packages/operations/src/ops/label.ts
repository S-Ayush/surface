/**
 * Label operations (SPEC-010 §4.2, §6; PLAN-010 S3). A team label is changed by members of its
 * team and Admins, a workspace label by any member (D9) unless the actor's API key is narrowed to
 * some teams (permissions §3.5). A private team's labels are invisible to everyone else, so a
 * reference to one is `NOT_FOUND` before any permission check.
 *
 * `label.archive` and `label.unarchive` are PLAN-010 S6 (archive state travels as `A`/`V`, SPEC-011
 * §5.5), and `label.usage` is S5. The deleted
 * label's id stays in issues' `labelIds` until S5 rewrites them: no issue table exists yet.
 *
 * Optimistic updates call the same `label*Problem` functions as the server, so the client
 * predicts what the handlers commit.
 */
import {
  COLOR_HUES,
  LABEL_DESCRIPTION_MAX_LENGTH,
  LABEL_NAME_MAX_LENGTH,
  LabelRef,
  TeamRef,
  labelArchivePlan,
  labelCreateProblem,
  labelDeleteProblem,
  labelMovePlan,
  labelUnarchivePlan,
  labelUpdateProblem,
  parseLabelRef,
  type LabelFacts,
  type LabelScopeInfo,
  type PermissionPredicates,
  type ResolvedRefs,
} from '@surface/domain';
import { z } from 'zod';
import { defineOperation } from '../define.js';
import { connectionOf, listInput } from '../list.js';
import type { OptimisticStore, StoreRow } from '../optimistic.js';
import { Timestamp } from './shared.js';

const LabelName = z
  .string()
  .trim()
  .min(1, 'Label name is required, like Bug')
  .max(LABEL_NAME_MAX_LENGTH, `Label name must be at most ${LABEL_NAME_MAX_LENGTH} characters`);

/** Empty means none (SPEC-010 §4.2). */
const LabelDescription = z
  .string()
  .trim()
  .max(
    LABEL_DESCRIPTION_MAX_LENGTH,
    `Description must be at most ${LABEL_DESCRIPTION_MAX_LENGTH} characters`,
  );

export const LabelSchema = z.object({
  id: z.uuid(),
  /** Null for a workspace label. */
  teamId: z.uuid().nullable(),
  name: z.string(),
  color: z.enum(COLOR_HUES),
  description: z.string().nullable(),
  parentId: z.uuid().nullable(),
  isGroup: z.boolean(),
  /** Groups only: single-select (SPEC-010 §4.2). */
  exclusive: z.boolean(),
  archivedAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export const LABEL_SCOPES = ['team', 'workspace', 'all'] as const;

const NewId = z
  .uuid({
    version: 'v7',
    error: 'Use a UUIDv7 for id, or leave it out and the server makes one',
  })
  .optional();

// ---------------------------------------------------------------------------------------------
// Permissions

/** Whether the actor may change the label, from the row the executor resolved (§5). */
function mayChange(p: PermissionPredicates, refs: ResolvedRefs): boolean {
  const label = refs['label'];
  if (label === undefined || !('id' in label)) return false;
  const teamId = label['teamId'];
  if (typeof teamId !== 'string') return p.any() && p.allTeamsKey();
  // The label's own team, never the team named in the input: a label id resolves to any visible
  // label whatever `team` says, so naming ENG must not unlock a DES label (SPEC-010 §5). The
  // named team's row is used only when it is that team, for the reason's team name.
  const named = refs['team'];
  const own = named !== undefined && 'id' in named && named.id === teamId ? named : { id: teamId };
  return p.admin() || p.teamMember(own);
}

// ---------------------------------------------------------------------------------------------
// Optimistic helpers

function text(row: StoreRow, field: string): string | undefined {
  const value = row[field];
  return typeof value === 'string' ? value : undefined;
}

/** A label row of the store as the shared rules read it; undefined for a row of another shape. */
function factsOf(row: StoreRow): LabelFacts | undefined {
  const id = text(row, 'id');
  const name = text(row, 'name');
  const teamId = row['teamId'];
  const parentId = row['parentId'];
  if (id === undefined || name === undefined) return undefined;
  if (teamId !== null && typeof teamId !== 'string') return undefined;
  if (parentId !== null && typeof parentId !== 'string') return undefined;
  const archivedAt = row['archivedAt'];
  return {
    id,
    name,
    teamId,
    parentId,
    isGroup: row['isGroup'] === true,
    exclusive: row['exclusive'] !== false,
    archivedAt: typeof archivedAt === 'string' ? archivedAt : null,
  };
}

function labelsOf(store: OptimisticStore, teamId: string | null): LabelFacts[] {
  return store
    .find('Label', { teamId })
    .map(factsOf)
    .filter((l): l is LabelFacts => l !== undefined);
}

function groupsOf(team: StoreRow): string[] {
  const groups = team['groups'];
  return Array.isArray(groups) ? groups.filter((g): g is string => typeof g === 'string') : [];
}

interface Scope {
  readonly info: LabelScopeInfo;
  readonly team: StoreRow | undefined;
  readonly labels: LabelFacts[];
}

/** The scope a new label goes in: the team `ref` names, or the workspace without one. */
function scopeOf(store: OptimisticStore, teamRef: string | undefined): Scope | undefined {
  if (teamRef === undefined) {
    return {
      info: { teamId: null, teamKey: null },
      team: undefined,
      labels: labelsOf(store, null),
    };
  }
  const team = store.get('Team', teamRef);
  const teamId = team && text(team, 'id');
  const teamKey = team && text(team, 'key');
  if (!team || teamId === undefined || teamKey === undefined) return undefined;
  return { info: { teamId, teamKey }, team, labels: labelsOf(store, teamId) };
}

/**
 * The label `ref` names, like the server's `LabelRef` lookup: an id, or a name or `Group/Label`
 * among the team's labels first and then the workspace's. Undefined when none matches or the name
 * is ambiguous (the server answers those).
 */
function findLabel(
  store: OptimisticStore,
  ref: string,
  teamId: string | null,
): LabelFacts | undefined {
  const parsed = parseLabelRef(ref);
  if (parsed?.by === 'id') {
    const row = store.get('Label', parsed.id);
    return row && factsOf(row);
  }
  if (parsed?.by !== 'name' && parsed?.by !== 'groupLabel') return undefined;
  const wanted = parsed.name.toLowerCase();
  const inGroup = (l: LabelFacts, all: LabelFacts[]): boolean => {
    if (parsed.by !== 'groupLabel') return true;
    const parent = all.find((p) => p.id === l.parentId);
    return parent?.name.toLowerCase() === parsed.group.toLowerCase();
  };
  const matching = (all: LabelFacts[]) =>
    all.filter((l) => l.name.toLowerCase() === wanted && inGroup(l, all));
  // Like the server's `pickByName`: only a single exact-case match settles several, and a name
  // that matches in the team never falls through to the workspace.
  const settle = (matches: LabelFacts[]): LabelFacts | undefined => {
    if (matches.length <= 1) return matches[0];
    const exact = matches.filter((l) => l.name === parsed.name);
    return exact.length === 1 ? exact[0] : undefined;
  };
  const inTeam = teamId === null ? [] : matching(labelsOf(store, teamId));
  return settle(inTeam.length > 0 ? inTeam : matching(labelsOf(store, null)));
}

/** The team a label operation names, as the scope of its `label` ref. */
function teamIdOfRef(store: OptimisticStore, teamRef: string | undefined): string | null {
  const team = teamRef === undefined ? undefined : store.get('Team', teamRef);
  return (team && text(team, 'id')) ?? null;
}

/** The scope of an existing label: its team, or the workspace. */
function scopeOfLabel(store: OptimisticStore, label: LabelFacts): Scope | undefined {
  if (label.teamId === null) return scopeOf(store, undefined);
  const team = store.get('Team', label.teamId);
  const key = team && text(team, 'key');
  return key === undefined ? undefined : scopeOf(store, key);
}

// ---------------------------------------------------------------------------------------------

export const labelList = defineOperation({
  name: 'label.list',
  kind: 'query',
  domain: 'label',
  summary: 'List labels and label groups',
  description:
    'Lists the labels the caller can see, with their team (null for a workspace label), group, color, group type and archive state. With team, scope all means that team’s labels plus workspace labels; without it, workspace labels plus the labels of every team the caller can see. Archived labels are left out unless includeArchived is true. Filter by name, color or group; sort by name or createdAt.',
  keywords: ['list labels', 'what labels exist', 'label groups', 'issue tags'],
  input: z.object({
    ...listInput,
    team: TeamRef.optional(),
    scope: z.enum(LABEL_SCOPES).default('all'),
    group: LabelRef.optional(),
  }),
  output: connectionOf(LabelSchema),
  permission: (p) => p.any(),
  destructive: false,
  examples: [{}, { team: 'ENG', scope: 'workspace' }],
});

export const labelCreate = defineOperation({
  name: 'label.create',
  kind: 'mutation',
  domain: 'label',
  summary: 'Create a label or label group',
  description:
    'Creates a label, or a label group when isGroup is true. With team it is a team label; without, a workspace label every team can use. group puts it in a group. Names have no / or :, are not filter words like priority, and are unique within the scope and group. exclusive (single or multiple choice) is for groups and defaults to single. Limits: 500 labels per scope, 250 per group.',
  keywords: ['create label', 'new label', 'add tag', 'create label group'],
  input: z.object({
    /** Client-generated UUIDv7 (SPEC-003 §8, E7); generated by the server when absent. */
    id: NewId,
    team: TeamRef.optional(),
    name: LabelName,
    color: z.enum(COLOR_HUES).optional(),
    description: LabelDescription.optional(),
    isGroup: z.boolean().optional(),
    exclusive: z.boolean().optional(),
    group: LabelRef.optional(),
  }),
  output: LabelSchema,
  permission: (p, refs) =>
    refs['team'] === undefined
      ? p.any() && p.allTeamsKey()
      : p.admin() || p.teamMember(refs['team']),
  destructive: false,
  examples: [{ team: 'ENG', name: 'Needs design', color: 'orange' }],
  ui: { title: 'Create label…', icon: 'plus', contexts: ['team', 'global'], shortcut: null },
  optimistic: (store, input) => {
    // Without an id the server decides; nothing to predict.
    if (input.id === undefined) return;
    const scope = scopeOf(store, input.team);
    if (scope === undefined) return;
    const group =
      input.group === undefined ? undefined : findLabel(store, input.group, scope.info.teamId);
    if (input.group !== undefined && group === undefined) return;
    const isGroup = input.isGroup ?? false;
    const problem = labelCreateProblem(scope.labels, scope.info, {
      name: input.name,
      isGroup,
      exclusive: input.exclusive,
      group,
    });
    if (problem !== undefined) return;
    const at = store.now.toISOString();
    store.insert('Label', {
      id: input.id,
      teamId: scope.info.teamId,
      name: input.name,
      color: input.color ?? 'gray',
      description: input.description ? input.description : null,
      parentId: group?.id ?? null,
      isGroup,
      exclusive: input.exclusive ?? true,
      groups: scope.team === undefined ? ['workspace'] : groupsOf(scope.team),
      archivedAt: null,
      createdAt: at,
      updatedAt: at,
    });
  },
});

export const labelUpdate = defineOperation({
  name: 'label.update',
  kind: 'mutation',
  domain: 'label',
  summary: 'Edit a label or label group',
  description:
    'Renames, recolors or describes a label (an empty description clears it), moves it into a group, or takes it out with group null. exclusive switches a group between single and multiple choice and never reads issues. Name a team label by name together with team, or use its id. Archived labels can be edited too.',
  keywords: ['rename label', 'edit label', 'change label color', 'move label to group'],
  input: z.object({
    label: LabelRef,
    team: TeamRef.optional(),
    name: LabelName.optional(),
    color: z.enum(COLOR_HUES).optional(),
    description: LabelDescription.optional(),
    exclusive: z.boolean().optional(),
    group: LabelRef.nullable().optional(),
  }),
  output: LabelSchema,
  permission: (p, refs) => mayChange(p, refs),
  destructive: false,
  examples: [{ team: 'ENG', label: 'Needs design', description: 'Waiting for a mock-up' }],
  optimistic: (store, input) => {
    const teamId = teamIdOfRef(store, input.team);
    const label = findLabel(store, input.label, teamId);
    const scope = label && scopeOfLabel(store, label);
    if (label === undefined || scope === undefined) return;
    const group =
      input.group === undefined || input.group === null
        ? input.group
        : findLabel(store, input.group, teamId);
    if (input.group != null && group === undefined) return;
    const problem = labelUpdateProblem(scope.labels, scope.info, label, {
      name: input.name,
      exclusive: input.exclusive,
      group,
    });
    if (problem !== undefined) return;
    // Only what differs, as the server writes: nothing differing means no patch, so no updatedAt.
    const saved = store.get('Label', label.id) ?? {};
    const wanted: Record<string, unknown> = {};
    if (input.name !== undefined) wanted['name'] = input.name;
    if (input.color !== undefined) wanted['color'] = input.color;
    if (input.description !== undefined) {
      wanted['description'] = input.description === '' ? null : input.description;
    }
    if (input.exclusive !== undefined) wanted['exclusive'] = input.exclusive;
    if (group !== undefined) wanted['parentId'] = group === null ? null : group.id;
    const changes = Object.fromEntries(
      Object.entries(wanted).filter(([field, value]) => saved[field] !== value),
    );
    if (Object.keys(changes).length === 0) return;
    store.patch('Label', label.id, { ...changes, updatedAt: store.now.toISOString() });
  },
});

export const labelMoveToWorkspace = defineOperation({
  name: 'label.moveToWorkspace',
  kind: 'mutation',
  domain: 'label',
  summary: 'Move a team label to the workspace',
  description:
    'Makes a team label available to every team, together with its labels when it is a group. Issues keep it. A label inside a group cannot move alone, and the name must be free among workspace labels. This cannot be undone, and an API key limited to some teams cannot do it.',
  keywords: ['move label to workspace', 'share label with all teams', 'make label global'],
  input: z.object({ label: LabelRef, team: TeamRef }),
  output: LabelSchema,
  permission: (p, refs) => mayChange(p, refs) && p.allTeamsKey(),
  destructive: false,
  examples: [{ team: 'ENG', label: 'Needs design' }],
  optimistic: (store, input) => {
    const teamId = teamIdOfRef(store, input.team);
    const label = teamId === null ? undefined : findLabel(store, input.label, teamId);
    if (label === undefined || label.teamId === null || label.teamId !== teamId) return;
    const plan = labelMovePlan(labelsOf(store, label.teamId), labelsOf(store, null), label);
    if (!plan.ok) return;
    const at = store.now.toISOString();
    for (const moved of plan.moving) {
      store.patch('Label', moved.id, { teamId: null, groups: ['workspace'], updatedAt: at });
    }
  },
});

export const labelDelete = defineOperation({
  name: 'label.delete',
  kind: 'mutation',
  domain: 'label',
  summary: 'Delete a label or label group',
  description:
    'Deletes a label for good and removes it from every issue that has it. A label group can be deleted only when it has no labels. Returns the label and how many issues it was removed from (only issues the caller can see are counted).',
  keywords: ['delete label', 'remove label', 'remove tag', 'delete label group'],
  input: z.object({ label: LabelRef, team: TeamRef.optional() }),
  output: z.object({ label: LabelSchema, removedFromIssues: z.int().min(0) }),
  permission: (p, refs) => mayChange(p, refs),
  destructive: true,
  examples: [{ label: 'Needs design' }],
  optimistic: (store, input) => {
    const teamId = teamIdOfRef(store, input.team);
    const label = findLabel(store, input.label, teamId);
    const scope = label && scopeOfLabel(store, label);
    if (label === undefined || scope === undefined) return;
    if (labelDeleteProblem(scope.labels, label) !== undefined) return;
    // Issues keep the dead id until the server's deltas rewrite them; renderers skip it (SPEC-010 §5).
    store.remove('Label', label.id);
  },
});

function archiveOptimistic(
  plan: typeof labelArchivePlan,
  archive: boolean,
): (store: OptimisticStore, input: { label: string; team?: string | undefined }) => void {
  return (store, input) => {
    const label = findLabel(store, input.label, teamIdOfRef(store, input.team));
    const scope = label && scopeOfLabel(store, label);
    if (label === undefined || scope === undefined) return;
    const result = plan(scope.labels, label);
    if (!result.ok) return;
    const at = store.now.toISOString();
    for (const row of result.changing) {
      if (archive) store.archive('Label', row.id);
      else store.unarchive('Label', row.id);
      store.patch('Label', row.id, { updatedAt: at });
    }
  };
}

export const labelArchive = defineOperation({
  name: 'label.archive',
  kind: 'mutation',
  domain: 'label',
  summary: 'Archive a label or label group',
  description:
    'Archives a label so it can no longer be added to issues; issues that have it keep it. Archiving a label group archives all its labels too. Archiving an archived label changes nothing. Name a team label by name together with team, or use its id.',
  keywords: ['archive label', 'retire label', 'hide label', 'archive label group'],
  input: z.object({ label: LabelRef, team: TeamRef.optional() }),
  output: LabelSchema,
  permission: (p, refs) => mayChange(p, refs),
  destructive: false,
  examples: [{ team: 'ENG', label: 'Needs design' }],
  optimistic: archiveOptimistic(labelArchivePlan, true),
});

export const labelUnarchive = defineOperation({
  name: 'label.unarchive',
  kind: 'mutation',
  domain: 'label',
  summary: 'Unarchive a label or label group',
  description:
    'Makes an archived label available again. Unarchiving a label group unarchives all its labels too. A label in an archived group stays archived until the group is unarchived. Unarchiving a label that is not archived changes nothing.',
  keywords: ['unarchive label', 'restore label', 'bring back label', 'unarchive label group'],
  input: z.object({ label: LabelRef, team: TeamRef.optional() }),
  output: LabelSchema,
  permission: (p, refs) => mayChange(p, refs),
  destructive: false,
  examples: [{ team: 'ENG', label: 'Needs design' }],
  optimistic: archiveOptimistic(labelUnarchivePlan, false),
});
