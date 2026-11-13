/**
 * The rules of the status operations (SPEC-010 §4.1, §4.4, §6), written against `WorkflowAccess`
 * (reads and locks) and the repo (writes), so the unit and property tests run them on an
 * in-memory workflow while the handlers run them on Postgres (`access.ts`).
 *
 * Lock order (SPEC-010 §4.4): the team row `FOR UPDATE` first, which serialises every writer of
 * the team's workflow (E3, E16, E17); then the status being changed; every other status the
 * operation relies on (an anchor) is re-read `FOR KEY SHARE`. A status that is gone, or that
 * changed so a rule breaks, is `CONFLICT`.
 */
import {
  DEFAULT_STATUS_CATEGORIES,
  STATUS_CATEGORY_COLORS,
  placeStatus,
  statusDeleteProblem,
  statusLimitProblem,
  statusNameProblem,
  type ColorHue,
  type StatusCategory,
  type StatusIssueCounts,
} from '@surface/domain';
import { SurfaceError } from '../../executor/errors.js';
import { refNotFound } from '../../executor/refs/sources.js';
import type { ModelRow } from '../../sync/models.js';
import type { Repo } from '../../sync/repo.js';

export type StatusRow = ModelRow<'WorkflowStatus'>;

/** What the rules read of the team, under its row lock. */
export interface WorkflowTeam {
  readonly id: string;
  readonly key: string;
  readonly defaultStatusId: string;
  /** SPEC-015 §3.2: the status auto-close uses, which can't be deleted (E22). */
  readonly autoCloseStatusId: string | null;
}

/** Reads and locks, in the order of §4.4. Every method runs in the operation's transaction. */
export interface WorkflowAccess {
  /** Step 1: the team row `FOR UPDATE`; undefined when it is gone. */
  lockTeam(teamId: string): Promise<WorkflowTeam | undefined>;
  /** All of the team's statuses, read under the team lock. */
  statuses(teamId: string): Promise<StatusRow[]>;
  /** Step 2: the status being changed, `FOR UPDATE`; undefined when it is gone. */
  lockStatus(statusId: string): Promise<StatusRow | undefined>;
  /** An anchor or other relied-on status, re-read `FOR KEY SHARE`; undefined when it is gone. */
  shareStatus(statusId: string): Promise<StatusRow | undefined>;
  /**
   * Issues that use the status, by lifecycle state. Until PLAN-010 S5 there is no issue table:
   * the count is zero by construction.
   */
  issueCounts(statusId: string): Promise<StatusIssueCounts>;
}

export interface TeamTarget {
  readonly id: string;
  readonly key: string;
}

const GONE = 'That status was deleted. Choose another status.';

function invalid(field: string, message: string): SurfaceError {
  return new SurfaceError('INVALID_INPUT', message, { issues: [{ path: [field], message }] });
}

async function lockedTeam(
  access: WorkflowAccess,
  team: TeamTarget,
  teamRef: string,
): Promise<WorkflowTeam> {
  const locked = await access.lockTeam(team.id);
  // Resolved and visible at step 7; gone only if deleted since. Same words as the resolver's, so
  // a vanished team reads like any unknown one (permissions.md §5).
  if (!locked) throw refNotFound('TeamRef', teamRef, ['team']);
  return locked;
}

function nameClash(
  statuses: readonly StatusRow[],
  name: string,
  team: TeamTarget,
  exceptId?: string,
): SurfaceError | undefined {
  const lower = name.toLowerCase();
  if (!statuses.some((s) => s.id !== exceptId && s.name.toLowerCase() === lower)) return undefined;
  const message = `A status named "${name}" already exists in ${team.key}. Choose another name.`;
  return new SurfaceError('CONFLICT', message, { issues: [{ path: ['name'], message }] });
}

function checkName(name: string): void {
  const problem = statusNameProblem(name);
  if (problem !== undefined) throw invalid('name', problem);
}

/** A status the operation resolved, as the row the lock sees now (`CONFLICT` when gone). */
async function lockedStatus(access: WorkflowAccess, statusId: string): Promise<StatusRow> {
  const row = await access.lockStatus(statusId);
  if (!row) throw new SurfaceError('CONFLICT', GONE);
  return row;
}

// ---------------------------------------------------------------------------------------------

export interface CreateInput {
  readonly id: string;
  readonly teamRef: string;
  readonly team: TeamTarget;
  readonly name: string;
  readonly category: StatusCategory;
  readonly color?: ColorHue | undefined;
  readonly description?: string | undefined;
  readonly after?: string | undefined;
}

/** AC-1, AC-13. */
export async function createStatus(
  access: WorkflowAccess,
  repo: Repo,
  input: CreateInput,
): Promise<StatusRow> {
  checkName(input.name);
  await lockedTeam(access, input.team, input.teamRef);
  const statuses = await access.statuses(input.team.id);
  const clash = nameClash(statuses, input.name, input.team);
  if (clash) throw clash;
  const limit = statusLimitProblem(statuses.length);
  if (limit !== undefined) throw new SurfaceError('INVALID_INPUT', limit);

  let after: string | undefined;
  if (input.after !== undefined) {
    // The anchor was resolved before the lock: a vanished one is CONFLICT (E4).
    const anchor = await access.shareStatus(input.after);
    if (!anchor) throw new SurfaceError('CONFLICT', GONE);
    after = anchor.id;
  }
  const placed = placeStatus(statuses, input.category, { after });
  if (!placed.ok) throw invalid(placed.field, placed.message);

  return repo.insert('WorkflowStatus', {
    id: input.id,
    teamId: input.team.id,
    name: input.name,
    category: input.category,
    color: input.color ?? STATUS_CATEGORY_COLORS[input.category],
    description: input.description ? input.description : null,
    position: placed.position,
  });
}

