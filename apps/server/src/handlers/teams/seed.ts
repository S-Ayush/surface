/**
 * What a new team and a new workspace start with (SPEC-001 §4, PLAN-001 S1), written through the
 * repo so every row is logged for sync. Setup (PLAN-001 S2) and `team.create` (S8) use these.
 *
 * A team and its statuses refer to each other (`teams.default_status_id`, INV-05). Make the
 * workflow first with `teamWorkflow(teamId)`, insert the team with its `defaultStatusId`, then
 * `seedTeamWorkflow`: the foreign key is checked at commit, and the statuses' groups are read
 * from the team row, which must exist by then.
 */
import {
  DEFAULT_STATUS_NAME,
  DEFAULT_TEAM_WORKFLOW,
  DEFAULT_WORKSPACE_LABELS,
  type StatusCategory,
} from '@surface/domain';
import { uuidv7 } from '../../db/uuidv7.js';
import type { ModelInsert, ModelRow } from '../../sync/models.js';
import type { Repo } from '../../sync/repo.js';

export interface TeamWorkflow {
  readonly defaultStatusId: string;
  readonly statuses: readonly ModelInsert<'WorkflowStatus'>[];
}

/** The statuses a new team gets, with fresh ids, and which one is the default. */
export function teamWorkflow(teamId: string): TeamWorkflow {
  const inCategory = new Map<StatusCategory, number>();
  let defaultStatusId: string | undefined;
  const statuses = DEFAULT_TEAM_WORKFLOW.map((seed) => {
    const n = inCategory.get(seed.category) ?? 0;
    inCategory.set(seed.category, n + 1);
    const id = uuidv7();
    if (seed.name === DEFAULT_STATUS_NAME) defaultStatusId = id;
    return {
      id,
      teamId,
      name: seed.name,
      category: seed.category,
      color: seed.color,
      // Fractional-index keys (domain-model §1): a0, a1, … order statuses within a category.
      position: `a${n}`,
      // Computed by the repo with `groupsOf`; the column has no default, so the type wants one.
    };
  });
  if (defaultStatusId === undefined) {
    throw new Error(`DEFAULT_TEAM_WORKFLOW has no ${DEFAULT_STATUS_NAME} status`);
  }
  return { defaultStatusId, statuses };
}

/** Inserts a team's workflow statuses (after the team row) and returns them. */
export async function seedTeamWorkflow(
  repo: Repo,
  workflow: TeamWorkflow,
): Promise<ModelRow<'WorkflowStatus'>[]> {
  const rows: ModelRow<'WorkflowStatus'>[] = [];
  for (const status of workflow.statuses) rows.push(await repo.insert('WorkflowStatus', status));
  return rows;
}

/** Inserts the workspace labels created at setup (Bug, Feature, Improvement). */
export async function seedWorkspaceLabels(repo: Repo): Promise<ModelRow<'Label'>[]> {
  const rows: ModelRow<'Label'>[] = [];
  for (const label of DEFAULT_WORKSPACE_LABELS) {
    rows.push(
      await repo.insert('Label', {
        id: uuidv7(),
        teamId: null,
        name: label.name,
        color: label.color,
      }),
    );
  }
  return rows;
}
