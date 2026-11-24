/**
 * PLAN-015 S2, the sync property suite for the issue lifecycle (not held, plans README §6), against
 * the real server: SPEC-015 AC-13 (delete, restore and purge from several clients, in any
 * interleaving with comments, reactions and faults, leave every replica holding exactly the
 * server's live issues and no content of a gone one, equal to a fresh bootstrap), E3 (delete and
 * restore of one issue from two tabs), E15/E16 (comments racing a delete or a purge, in the
 * generated runs) and AC-10's purge part (a Member's purge is refused).
 *
 * The plan names `lifecycle.prop.test.ts`; the fake hub runs no operation handlers, so the suite
 * runs on the real server, like the comment suite. PLAN-015 S3 adds `issueAutoArchive`: the system
 * actor archives an aged issue (a restore brings it back), in the generated runs and the example
 * at the bottom.
 */
import fc from 'fast-check';
import { describe, expect, inject, it } from 'vitest';
import { simParameters } from '../src/context.js';
import { lifecycleConvergence } from '../src/properties.js';
import type { RealServer } from '../src/real-server.js';
import { startRealServer } from '../src/real-server.js';
import type { SimServer } from '../src/server.js';
import { simulate } from '../src/simulate.js';
import type { Case } from '../src/steps.js';
import { lifecycleCase, UPLOADS_PER_USER } from '../src/steps.js';

function lifecycleServers() {
  let latest: RealServer | undefined;
  const server = async (users: number): Promise<SimServer> => {
    latest = await startRealServer({
      adminUrl: inject('pgAdminUrl'),
      template: inject('pgTemplateDb'),
      users,
    });
    await latest.seedIssueFixtures();
    // PLAN-014 S4a: uploads for the attachment steps.
    await latest.seedUploads(UPLOADS_PER_USER);
    return latest;
  };
  return { server, last: () => latest };
}

/**
 * Two issues with a comment each, and a reaction on Beta's. Tab 1 (a Member) deletes Alpha and tab
 * 2 restores it (E3); tab 0 (the Admin) deletes Beta and a Member tries to purge it (FORBIDDEN);
 * then tab 1 comments on Alpha while the Admin purges Beta, with its comment and reaction.
 */
const example: Case = {
  seed: 7,
  users: 3,
  lateUsers: 0,
  webLocks: true,
  steps: [
    { t: 'issueCreate', tab: 0, title: 'Alpha', status: 'default', labels: [] },
    { t: 'issueCreate', tab: 1, title: 'Beta', status: 'default', labels: [] },
    { t: 'wait', ms: 3_000 },
    { t: 'commentCreate', tab: 0, issue: 0, text: 'LGTM' },
    { t: 'commentCreate', tab: 1, issue: 1, text: 'Done ✅' },
    { t: 'wait', ms: 2_000 },
    { t: 'reactionSet', tab: 2, on: 'comment', target: 1, emoji: 0, reacted: true },
    { t: 'wait', ms: 2_000 },
    { t: 'issueDelete', tab: 1, issue: 0 },
    { t: 'wait', ms: 2_000 },
    { t: 'issueRestore', tab: 2, issue: 0 },
    { t: 'wait', ms: 2_000 },
    { t: 'issueDelete', tab: 0, issue: 1 },
    { t: 'wait', ms: 2_000 },
    { t: 'issuePurge', tab: 1, issue: 1, admin: false },
    { t: 'wait', ms: 2_000 },
    { t: 'commentCreate', tab: 1, issue: 0, text: 'Still here' },
    { t: 'issuePurge', tab: 0, issue: 1, admin: true },
    { t: 'wait', ms: 3_000 },
  ],
};

