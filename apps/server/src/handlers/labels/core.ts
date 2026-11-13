/**
 * The rules of the label operations (SPEC-010 §4.2, §4.4, §6), written against `LabelAccess`
 * (reads and locks) and the repo (writes), so the unit tests run them on an in-memory scope while
 * the handlers run them on Postgres (`access.ts`). The pure checks are `label-rules.ts` in the
 * domain package, which the client's `optimistic` calls too.
 *
 * Lock order (SPEC-010 §4.4): the scope row first (the workspace row for a workspace label, the
 * team row `FOR UPDATE` for a team label), which serialises the name, limit and group checks;
 * then the label being changed `FOR UPDATE`; a group the operation relies on is re-read
 * `FOR KEY SHARE`. `moveToWorkspace` locks the workspace row, then the team row. A label that is
 * gone, or moved to another scope since the executor resolved it, is `CONFLICT`.
 */
import {
  labelCreateProblem,
  labelDeleteProblem,
  labelMovePlan,
  labelUpdateProblem,
  type ColorHue,
  type LabelProblem,
} from '@surface/domain';
import { SurfaceError } from '../../executor/errors.js';
import { refNotFound } from '../../executor/refs/sources.js';
import type { ModelRow } from '../../sync/models.js';
import type { Repo } from '../../sync/repo.js';

export type LabelRow = ModelRow<'Label'>;

export interface LabelTeam {
  readonly id: string;
  readonly key: string;
}

/** Reads and locks, in the order of §4.4. Every method runs in the operation's transaction. */
export interface LabelAccess {
  /** The workspace row `FOR UPDATE`: the scope lock of workspace labels. */
  lockWorkspace(): Promise<void>;
  /** The team row `FOR UPDATE`; undefined when it is gone. */
  lockTeam(teamId: string): Promise<LabelTeam | undefined>;
  /** Every label of a scope (`null` is the workspace), archived ones included. */
  scopeLabels(teamId: string | null): Promise<LabelRow[]>;
  /** The label being changed, `FOR UPDATE`; undefined when it is gone. */
  lockLabel(labelId: string): Promise<LabelRow | undefined>;
  /** A group the operation relies on, re-read `FOR KEY SHARE`; undefined when it is gone. */
  shareLabel(labelId: string): Promise<LabelRow | undefined>;
}

const LABEL_GONE = 'That label was deleted or moved. Reload and try again.';
const GROUP_GONE = 'That label group was deleted. Choose another group.';

function refuse(problem: LabelProblem): SurfaceError {
  return new SurfaceError(problem.code, problem.message, {
    issues: [{ path: [problem.field], message: problem.message }],
  });
}

/** Locks the scope row; returns the team (null for the workspace). */
async function lockScope(
  access: LabelAccess,
  teamId: string | null,
  teamRef: string | undefined,
): Promise<LabelTeam | null> {
  if (teamId === null) {
    await access.lockWorkspace();
    return null;
  }
  const team = await access.lockTeam(teamId);
  // Resolved and visible at step 7; gone only if deleted since. Same words as the resolver's, so
  // a vanished team reads like any unknown one (permissions.md §5).
  if (!team) throw refNotFound('TeamRef', teamRef ?? teamId, ['team']);
  return team;
}

async function lockedLabel(
  access: LabelAccess,
  labelId: string,
  teamId: string | null,
): Promise<LabelRow> {
  const row = await access.lockLabel(labelId);
  if (!row || row.teamId !== teamId) throw new SurfaceError('CONFLICT', LABEL_GONE);
  return row;
}

async function sharedGroup(access: LabelAccess, groupId: string): Promise<LabelRow> {
  const row = await access.shareLabel(groupId);
  if (!row) throw new SurfaceError('CONFLICT', GROUP_GONE);
  return row;
}

// ---------------------------------------------------------------------------------------------

export interface CreateInput {
  readonly id: string;
  readonly teamRef?: string | undefined;
  readonly team?: LabelTeam | undefined;
  readonly name: string;
  readonly color?: ColorHue | undefined;
  readonly description?: string | undefined;
  readonly isGroup?: boolean | undefined;
  readonly exclusive?: boolean | undefined;
  readonly groupId?: string | undefined;
}

/** AC-9, AC-13, E14, E18, E19. */
export async function createLabel(
  access: LabelAccess,
  repo: Repo,
  input: CreateInput,
): Promise<LabelRow> {
  const teamId = input.team?.id ?? null;
  const team = await lockScope(access, teamId, input.teamRef);
  const group = input.groupId === undefined ? undefined : await sharedGroup(access, input.groupId);
  const isGroup = input.isGroup ?? false;
  const problem = labelCreateProblem(
    await access.scopeLabels(teamId),
    { teamId, teamKey: team?.key ?? null },
    { name: input.name, isGroup, exclusive: input.exclusive, group },
  );
  if (problem) throw refuse(problem);
  return repo.insert('Label', {
    id: input.id,
    teamId,
    name: input.name,
    color: input.color ?? 'gray',
    description: input.description ? input.description : null,
    parentId: group?.id ?? null,
    isGroup,
    exclusive: input.exclusive ?? true,
  });
}

