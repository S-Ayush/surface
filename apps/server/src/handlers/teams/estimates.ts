/**
 * `team.setEstimates` (SPEC-010 §3.3, §4.3, §6). Takes the team row `FOR UPDATE` like every
 * workflow writer (§4.4) and writes only the settings that differ. It never reads or writes an
 * issue: stored estimates are kept whatever the new settings allow (D21, E5).
 */
import { refNotFound } from '../../executor/refs/sources.js';
import type { ModelPatch, ModelRow } from '../../sync/models.js';
import type { Repo } from '../../sync/repo.js';

export type TeamSettingsRow = ModelRow<'Team'>;

export interface EstimateAccess {
  /** The team row `FOR UPDATE`; undefined when it is gone. */
  lockTeam(teamId: string): Promise<TeamSettingsRow | undefined>;
}

export interface EstimateInput {
  readonly teamRef: string;
  readonly teamId: string;
  readonly scale?: TeamSettingsRow['estimateScale'] | undefined;
  readonly extended?: boolean | undefined;
  readonly allowZero?: boolean | undefined;
  readonly countUnestimatedAsOne?: boolean | undefined;
}

export interface EstimateResult {
  readonly team: TeamSettingsRow;
  /** Only the settings that changed, for the event. */
  readonly changes: Record<string, { from: unknown; to: unknown }>;
}

export async function setEstimates(
  access: EstimateAccess,
  repo: Repo,
  input: EstimateInput,
): Promise<EstimateResult> {
  const team = await access.lockTeam(input.teamId);
  // Same words as the resolver's, so a vanished team reads like any unknown one.
  if (!team) throw refNotFound('TeamRef', input.teamRef, ['team']);
  const patch: ModelPatch<'Team'> = {};
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (input.scale !== undefined && input.scale !== team.estimateScale) {
    patch.estimateScale = input.scale;
    changes['estimateScale'] = { from: team.estimateScale, to: input.scale };
  }
  if (input.extended !== undefined && input.extended !== team.estimateExtended) {
    patch.estimateExtended = input.extended;
    changes['estimateExtended'] = { from: team.estimateExtended, to: input.extended };
  }
  if (input.allowZero !== undefined && input.allowZero !== team.estimateAllowZero) {
    patch.estimateAllowZero = input.allowZero;
    changes['estimateAllowZero'] = { from: team.estimateAllowZero, to: input.allowZero };
  }
  const count = input.countUnestimatedAsOne;
  if (count !== undefined && count !== team.estimateCountUnestimatedAsOne) {
    patch.estimateCountUnestimatedAsOne = count;
    changes['estimateCountUnestimatedAsOne'] = {
      from: team.estimateCountUnestimatedAsOne,
      to: count,
    };
  }
  if (Object.keys(changes).length === 0) return { team, changes };
  const updated = await repo.update('Team', team.id, patch);
  return { team: updated, changes };
}
