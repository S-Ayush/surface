/**
 * PLAN-011 S4, the sync property suite for issues (not held, plans README §6), against the real
 * server: SPEC-011 AC-2 (numbers gap-free in commit order, distinct sort keys), AC-4 (label
 * edits converge, the exclusive rule holds), E1 (a refused create takes no number), E3
 * (concurrent creates in one team), E5–E7 (label adds and removes from several clients).
 *
 * The simulation hands the server one request at a time, so its creates commit one after
 * another; the last test sends creates over HTTP at once, so Postgres runs them concurrently and
 * the counter row's lock orders them.
 */
import fc from 'fast-check';
import { createDatabaseFrom, startTestServer, type TestServer } from '@surface/server/testing';
import { describe, expect, inject, it } from 'vitest';
import { simParameters } from '../src/context.js';
import { checkNumbering, issueConvergence } from '../src/properties.js';
import type { RealServer } from '../src/real-server.js';
import { startRealServer } from '../src/real-server.js';
import type { SimServer } from '../src/server.js';
import { simulate } from '../src/simulate.js';
import type { Case } from '../src/steps.js';
import { issueCase } from '../src/steps.js';

/** A real server for `simulate`, with the labels and the second team the issue steps name. */
function issueServers() {
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
 * Three tabs create at once, one of them offline for a while, with refused creates between
 * accepted ones; then two clients each add a Size label to an issue that has the other one.
 */
const example: Case = {
  seed: 5,
  users: 3,
  lateUsers: 0,
  webLocks: true,
  steps: [
    { t: 'offline', tab: 2, ms: 4_000 },
    { t: 'issueCreate', tab: 0, title: 'Alpha', status: 'default', labels: ['Flaky'] },
    { t: 'issueCreate', tab: 1, title: 'Beta', status: 'Triage', labels: [] },
    { t: 'issueCreate', tab: 2, title: 'Gamma', status: 'Todo', labels: ['Size/Small'] },
    { t: 'issueCreate', tab: 1, title: 'Delta', status: 'other', labels: [] },
    { t: 'issueCreate', tab: 0, title: 'Épsilon', status: 'In Progress', labels: ['Nope'] },
    {
      t: 'issueCreate',
      tab: 1,
      title: '日本',
      status: 'Done',
      labels: ['Size/Small', 'Size/Large#id', 'Frontend'],
    },
    { t: 'issueCreate', tab: 2, title: 'Alpha', status: 'default', labels: ['Size'] },
    { t: 'wait', ms: 5_000 },
    {
      t: 'issueUpdate',
      tab: 0,
      issue: 1, // Gamma: the tab shows Alpha, Gamma and 日本
      status: 'keep',
      addLabels: ['Size/Large'],
      removeLabels: [],
    },
    {
      t: 'issueUpdate',
      tab: 1,
      issue: 2, // 日本
      status: 'Done',
      addLabels: ['Size/Small'],
      removeLabels: ['Frontend'],
    },
    { t: 'wait', ms: 2_000 },
  ],
};

describe('issues against the real server', () => {
  it('numbers the accepted creates 1, 2, 3, takes no number for a refused one, and replaces exclusive labels (E1, E5)', async () => {
    const servers = issueServers();
    const result = await simulate(
      example,
      { ...issueConvergence.options, server: servers.server },
      async (outcome) => {
        await issueConvergence.check(outcome);
        const issues = (await servers.last()?.issues()) ?? {};
        return {
          created: outcome.world.dispatched
            .filter((d) => d.op === 'issue.create')
            .map((d) => d.outcome?.status),
          numbers: Object.values(issues)
            .map((i) => i.number)
            .sort(),
          titles: Object.values(issues)
            .map((i) => i.title)
            .sort(),
          labels: Object.fromEntries(
            Object.values(issues).map((i) => [String(i.title), i.labelIds]),
          ),
          fixtures: servers.last()?.issueFixtures?.labels ?? {},
        };
      },
    );
    expect(result.created).toEqual([
      'confirmed',
      'rejected', // Triage
      'confirmed',
      'rejected', // another team's status
      'rejected', // an unknown label
      'confirmed',
      'rejected', // a label group
    ]);
    expect(result.numbers).toEqual([1, 2, 3]);
    expect(result.titles).toEqual(['Alpha', 'Gamma', '日本']);
    // Adding one label of the exclusive group replaces the other (E5–E7, D20).
    const id = (ref: string) => result.fixtures[ref];
    expect(result.labels).toEqual({
      Alpha: [id('Flaky')],
      Gamma: [id('Size/Large')],
      日本: [id('Size/Small')],
    });
  });

  it('every tab converges on the issues, and numbering and labels hold, after any faults (AC-2, AC-4)', async () => {
    const { server } = issueServers();
    await fc.assert(
      fc.asyncProperty(issueCase({ bursts: true }), (simCase) =>
        simulate(simCase, { ...issueConvergence.options, server }, issueConvergence.check),
      ),
      simParameters(),
    );
  });
});

describe('concurrent creates over HTTP (E3)', () => {
  /** A create of each kind: accepted, or refused by the server inside its transaction. */
  const kinds = fc.array(fc.constantFrom('ok', 'ok', 'ok', 'triage', 'unknown-label'), {
    minLength: 2,
    maxLength: 24,
  });

  it('gives gap-free numbers in commit order and distinct, falling sort keys', async () => {
    await fc.assert(
      fc.asyncProperty(kinds, async (batch) => {
        const database = await createDatabaseFrom(inject('pgAdminUrl'), inject('pgTemplateDb'));
        let entry: TestServer | undefined;
        try {
          entry = await startTestServer({ databaseUrl: database.url, users: 3 });
          const server = entry;
          const results = await Promise.all(
            batch.map((kind, n) => {
              const user = server.users[n % server.users.length];
              if (user === undefined) throw new Error('no user');
              return server.run(user, 'issue.create', {
                team: 'SIM',
                title: `Issue ${n}`,
                ...(kind === 'triage' ? { status: 'Triage' } : {}),
                ...(kind === 'unknown-label' ? { labels: ['Nope'] } : {}),
              });
            }),
          );
          batch.forEach((kind, n) => {
            expect(results[n]?.ok, `${kind} ${n}`).toBe(kind === 'ok');
          });
          const rows = await server.issues();
          expect(rows).toHaveLength(batch.filter((k) => k === 'ok').length);
          checkNumbering(
            rows.map((r) => ({
              id: r.id,
              teamId: r.teamId,
              number: r.number,
              labelIds: r.labelIds,
              sortOrder: r.sortOrder,
              insertedAt: r.insertedAt,
            })),
          );
        } finally {
          await entry?.stop();
          await database.drop();
        }
      }),
      { seed: inject('simSeed'), numRuns: 5 },
    );
  });
});
