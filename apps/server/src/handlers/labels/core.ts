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
  labelArchivePlan,
  labelCreateProblem,
  labelDeleteProblem,
  labelMovePlan,
  labelUnarchivePlan,
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
  /**
   * `label.delete`'s cascade (PLAN-011 S4's `removeLabelFromIssues`): removes the label from
   * `labelIds` of every issue that has it, whatever its lifecycle state, through the repo's bulk
   * path (issues locked in ascending id, `touchUpdatedAt: false`). Returns the rewritten ids.
   * Called only while holding the scope row and the label row (SPEC-010 §4.4).
   */
  removeFromIssues(labelId: string): Promise<readonly string[]>;
  /** How many of `issueIds` the actor can see (`visibleTo`: sync groups and a key's teams). */
  visibleIssueCount(issueIds: readonly string[]): Promise<number>;
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
  /** What a vanished team means: an unknown team (the default), or a label that is gone. */
  gone: 'team' | 'label' = 'team',
): Promise<LabelTeam | null> {
  if (teamId === null) {
    await access.lockWorkspace();
    return null;
  }
  const team = await access.lockTeam(teamId);
  // Resolved and visible at step 7; gone only if deleted since. Same words as the resolver's, so
  // a vanished team reads like any unknown one (permissions.md §5).
  if (!team) {
    // An existing label whose team was deleted meanwhile is a gone label, not a bad team input.
    if (gone === 'label') throw new SurfaceError('CONFLICT', LABEL_GONE);
    throw refNotFound('TeamRef', teamRef ?? teamId, ['team']);
  }
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

/**
 * Re-reads a group `FOR KEY SHARE`. Gone, or moved to another scope than the one the executor
 * resolved it in (`teamId`, when known), is `CONFLICT`: a concurrent change, not bad input
 * (SPEC-010 §4.4).
 */
async function sharedGroup(
  access: LabelAccess,
  groupId: string,
  teamId?: string | null,
): Promise<LabelRow> {
  const row = await access.shareLabel(groupId);
  if (!row || (teamId !== undefined && row.teamId !== teamId)) {
    throw new SurfaceError('CONFLICT', GROUP_GONE);
  }
  return row;
}

/** A team label of another team than the one named is refused, as `label.moveToWorkspace` does. */
function requireLabelTeam(
  label: { readonly teamId: string | null },
  team: { readonly id: string } | undefined,
  name: string,
): void {
  if (team === undefined || label.teamId === null || label.teamId === team.id) return;
  const message = `${name} is not a label of the team you named. Use the team the label belongs to.`;
  throw new SurfaceError('INVALID_INPUT', message, { issues: [{ path: ['label'], message }] });
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
  /** The scope the executor resolved the group in; a different one now is a concurrent move. */
  readonly groupTeamId?: string | null | undefined;
}

/** AC-9, AC-13, E14, E18, E19. */
export async function createLabel(
  access: LabelAccess,
  repo: Repo,
  input: CreateInput,
): Promise<LabelRow> {
  const teamId = input.team?.id ?? null;
  const team = await lockScope(access, teamId, input.teamRef);
  const group =
    input.groupId === undefined
      ? undefined
      : await sharedGroup(access, input.groupId, input.groupTeamId);
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
  /** The team named in the input, resolved; a team label of another team is refused. */
  readonly team?: { readonly id: string } | undefined;
  /** The label the executor resolved: its id and the scope it was resolved in. */
  readonly label: { readonly id: string; readonly teamId: string | null; readonly name?: string };
  readonly name?: string | undefined;
  readonly color?: ColorHue | undefined;
  readonly description?: string | undefined;
  readonly exclusive?: boolean | undefined;
  /** `undefined` leaves the group alone, `null` takes the label out of it. */
  readonly groupId?: string | null | undefined;
  readonly groupTeamId?: string | null | undefined;
}

/** AC-9, AC-10 (no issue is read), E14, E18, E19. Writes only the fields that differ. */
export async function updateLabel(
  access: LabelAccess,
  repo: Repo,
  input: UpdateInput,
): Promise<LabelRow> {
  requireLabelTeam(input.label, input.team, input.label.name ?? 'That label');
  const team = await lockScope(access, input.label.teamId, input.teamRef, 'label');
  const label = await lockedLabel(access, input.label.id, input.label.teamId);
  const group =
    input.groupId === undefined || input.groupId === null
      ? input.groupId
      : await sharedGroup(access, input.groupId, input.groupTeamId);
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
  readonly team?: { readonly id: string } | undefined;
  readonly label: { readonly id: string; readonly teamId: string | null; readonly name?: string };
}

/**
 * AC-12, E7. Lock order (SPEC-010 §4.4, SPEC-011 §4.8): the scope row, then the label row
 * `FOR UPDATE`, then the cascade locks the issues that carry the label in ascending id. Holding
 * the label means no edit can newly add it (edits take `FOR KEY SHARE` on a label before the
 * issue lock), so the set of issues is final. The issues keep their `updatedAt`, history and
 * lifecycle; then the label row goes and clients get a `D` delta. `removedFromIssues` counts only
 * the issues the actor can see: a workspace label leaves private teams' issues too.
 */
export async function deleteLabel(
  access: LabelAccess,
  repo: Repo,
  input: DeleteInput,
): Promise<{ label: LabelRow; removedFromIssues: number }> {
  requireLabelTeam(input.label, input.team, input.label.name ?? 'That label');
  await lockScope(access, input.label.teamId, input.teamRef, 'label');
  const label = await lockedLabel(access, input.label.id, input.label.teamId);
  const problem = labelDeleteProblem(await access.scopeLabels(label.teamId), label);
  if (problem) throw refuse(problem);
  const rewritten = await access.removeFromIssues(label.id);
  const removedFromIssues = rewritten.length === 0 ? 0 : await access.visibleIssueCount(rewritten);
  await repo.purge('Label', label.id);
  return { label, removedFromIssues };
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
  if (input.label.teamId !== input.team.id) {
    // Names the label for the message; a plain read, as the row is not being changed.
    const named = (await access.scopeLabels(input.label.teamId)).find(
      (l) => l.id === input.label.id,
    );
    const name = named?.name ?? 'That label';
    const message =
      input.label.teamId === null
        ? `${name} is already a workspace label.`
        : `${name} is not a label of ${input.team.key}. Use the team the label belongs to.`;
    throw new SurfaceError('INVALID_INPUT', message, { issues: [{ path: ['label'], message }] });
  }
  const teamLabels = await access.scopeLabels(input.team.id);
  const label = teamLabels.find((l) => l.id === input.label.id);
  if (!label) throw new SurfaceError('CONFLICT', LABEL_GONE);
  const plan = labelMovePlan(teamLabels, await access.scopeLabels(null), label);
  if (!plan.ok) throw refuse(plan.problem);

  // Every row that moves, the named one included, in ascending id (SPEC-011 §4.8). The named row
  // is checked again once locked: it may have changed since the plan read it.
  const ids = plan.moving.map((l) => l.id).sort();
  for (const id of ids) {
    const locked = await access.lockLabel(id);
    if (!locked || locked.teamId !== input.team.id) throw new SurfaceError('CONFLICT', LABEL_GONE);
    if (
      id === label.id &&
      (locked.parentId !== label.parentId || locked.isGroup !== label.isGroup)
    ) {
      throw new SurfaceError('CONFLICT', LABEL_GONE);
    }
  }
  let moved: LabelRow = label;
  for (const id of ids) {
    const row = await repo.update('Label', id, { teamId: null });
    if (id === label.id) moved = row;
  }
  return moved;
}

export interface ArchiveInput {
  readonly teamRef?: string | undefined;
  readonly team?: { readonly id: string } | undefined;
  readonly label: { readonly id: string; readonly teamId: string | null; readonly name?: string };
}

/**
 * AC-11, E14, D26: archives the label, or a group and all its labels, through `repo.archive`
 * (or `repo.unarchive`), so the repo logs an `A` (or `V`) carrying the row. Rows already in the
 * wanted state are not written, so archiving an archived label sends nothing. Returns the label
 * named in the input. No issue is read.
 */
async function setArchived(
  access: LabelAccess,
  repo: Repo,
  input: ArchiveInput,
  archive: boolean,
): Promise<LabelRow> {
  requireLabelTeam(input.label, input.team, input.label.name ?? 'That label');
  await lockScope(access, input.label.teamId, input.teamRef, 'label');
  const label = await lockedLabel(access, input.label.id, input.label.teamId);
  // Unarchiving relies on the group's state: re-read it FOR KEY SHARE (§4.4). The scope lock
  // already serialises every label operation of the scope, so the plan sees the same rows.
  if (!archive && label.parentId !== null) {
    const group = await access.shareLabel(label.parentId);
    if (!group || group.teamId !== label.teamId) {
      throw new SurfaceError(
        'CONFLICT',
        'That label’s group was deleted or moved. Reload and try again.',
      );
    }
  }
  const scopeLabels = await access.scopeLabels(label.teamId);
  const plan = archive
    ? labelArchivePlan(scopeLabels, label)
    : labelUnarchivePlan(scopeLabels, label);
  if (!plan.ok) throw refuse(plan.problem);
  // Ascending id, like every multi-row write (SPEC-011 §4.8).
  const ids = plan.changing.map((l) => l.id).sort();
  let named: LabelRow = label;
  for (const id of ids) {
    const row = archive ? await repo.archive('Label', id) : await repo.unarchive('Label', id);
    if (id === label.id) named = row;
  }
  return named;
}

export const archiveLabel = (access: LabelAccess, repo: Repo, input: ArchiveInput) =>
  setArchived(access, repo, input, true);

export const unarchiveLabel = (access: LabelAccess, repo: Repo, input: ArchiveInput) =>
  setArchived(access, repo, input, false);
