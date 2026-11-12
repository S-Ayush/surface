// PLAN-001 S1: a new team's workflow and the workspace labels satisfy INV-04 and INV-05, and are
// written through the repo (so they are logged for sync), in an order the deferred default-status
// foreign key and `groupsOf` accept.
import { DEFAULT_TEAM_WORKFLOW, workflowProblems } from '@surface/domain';
import { describe, expect, it } from 'vitest';
import { seedTeamWorkflow, seedWorkspaceLabels, teamWorkflow } from '../src/handlers/teams/seed.js';
import type { Repo } from '../src/sync/repo.js';

const TEAM = '0190f0c0-0000-7000-8000-0000000000aa';

/** A repo that records inserts and returns what it was given. */
function recordingRepo() {
  const inserts: { model: string; row: Readonly<Record<string, unknown>> }[] = [];
  const fail = () => Promise.reject(new Error('unexpected repo call'));
  const repo: Repo = {
    insert: (model, row) => {
      inserts.push({ model, row });
      return Promise.resolve({ ...row, createdAt: new Date(), updatedAt: new Date() } as never);
    },
    update: fail,
    archive: fail,
    unarchive: fail,
    purge: fail,
    updateWhere: fail,
    deleteWhere: fail,
    changes: () => [],
  };
  return { repo, inserts };
}

describe('teamWorkflow', () => {
  const workflow = teamWorkflow(TEAM);

  it('satisfies INV-04 and INV-05', () => {
    expect(workflowProblems(workflow.statuses, workflow.defaultStatusId)).toEqual([]);
  });

  it('makes Backlog the default, every status the team’s, each with its own id', () => {
    const backlog = workflow.statuses.find((s) => s.id === workflow.defaultStatusId);
    expect(backlog?.name).toBe('Backlog');
    expect(workflow.statuses.every((s) => s.teamId === TEAM)).toBe(true);
    expect(new Set(workflow.statuses.map((s) => s.id)).size).toBe(DEFAULT_TEAM_WORKFLOW.length);
    expect(teamWorkflow(TEAM).defaultStatusId).not.toBe(workflow.defaultStatusId);
  });

  it('orders statuses within each category in display order', () => {
    const started = workflow.statuses.filter((s) => s.category === 'started');
    expect(started.map((s) => [s.name, s.position])).toEqual([
      ['In Progress', 'a0'],
      ['In Review', 'a1'],
    ]);
    const positions = workflow.statuses.map((s) => `${s.category}/${s.position}`);
    expect(new Set(positions).size).toBe(positions.length);
  });
});

describe('seedTeamWorkflow', () => {
  it('inserts every status through the repo, in order', async () => {
    const { repo, inserts } = recordingRepo();
    const workflow = teamWorkflow(TEAM);
    await seedTeamWorkflow(repo, workflow);
    expect(inserts.map((i) => i.model)).toEqual(Array(8).fill('WorkflowStatus'));
    expect(inserts.map((i) => i.row['id'])).toEqual(workflow.statuses.map((s) => s.id));
  });
});

describe('seedWorkspaceLabels', () => {
  it('inserts Bug, Feature and Improvement as workspace labels', async () => {
    const { repo, inserts } = recordingRepo();
    const rows = await seedWorkspaceLabels(repo);
    expect(inserts.map((i) => [i.model, i.row['name'], i.row['teamId']])).toEqual([
      ['Label', 'Bug', null],
      ['Label', 'Feature', null],
      ['Label', 'Improvement', null],
    ]);
    expect(rows).toHaveLength(3);
  });
});