describe('the issue lifecycle against the real server', () => {
  it('deletes and restores from two tabs, refuses a Member’s purge, and purges with the content (E3)', async () => {
    const servers = lifecycleServers();
    const result = await simulate(
      example,
      { ...lifecycleConvergence.options, server: servers.server },
      async (outcome) => {
        await lifecycleConvergence.check(outcome);
        const server = servers.last();
        return {
          outcomes: outcome.world.dispatched
            .filter((d) => d.op.startsWith('issue.') && d.op !== 'issue.create')
            .map((d) => `${d.op} ${String(d.outcome?.status)}`),
          issues: Object.keys((await server?.issues()) ?? {}).length,
          comments: Object.keys((await server?.comments()) ?? {}).length,
          reactions: Object.keys((await server?.reactions()) ?? {}).length,
        };
      },
    );
    expect(result.outcomes).toEqual([
      'issue.delete confirmed',
      'issue.restore confirmed',
      'issue.delete confirmed',
      // Tab 1 is a Member's: Admin only (§5.3).
      'issue.purge rejected',
      'issue.purge confirmed',
    ]);
    // Beta is gone with its comment and the reaction on it; Alpha keeps its two comments.
    expect(result).toMatchObject({ issues: 1, comments: 2, reactions: 0 });
  });

  it('every tab holds exactly the live issues, equal to a fresh bootstrap, after any interleaving (AC-13)', async () => {
    const { server } = lifecycleServers();
    // What the runs did, so a generator that stops reaching the server fails here, not silently.
    const confirmed = new Map<string, number>();
    await fc.assert(
      fc.asyncProperty(lifecycleCase(), (simCase) =>
        simulate(simCase, { ...lifecycleConvergence.options, server }, async (outcome) => {
          await lifecycleConvergence.check(outcome);
          for (const d of outcome.world.dispatched) {
            if (d.outcome?.status === 'confirmed') {
              confirmed.set(d.op, (confirmed.get(d.op) ?? 0) + 1);
            }
          }
        }),
      ),
      simParameters(),
    );
    for (const op of ['issue.delete', 'issue.restore', 'issue.purge']) {
      expect(confirmed.get(op) ?? 0, op).toBeGreaterThan(0);
    }
  });
});

/**
 * Auto-archive, then restore (PLAN-015 S3, AC-13): Alpha is aged and archived by the system actor
 * while Beta stays live; every tab drops Alpha at the `A`, and the restore from another tab brings
 * it back equal to a fresh bootstrap (the property's last check).
 */
const archiveExample: Case = {
  seed: 11,
  users: 2,
  lateUsers: 0,
  webLocks: true,
  steps: [
    { t: 'issueCreate', tab: 0, title: 'Alpha', status: 'default', labels: [] },
    { t: 'issueCreate', tab: 1, title: 'Beta', status: 'default', labels: [] },
    { t: 'wait', ms: 3_000 },
    { t: 'commentCreate', tab: 0, issue: 0, text: 'Before the archive' },
    { t: 'wait', ms: 2_000 },
    { t: 'issueAutoArchive', issue: 0 },
    { t: 'wait', ms: 3_000 },
    { t: 'issueRestore', tab: 1, issue: 0 },
    { t: 'wait', ms: 3_000 },
  ],
};

describe('auto-archive against the real server (AC-13)', () => {
  it('archives an aged issue for every tab and brings it back on restore, equal to a fresh bootstrap', async () => {
    const servers = lifecycleServers();
    const result = await simulate(
      archiveExample,
      { ...lifecycleConvergence.options, server: servers.server },
      async (outcome) => {
        await lifecycleConvergence.check(outcome);
        const server = servers.last();
        const lifecycles = Object.values((await server?.issueLifecycles()) ?? {});
        return {
          archivedEvents: ((await server?.events('issue.archived')) ?? []).length,
          restores: outcome.world.dispatched
            .filter((d) => d.op === 'issue.restore')
            .map((d) => d.outcome?.status),
          live: lifecycles.filter((s) => s.archivedAt === null && s.deletedAt === null).length,
        };
      },
    );
    // One `issue.archived` event, and both issues live again after the restore.
    expect(result).toEqual({ archivedEvents: 1, restores: ['confirmed'], live: 2 });
  });

  it('the generated runs archive at least once', async () => {
    const { server, last } = lifecycleServers();
    let archived = 0;
    await fc.assert(
      fc.asyncProperty(lifecycleCase(), (simCase) =>
        simulate(simCase, { ...lifecycleConvergence.options, server }, async (outcome) => {
          await lifecycleConvergence.check(outcome);
          archived += ((await last()?.events('issue.archived')) ?? []).length;
        }),
      ),
      simParameters(),
    );
    expect(archived).toBeGreaterThan(0);
  });
});

