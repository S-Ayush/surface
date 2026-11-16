/**
 * PLAN-015 S2, the sync property suite for the issue lifecycle (not held, plans README §6), against
 * the real server: SPEC-015 AC-13 (delete, restore and purge from several clients, in any
 * interleaving with comments, reactions and faults, leave every replica holding exactly the
 * server's live issues and no content of a gone one, equal to a fresh bootstrap), E3 (delete and
 * restore of one issue from two tabs), E15/E16 (comments racing a delete or a purge, in the
 * generated runs) and AC-10's purge part (a Member's purge is refused).
 *
 * The plan names `lifecycle.prop.test.ts`; the fake hub runs no operation handlers, so the suite
 * runs on the real server, like the comment suite. Auto-archive joins in PLAN-015 S3.
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
import { lifecycleCase } from '../src/steps.js';

function lifecycleServers() {
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
