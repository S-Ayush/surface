/**
 * PLAN-011 S4, the sync property suite for issues (not held, plans README §6), against the real
 * server: SPEC-011 AC-2 (numbers gap-free in commit order, distinct sort keys), AC-4 (label
 * edits converge, the exclusive rule holds), E1 (a refused create takes no number), E3
 * (concurrent creates in one team), E5–E7 (label adds and removes from several clients).
 *
 * The simulation hands the server one request at a time, so its creates commit one after
 * another; the last test sends creates over HTTP at once, so Postgres runs them concurrently and
 * the counter row's lock orders them.
 *
 * PLAN-011 S6 adds descriptions and history (AC-5, AC-6, AC-7, E10): `issueDescribe` steps save a
 * description from the version the tab holds, and `descriptionConvergence` compares every tab's
 * IssueContent and IssueHistory rows with the server's.
 *
 * PLAN-011 S8 adds label cascades (AC-18, AC-20, E22): `label.delete` racing edits that add the
 * label, among deletes, restores and auto-archives (`cascadeCase`, `cascadeConvergence`), and
 * compaction in the generated issue runs (the numbering check no longer reads `sync_log`).
 */
import fc from 'fast-check';
import { createDatabaseFrom, startTestServer, type TestServer } from '@surface/server/testing';
import { describe, expect, inject, it } from 'vitest';
import { simParameters } from '../src/context.js';
import {
  cascadeConvergence,
  checkNumbering,
  descriptionConvergence,
  issueConvergence,
} from '../src/properties.js';
import type { RealServer } from '../src/real-server.js';
import { startRealServer } from '../src/real-server.js';
import type { SimServer } from '../src/server.js';
import { simulate } from '../src/simulate.js';
import type { Case } from '../src/steps.js';
import { cascadeCase, issueCase } from '../src/steps.js';

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

/**
 * Two tabs edit the labels of the same issues while the second is offline, so its edits commit
 * last: on Five, labels of different groups both stay (E5); on Six, two labels of one exclusive
 * group, and the later commit wins (E6).
 */
const sameIssue: Case = {
  seed: 7,
  users: 2,
  lateUsers: 0,
  webLocks: true,
  steps: [
    { t: 'issueCreate', tab: 0, title: 'Five', status: 'default', labels: ['Flaky'] },
    { t: 'issueCreate', tab: 0, title: 'Six', status: 'default', labels: [] },
    { t: 'wait', ms: 2_000 },
    { t: 'offline', tab: 1, ms: 3_000 },
    {
      t: 'issueUpdate',
      tab: 1,
      issue: 0,
      status: 'keep',
      addLabels: ['Size/Small'],
      removeLabels: [],
    },
    {
      t: 'issueUpdate',
      tab: 1,
      issue: 1,
      status: 'keep',
      addLabels: ['Size/Small'],
      removeLabels: [],
    },
    {
      t: 'issueUpdate',
      tab: 0,
      issue: 0,
      status: 'keep',
      addLabels: ['Frontend'],
      removeLabels: [],
    },
    {
      t: 'issueUpdate',
      tab: 0,
      issue: 1,
      status: 'keep',
      addLabels: ['Size/Large'],
      removeLabels: [],
    },
    { t: 'wait', ms: 6_000 },
  ],
};