export interface UpdateInput {
  readonly teamRef: string;
  readonly team: TeamTarget;
  readonly statusId: string;
  readonly name?: string | undefined;
  readonly color?: ColorHue | undefined;
  readonly description?: string | undefined;
}

/** AC-2. Returns the row, and the changed fields as `{ from, to }`. */
export async function updateStatus(
  access: WorkflowAccess,
  repo: Repo,
  input: UpdateInput,
): Promise<StatusRow> {
  if (input.name !== undefined) checkName(input.name);
  await lockedTeam(access, input.team, input.teamRef);
  const status = await lockedStatus(access, input.statusId);
  if (status.category === 'duplicate') {
    throw new SurfaceError('INVALID_INPUT', "Duplicate is a system status and can't be changed.");
  }
  if (input.name !== undefined) {
    const clash = nameClash(
      await access.statuses(input.team.id),
      input.name,
      input.team,
      status.id,
    );
    if (clash) throw clash;
  }
  const patch: {
    name?: string;
    color?: ColorHue;
    description?: string | null;
  } = {};
  if (input.name !== undefined && input.name !== status.name) patch.name = input.name;
  if (input.color !== undefined && input.color !== status.color) patch.color = input.color;
  if (input.description !== undefined) {
    const next = input.description === '' ? null : input.description;
    if (next !== status.description) patch.description = next;
  }
  // Nothing differs: nothing is written, so no delta is sent.
  if (Object.keys(patch).length === 0) return status;
  return repo.update('WorkflowStatus', status.id, patch);
}

export interface ReorderInput {
  readonly teamRef: string;
  readonly team: TeamTarget;
  readonly statusId: string;
  readonly before?: string | undefined;
  readonly after?: string | undefined;
}

/** AC-3: writes the moved row only. */
export async function reorderStatus(
  access: WorkflowAccess,
  repo: Repo,
  input: ReorderInput,
): Promise<StatusRow> {
  await lockedTeam(access, input.team, input.teamRef);
  const status = await lockedStatus(access, input.statusId);
  if (status.category === 'triage' || status.category === 'duplicate') {
    throw invalid(
      input.before !== undefined ? 'before' : 'after',
      `${status.category === 'triage' ? 'Triage' : 'Duplicate'} is a system status and can't be moved.`,
    );
  }
  const anchorId = input.before ?? input.after;
  if (anchorId !== undefined) {
    const anchor = await access.shareStatus(anchorId);
    if (!anchor) throw new SurfaceError('CONFLICT', GONE);
  }
  const statuses = await access.statuses(input.team.id);
  const placed = placeStatus(
    statuses,
    status.category,
    input.before !== undefined ? { before: input.before } : { after: input.after },
    status.id,
  );
  if (!placed.ok) throw invalid(placed.field, placed.message);
  if (placed.unchanged) return status;
  return repo.update('WorkflowStatus', status.id, { position: placed.position });
}

export interface DeleteInput {
  readonly teamRef: string;
  readonly team: TeamTarget;
  readonly statusId: string;
}

/** AC-5. A hard delete (D16): the row goes and clients get a `D` delta. */
export async function deleteStatus(
  access: WorkflowAccess,
  repo: Repo,
  input: DeleteInput,
): Promise<StatusRow> {
  const team = await lockedTeam(access, input.team, input.teamRef);
  const status = await lockedStatus(access, input.statusId);
  const statuses = await access.statuses(input.team.id);
  // Counted after the status row lock: an issue edit that took its key lock first has finished,
  // and a later one fails with CONFLICT (SPEC-010 §4.4).
  const problem = statusDeleteProblem(
    { statuses, statusId: status.id },
    team.defaultStatusId,
    await access.issueCounts(status.id),
    team.autoCloseStatusId,
  );
  if (problem) throw new SurfaceError('CONFLICT', problem.message);
  await repo.purge('WorkflowStatus', status.id);
  return status;
}

export interface SetDefaultInput {
  readonly teamRef: string;
  readonly team: TeamTarget;
  readonly statusId: string;
}

/**
 * `team.setDefaultStatus` (SPEC-010 §6, INV-05, E17). Team row first, then the status re-read
 * `FOR KEY SHARE`, so a `status.delete` of it either finished before (`CONFLICT` here) or waits
 * for this commit and is then refused as the default. `changed` is undefined when the status
 * already was the default: nothing is written.
 */
export async function setDefaultStatus(
  access: WorkflowAccess,
  repo: Repo,
  input: SetDefaultInput,
): Promise<{ readonly changed?: { team: ModelRow<'Team'>; from: string } }> {
  const team = await lockedTeam(access, input.team, input.teamRef);
  const status = await access.shareStatus(input.statusId);
  if (!status) throw new SurfaceError('CONFLICT', GONE);
  // The permission check ran against the status's own team; this keeps a status of another team
  // from ever becoming this team's default, whatever the resolver returned.
  if (status.teamId !== team.id) throw refNotFound('StatusRef', input.statusId, ['status']);
  if (!DEFAULT_STATUS_CATEGORIES.includes(status.category)) {
    throw invalid(
      'status',
      `The default status must be in the Backlog or Unstarted category, and "${status.name}" is not. Choose a Backlog or Unstarted status.`,
    );
  }
  if (team.defaultStatusId === status.id) return {};
  const from = team.defaultStatusId;
  const updated = await repo.update('Team', team.id, { defaultStatusId: status.id });
  return { changed: { team: updated, from } };
}
