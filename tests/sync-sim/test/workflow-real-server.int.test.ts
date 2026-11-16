/**
 * PLAN-010 S5, the sync property suite for the workflow (not held, plans README §6), against the
 * real server: SPEC-010 AC-19. Status creates, deletes and default moves and label deletes race
 * issue creates and edits into the same status or label (E3, E16, E17); after every run no issue
 * names a deleted status or label, INV-04/05 hold, and every replica, streamed or freshly
 * bootstrapped, shows the server's workflow. Only the real server has issues, so the fake hub's
 * suite has no workflow case.
 */
import fc from 'fast-check';
import { describe, expect, inject, it } from 'vitest';
import { simParameters } from '../src/context.js';
import { workflowConvergence } from '../src/properties.js';
import type { RealServer } from '../src/real-server.js';
import { startRealServer } from '../src/real-server.js';
import type { SimServer } from '../src/server.js';
import { simulate } from '../src/simulate.js';
import type { Case } from '../src/steps.js';
import { workflowCase } from '../src/steps.js';

/** A real server for `simulate`, with the labels and the second team the issue steps name. */
function workflowServers() {
  let latest: RealServer | undefined;
  const server = async (users: number): Promise<SimServer> => {
    latest = await startRealServer({
      adminUrl: inject('pgAdminUrl'),
      template: inject('pgTemplateDb'),
      users,
    });
    await latest.seedIssueFixtures();
    return latest;
  };
  return { server, last: () => latest };
}

/**
 * SIM's default moves from Todo to Backlog (E17), so Unstarted holds Todo and a new Blocked,
 * neither the default. One tab, offline, deletes Blocked while another deletes Todo: the offline
 * delete commits second and is refused, so Unstarted keeps a status (E3). Meanwhile an issue
 * moves into Blocked and gets Size/Small as Size/Small is deleted (E16).
 */
const races: Case = {
  seed: 11,
  users: 3,
  lateUsers: 0,
  webLocks: true,
  steps: [
    { t: 'statusCreate', tab: 0, status: 'Blocked' },
    { t: 'issueCreate', tab: 0, title: 'Alpha', status: 'In Progress', labels: ['Flaky'] },
    { t: 'setDefaultStatus', tab: 2, status: 'Backlog' },
    { t: 'wait', ms: 2_000 },
    { t: 'offline', tab: 1, ms: 3_000 },
    { t: 'statusDelete', tab: 1, status: 'Blocked' },
    { t: 'statusDelete', tab: 0, status: 'Todo' },
    {
      t: 'issueUpdate',
      tab: 2,
      issue: 0,
      status: 'Blocked',
      addLabels: ['Size/Small'],
      removeLabels: [],
    },
    { t: 'labelDelete', tab: 0, label: 'Size/Small' },
    { t: 'wait', ms: 6_000 },
  ],
};

describe('the workflow against the real server (SPEC-010 AC-19)', () => {
  it('refuses the second delete of a category’s last two statuses, and leaves no issue on a deleted status or label (E3, E16, E17)', async () => {
    const servers = workflowServers();
    const result = await simulate(
      races,
      { ...workflowConvergence.options, server: servers.server },
      async (outcome) => {
        await workflowConvergence.check(outcome);
        const state = await servers.last()?.workflow();
        const sim = state?.teams.find((t) => t.key === 'SIM')?.id;
        const issues = (await servers.last()?.issues()) ?? {};
        return {
          outcomes: outcome.world.dispatched
            .filter((d) => d.op !== 'issue.create' && d.op !== 'issue.update')
            .map((d) => `${d.op} ${JSON.stringify(d.input)} ${String(d.outcome?.status)}`),
          unstarted: (state?.statuses ?? [])
            .filter((s) => s.teamId === sim && s.category === 'unstarted')
            .map((s) => s.name)
            .sort(),
          labels: Object.values(issues).map((i) => i.labelIds),
          small: servers.last()?.issueFixtures?.labels['Size/Small'],
        };
      },
    );
    const status = (op: string) =>
      result.outcomes.filter((o) => o.startsWith(`${op} `)).map((o) => o.split(' ').at(-1));
    expect(status('status.create')).toEqual(['confirmed']);
    // Todo's delete commits first; the offline tab's then deletes the last Unstarted (E3).
    expect(result.unstarted, result.outcomes.join('\n')).toEqual(['Blocked']);
    expect(status('status.delete')).toEqual(['rejected', 'confirmed']);
    expect(status('label.delete')).toEqual(['confirmed']);
    expect(status('team.setDefaultStatus')).toEqual(['confirmed']);
    for (const labels of result.labels) expect(labels).not.toContain(result.small);
  });

  it('every tab converges on the workflow and no issue names a deleted status or label, after any faults (AC-19)', async () => {
    const { server } = workflowServers();
    await fc.assert(
      fc.asyncProperty(workflowCase(), (simCase) =>
        simulate(simCase, { ...workflowConvergence.options, server }, workflowConvergence.check),
      ),
      simParameters(),
    );
  });
});