describe('issues against the real server', () => {
  it('keeps label edits of two offline-separated tabs on one issue, and the later exclusive add wins (E5, E6)', async () => {
    const servers = issueServers();
    const result = await simulate(
      sameIssue,
      { ...issueConvergence.options, server: servers.server },
      async (outcome) => {
        await issueConvergence.check(outcome);
        const issues = (await servers.last()?.issues()) ?? {};
        return {
          updates: outcome.world.dispatched
            .filter((d) => d.op === 'issue.update')
            .map((d) => d.outcome?.status),
          labels: Object.fromEntries(
            Object.values(issues).map((i) => [
              String(i.title),
              Array.isArray(i.labelIds) ? i.labelIds.map(String).sort() : i.labelIds,
            ]),
          ),
          fixtures: servers.last()?.issueFixtures?.labels ?? {},
        };
      },
    );
    expect(result.updates).toEqual(['confirmed', 'confirmed', 'confirmed', 'confirmed']);
    const id = (ref: string) => result.fixtures[ref] ?? ref;
    expect(result.labels).toEqual({
      Five: [id('Flaky'), id('Frontend'), id('Size/Small')].sort(),
      // The offline tab's add commits last, so it replaces the other tab's (D20, E6).
      Six: [id('Size/Small')],
    });
  });

  it('numbers the accepted creates 1, 2, 3, takes no number for a refused one, and replaces exclusive labels (E1, D20)', async () => {
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

/**
 * PLAN-011 S6, E10: both tabs open Alpha (a describe step before the description has loaded only
 * opens the page), the first saves, then the second saves offline from that version while the
 * first saves again: the offline save reaches the server with a passed base and is refused.
 */
const describeRace: Case = {
  seed: 11,
  users: 2,
  lateUsers: 0,
  webLocks: true,
  steps: [
    { t: 'issueCreate', tab: 0, title: 'Alpha', status: 'default', labels: [] },
    { t: 'wait', ms: 3_000 },
    { t: 'issueDescribe', tab: 0, issue: 0, text: 'Steps', stale: false },
    { t: 'issueDescribe', tab: 1, issue: 0, text: 'Steps', stale: false },
    { t: 'wait', ms: 3_000 },
    { t: 'issueDescribe', tab: 0, issue: 0, text: 'Steps', stale: false },
    { t: 'wait', ms: 2_000 },
    { t: 'offline', tab: 1, ms: 4_000 },
    { t: 'issueDescribe', tab: 1, issue: 0, text: 'Repro on **Safari**', stale: false },
    { t: 'issueDescribe', tab: 0, issue: 0, text: '日本語', stale: false },
    { t: 'wait', ms: 8_000 },
  ],
};

describe('descriptions against the real server (PLAN-011 S6)', () => {
  it('refuses a save from a version another tab passed, and every tab shows the stored description (E10, AC-6)', async () => {
    const servers = issueServers();
    const result = await simulate(
      describeRace,
      { ...descriptionConvergence.options, server: servers.server },
      async (outcome) => {
        await descriptionConvergence.check(outcome);
        const contents = (await servers.last()?.issueContents()) ?? {};
        return {
          saves: outcome.world.dispatched
            .filter((d) => d.op === 'issue.updateDescription')
            .map((d) => d.outcome?.status),
          stored: Object.values(contents).map((c) => [c.version, JSON.stringify(c.description)]),
        };
      },
    );
    expect(result.saves).toEqual(['confirmed', 'rejected', 'confirmed']);
    expect(result.stored).toEqual([[3, expect.stringContaining('日本語')]]);
  });

  it('every tab converges on the descriptions and history after any faults (AC-5, AC-7)', async () => {
    const { server } = issueServers();
    await fc.assert(
      fc.asyncProperty(issueCase({ descriptions: true }), (simCase) =>
        simulate(
          simCase,
          { ...descriptionConvergence.options, server },
          descriptionConvergence.check,
        ),
      ),
      simParameters(),
    );
  });
});

describe('concurrent creates over HTTP (E3)', () => {
  /**
   * A create of each kind: accepted, or refused by the server inside its transaction. A
   * `duplicate-id` create reuses the first issue's id, so it fails at the insert, after it took
   * the counter (`newIssuePosition`): its rollback must give the number back (AC-2, E1).
   */
  const kinds = fc.array(
    fc.constantFrom('ok', 'ok', 'ok', 'triage', 'unknown-label', 'duplicate-id'),
    {
      minLength: 2,
      maxLength: 24,
    },
  );

  it('gives gap-free numbers in commit order and distinct, falling sort keys', async () => {
    await fc.assert(
      fc.asyncProperty(kinds, async (batch) => {
        const database = await createDatabaseFrom(inject('pgAdminUrl'), inject('pgTemplateDb'));
        let entry: TestServer | undefined;
        try {
          entry = await startTestServer({ databaseUrl: database.url, users: 3 });
          const server = entry;
          const [ada] = server.users;
          if (ada === undefined) throw new Error('no user');
          const first = '01930000-0000-7000-8000-00000000f157'; // a fresh database each run
          const created = await server.run(ada, 'issue.create', {
            id: first,
            team: 'SIM',
            title: 'First',
          });
          expect(created.ok).toBe(true);
          const results = await Promise.all(
            batch.map((kind, n) => {
              const user = server.users[n % server.users.length];
              if (user === undefined) throw new Error('no user');
              return server.run(user, 'issue.create', {
                ...(kind === 'duplicate-id' ? { id: first } : {}),
                team: 'SIM',
                title: `Issue ${n}`,
                ...(kind === 'triage' ? { status: 'Triage' } : {}),
                ...(kind === 'unknown-label' ? { labels: ['Nope'] } : {}),
              });
            }),
          );
          batch.forEach((kind, n) => {
            expect(results[n]?.ok, `${kind} ${n}`).toBe(kind === 'ok');
            if (kind === 'duplicate-id') {
              expect(results[n], `${kind} ${n}`).toMatchObject({
                ok: false,
                error: { code: 'CONFLICT', message: 'Issue id already exists. Use a new id.' },
              });
            }
          });
          const accepted = batch.filter((k) => k === 'ok').length + 1;
          // A create rolled back after taking the counter gives its number to the next one.
          const again = await server.run(ada, 'issue.create', {
            id: first,
            team: 'SIM',
            title: 'Again',
          });
          expect(again).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
          const next = await server.run(ada, 'issue.create', { team: 'SIM', title: 'Next' });
          expect(next).toMatchObject({ ok: true, result: { identifier: `SIM-${accepted + 1}` } });
          const rows = await server.issues();
          expect(rows).toHaveLength(accepted + 1);
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

/**
 * PLAN-011 S8, E22 and the cascade on archived and deleted issues. Alpha gets Size/Small online,
 * then tab 1, offline, adds Size/Large by id while tab 0 deletes both labels: Size/Small's cascade
 * rewrites Alpha, and tab 1's edit reaches the server after Size/Large is gone and is refused, so
 * Alpha names neither. Then Beta is deleted and Gamma auto-archived, Frontend (on both) is deleted,
 * and both come back with a restore, without it.
 */
const cascadeExample: Case = {
  seed: 13,
  users: 2,
  lateUsers: 0,
  webLocks: true,
  steps: [
    { t: 'issueCreate', tab: 0, title: 'Alpha', status: 'default', labels: [] },
    { t: 'issueCreate', tab: 0, title: 'Beta', status: 'default', labels: ['Frontend'] },
    { t: 'issueCreate', tab: 0, title: 'Gamma', status: 'default', labels: ['Frontend'] },
    { t: 'wait', ms: 3_000 },
    {
      t: 'issueUpdate',
      tab: 0,
      issue: 0,
      status: 'keep',
      addLabels: ['Size/Small'],
      removeLabels: [],
    },
    { t: 'wait', ms: 2_000 },
    { t: 'offline', tab: 1, ms: 4_000 },
    {
      t: 'issueUpdate',
      tab: 1,
      issue: 0,
      status: 'keep',
      addLabels: ['Size/Large#id'],
      removeLabels: [],
    },
    { t: 'labelDelete', tab: 0, label: 'Size/Small' },
    { t: 'labelDelete', tab: 0, label: 'Size/Large' },
    { t: 'wait', ms: 6_000 },
    { t: 'issueDelete', tab: 0, issue: 1 },
    { t: 'issueAutoArchive', issue: 2 },
    { t: 'wait', ms: 3_000 },
    { t: 'labelDelete', tab: 1, label: 'Frontend' },
    { t: 'wait', ms: 3_000 },
    { t: 'issueRestore', tab: 1, issue: 1 },
    { t: 'issueRestore', tab: 0, issue: 2 },
    { t: 'wait', ms: 3_000 },
  ],
};

describe('label cascades against the real server (PLAN-011 S8)', () => {
  it('rewrites an issue that took the label first, refuses an edit that comes after the delete, and reaches archived and deleted issues (E22, AC-18)', async () => {
    const servers = issueServers();
    const result = await simulate(
      cascadeExample,
      { ...cascadeConvergence.options, server: servers.server },
      async (outcome) => {
        await cascadeConvergence.check(outcome);
        const issues = (await servers.last()?.issues()) ?? {};
        return {
          outcomes: outcome.world.dispatched
            .filter((d) => d.op !== 'issue.create')
            .map((d) =>
              d.outcome?.status === 'rejected'
                ? `${d.op} rejected ${d.outcome.error.code}`
                : `${d.op} ${String(d.outcome?.status)}`,
            ),
          labels: Object.fromEntries(
            Object.values(issues).map((i) => [String(i.title), i.labelIds]),
          ),
        };
      },
    );
    // In dispatch order: tab 1's edit is dispatched before the deletes, but sent when the tab
    // comes back online, after Size/Large is gone, so the id no longer resolves (E22).
    expect(result.outcomes).toEqual([
      'issue.update confirmed',
      'issue.update rejected NOT_FOUND',
      'label.delete confirmed',
      'label.delete confirmed',
      'issue.delete confirmed',
      'label.delete confirmed',
      'issue.restore confirmed',
      'issue.restore confirmed',
    ]);
    expect(result.labels).toEqual({ Alpha: [], Beta: [], Gamma: [] });
  });

  it('every tab converges, and no stored issue names a deleted label, after any interleaving of cascades, archives and deletes (AC-18, AC-20)', async () => {
    const { server } = issueServers();
    const confirmed = new Map<string, number>();
    await fc.assert(
      fc.asyncProperty(cascadeCase(), (simCase) =>
        simulate(simCase, { ...cascadeConvergence.options, server }, async (outcome) => {
          await cascadeConvergence.check(outcome);
          for (const d of outcome.world.dispatched) {
            if (d.outcome?.status === 'confirmed') {
              confirmed.set(d.op, (confirmed.get(d.op) ?? 0) + 1);
            }
          }
        }),
      ),
      simParameters(),
    );
    // What the runs did, so a generator that stops reaching the server fails here.
    for (const op of ['label.delete', 'issue.update', 'issue.delete', 'issue.restore']) {
      expect(confirmed.get(op) ?? 0, op).toBeGreaterThan(0);
    }
  });
});
