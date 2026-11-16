/**
 * `team.updateAutomations` (SPEC-015 §3.2, §6.1, AC-16). Takes the team row `FOR UPDATE` like every
 * workflow writer (SPEC-010 §4.4), so a concurrent status delete (which reads the auto-close
 * status under that lock, E22) and the jobs' `FOR SHARE` reads see one setting or the other.
 *
 * - Auto-archive has no off switch: only 1, 3, 6, 9 or 12 months (the operation's schema).
 * - `autoCloseMonths: null` turns auto-close off and clears the status, so a status isn't held
 *   against deletion by a feature that is off.
 * - Turning it on with no value sets 6 months and the team's first Canceled status.
 */
import { comparePositions, DEFAULT_AUTO_CLOSE_MONTHS, type StatusCategory } from '@surface/domain';
import { SurfaceError } from '../../executor/errors.js';
import { refNotFound } from '../../executor/refs/sources.js';
import type { ModelPatch, ModelRow } from '../../sync/models.js';
import type { Repo } from '../../sync/repo.js';

export interface AutomationStatus {
  readonly id: string;
  readonly name: string;
  readonly category: StatusCategory;
  readonly position: string;
}

export interface AutomationsAccess {
  /** The team row `FOR UPDATE`; undefined when it is gone. */
  lockTeam(teamId: string): Promise<ModelRow<'Team'> | undefined>;
  /** The team's statuses, read under that lock. */
  statuses(teamId: string): Promise<readonly AutomationStatus[]>;
}

export interface AutomationsInput {
  readonly teamRef: string;
  readonly teamId: string;
  readonly autoArchiveMonths?: number | undefined;
  /** `null` turns auto-close off; `undefined` leaves it. */
  readonly autoCloseMonths?: number | null | undefined;
  /** The resolved status id and the input's spelling of it, for messages. */
  readonly statusId?: string | undefined;
}

function invalid(path: string, message: string): SurfaceError {
  return new SurfaceError('INVALID_INPUT', message, { issues: [{ path: [path], message }] });
}

export async function updateAutomations(
  access: AutomationsAccess,
  repo: Repo,
  input: AutomationsInput,
): Promise<{
  readonly team: ModelRow<'Team'>;
  readonly changes: Record<string, { from: unknown; to: unknown }>;
}> {
  const team = await access.lockTeam(input.teamId);
  if (!team) throw refNotFound('TeamRef', input.teamRef, ['team']);
  const patch: ModelPatch<'Team'> = {};
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const set = <K extends 'autoArchiveMonths' | 'autoCloseMonths' | 'autoCloseStatusId'>(
    key: K,
    to: ModelRow<'Team'>[K],
  ) => {
    if (team[key] === to) return;
    // Same field, same value type: the key narrows both sides.
    Object.assign(patch, { [key]: to });
    changes[key] = { from: team[key], to };
  };

  if (input.autoArchiveMonths !== undefined) set('autoArchiveMonths', input.autoArchiveMonths);

  if (input.autoCloseMonths === null) {
    if (input.statusId !== undefined) {
      throw invalid('autoCloseStatus', 'Turn auto-close on to choose its status.');
    }
    set('autoCloseMonths', null);
    set('autoCloseStatusId', null);
  } else {
    const on = input.autoCloseMonths !== undefined || team.autoCloseMonths !== null;
    if (!on && input.statusId !== undefined) {
      throw invalid('autoCloseStatus', 'Turn auto-close on to choose its status.');
    }
    if (on) {
      const statuses = await access.statuses(team.id);
      const canceled = statuses
        .filter((s) => s.category === 'canceled')
        .sort((a, b) => comparePositions(a.position, b.position));
      let status: AutomationStatus | undefined;
      if (input.statusId !== undefined) {
        status = statuses.find((s) => s.id === input.statusId);
        // Deleted since the reference was resolved: the team lock makes this the final word.
        if (status === undefined) {
          throw new SurfaceError('CONFLICT', 'That status was deleted. Choose another status.');
        }
        if (status.category !== 'canceled') {
          throw invalid(
            'autoCloseStatus',
            `Auto-close needs a Canceled status, and "${status.name}" is not one. Choose one like "${canceled[0]?.name ?? 'Canceled'}".`,
          );
        }
      } else if (team.autoCloseStatusId !== null) {
        status = statuses.find((s) => s.id === team.autoCloseStatusId);
      }
      status ??= canceled[0];
      if (status === undefined) {
        throw invalid('autoCloseStatus', 'This team has no Canceled status. Add one first.');
      }
      set(
        'autoCloseMonths',
        input.autoCloseMonths ?? team.autoCloseMonths ?? DEFAULT_AUTO_CLOSE_MONTHS,
      );
      set('autoCloseStatusId', status.id);
    }
  }

  if (Object.keys(changes).length === 0) return { team, changes };
  const updated = await repo.update('Team', team.id, patch);
  return { team: updated, changes };
}