/**
 * SPEC-011 D14 in a restart race: tab 2 creates Beta, the Admin deletes it and tab 2 restores it,
 * so tab 2 holds Beta without its content. Then the server restarts and tab 2 comments on Beta:
 * the load fails while the tab still believes it is online (the socket's close hasn't arrived),
 * so the comment is refused with "Couldn't load SIM-1. Try again." before it is queued, and every
 * replica still converges. Seed 2 is one whose delays put the failed fetch before the close.
 */
const restartRefusalExample: Case = {
  seed: 2,
  users: 2,
  lateUsers: 0,
  webLocks: false,
  steps: [
    { t: 'issueCreate', tab: 1, title: 'Beta', status: 'default', labels: [] },
    { t: 'wait', ms: 3_000 },
    { t: 'issueDelete', tab: 0, issue: 0 },
    { t: 'wait', ms: 3_000 },
    { t: 'issueRestore', tab: 1, issue: 0 },
    { t: 'wait', ms: 3_000 },
    { t: 'restart', downMs: 5_000 },
    { t: 'commentCreate', tab: 1, issue: 0, text: 'During the restart' },
    { t: 'wait', ms: 8_000 },
  ],
};

/**
 * The generated case that found the race (seed 20261107, path "11", minimised by hand to 12
 * steps): a comment right after a restart, on an issue the reloaded tab hasn't loaded.
 */
const restartRefusalFound: Case = {
  seed: 15,
  users: 3,
  lateUsers: 0,
  webLocks: false,
  steps: [
    { t: 'issueCreate', tab: 1, title: 'Beta', status: 'default', labels: [] },
    { t: 'wait', ms: 4015 },
    { t: 'issueDelete', tab: 717, issue: 113 },
    { t: 'wait', ms: 2657 },
    { t: 'issuePurge', tab: 365, issue: 579, admin: false },
    { t: 'issueRestore', tab: 277, issue: 526 },
    { t: 'reload', tab: 195 },
    { t: 'commentCreate', tab: 503, issue: 203, parent: 623, text: 'Repro on **Safari**' },
    { t: 'wait', ms: 2958 },
    { t: 'restart', downMs: 10744 },
    { t: 'commentCreate', tab: 639, issue: 632, text: 'Done ✅' },
    { t: 'wait', ms: 3471 },
  ],
};

describe('a content load that fails in a restart (SPEC-011 D14)', () => {
  it('refuses a comment on an unloaded issue when the server restarts, and still converges', async () => {
    const servers = lifecycleServers();
    const refusals = await simulate(
      restartRefusalExample,
      { ...lifecycleConvergence.options, server: servers.server },
      async (outcome) => {
        await lifecycleConvergence.check(outcome);
        return outcome.world.contentLoadRefusals;
      },
    );
    expect(refusals).toEqual(['user-2/tab-2: comment.create']);
  });

  it('converges in the generated case that found the race', async () => {
    const servers = lifecycleServers();
    const refusals = await simulate(
      restartRefusalFound,
      { ...lifecycleConvergence.options, server: servers.server },
      async (outcome) => {
        await lifecycleConvergence.check(outcome);
        return outcome.world.contentLoadRefusals;
      },
    );
    expect(refusals).toEqual(['user-2/tab-2: comment.create']);
  });
});