export interface UpdateInput {
  readonly teamRef?: string | undefined;
  /** The label the executor resolved: its id and the scope it was resolved in. */
  readonly label: { readonly id: string; readonly teamId: string | null };
  readonly name?: string | undefined;
  readonly color?: ColorHue | undefined;
  readonly description?: string | undefined;
  readonly exclusive?: boolean | undefined;
  /** `undefined` leaves the group alone, `null` takes the label out of it. */
  readonly groupId?: string | null | undefined;
}

/** AC-9, AC-10 (no issue is read), E14, E18, E19. Writes only the fields that differ. */
export async function updateLabel(
  access: LabelAccess,
  repo: Repo,
  input: UpdateInput,
): Promise<LabelRow> {
  const team = await lockScope(access, input.label.teamId, input.teamRef);
  const label = await lockedLabel(access, input.label.id, input.label.teamId);
  const group =
    input.groupId === undefined || input.groupId === null
      ? input.groupId
      : await sharedGroup(access, input.groupId);
  const problem = labelUpdateProblem(
    await access.scopeLabels(label.teamId),
    { teamId: label.teamId, teamKey: team?.key ?? null },
    label,
    { name: input.name, exclusive: input.exclusive, group },
  );
  if (problem) throw refuse(problem);

  const patch: {
    name?: string;
    color?: ColorHue;
    description?: string | null;
    exclusive?: boolean;
    parentId?: string | null;
  } = {};
  if (input.name !== undefined && input.name !== label.name) patch.name = input.name;
  if (input.color !== undefined && input.color !== label.color) patch.color = input.color;
  if (input.description !== undefined) {
    const next = input.description === '' ? null : input.description;
    if (next !== label.description) patch.description = next;
  }
  if (input.exclusive !== undefined && input.exclusive !== label.exclusive) {
    patch.exclusive = input.exclusive;
  }
  if (group !== undefined) {
    const parentId = group === null ? null : group.id;
    if (parentId !== label.parentId) patch.parentId = parentId;
  }
  // Nothing differs: nothing is written, so no delta is sent.
  if (Object.keys(patch).length === 0) return label;
  return repo.update('Label', label.id, patch);
}

export interface DeleteInput {
  readonly teamRef?: string | undefined;
  readonly label: { readonly id: string; readonly teamId: string | null };
}

/**
 * AC-12. A hard delete: the row goes and clients get a `D` delta. Removing the id from issues is
 * PLAN-010 S5 (`removeLabelFromIssues`); until the issue table exists there is nothing to rewrite.
 */
export async function deleteLabel(
  access: LabelAccess,
  repo: Repo,
  input: DeleteInput,
): Promise<{ label: LabelRow; removedFromIssues: number }> {
  await lockScope(access, input.label.teamId, input.teamRef);
  const label = await lockedLabel(access, input.label.id, input.label.teamId);
  const problem = labelDeleteProblem(await access.scopeLabels(label.teamId), label);
  if (problem) throw refuse(problem);
  await repo.purge('Label', label.id);
  return { label, removedFromIssues: 0 };
}

export interface MoveInput {
  readonly teamRef: string;
  readonly team: LabelTeam;
  readonly label: { readonly id: string; readonly teamId: string | null };
}

/**
 * AC-24, E20, E21: sets `teamId` to null on the label, or on a group and all its labels (archived
 * included), through `repo.update`, so the repo logs the sync deltas (a `U`, or a `D` then a `U`
 * when the groups change). No issue is read. Returns the label named in the input.
 */
export async function moveLabelToWorkspace(
  access: LabelAccess,
  repo: Repo,
  input: MoveInput,
): Promise<LabelRow> {
  // The workspace row, then the team row (SPEC-011 §4.8's order).
  await access.lockWorkspace();
  await lockScope(access, input.team.id, input.teamRef);
  const label = await lockedLabel(access, input.label.id, input.label.teamId);
  if (label.teamId !== input.team.id) {
    const message =
      label.teamId === null
        ? `${label.name} is already a workspace label.`
        : `${label.name} is not a label of ${input.team.key}. Use the team the label belongs to.`;
    throw new SurfaceError('INVALID_INPUT', message, { issues: [{ path: ['label'], message }] });
  }
  const plan = labelMovePlan(
    await access.scopeLabels(input.team.id),
    await access.scopeLabels(null),
    label,
  );
  if (!plan.ok) throw refuse(plan.problem);

  // Rows in ascending id, like every multi-row lock (SPEC-011 §4.8).
  const ids = plan.moving.map((l) => l.id).sort();
  let moved = label;
  for (const id of ids) {
    if (id !== label.id && !(await access.lockLabel(id))) {
      throw new SurfaceError('CONFLICT', LABEL_GONE);
    }
  }
  for (const id of ids) {
    const row = await repo.update('Label', id, { teamId: null });
    if (id === label.id) moved = row;
  }
  return moved;
}
