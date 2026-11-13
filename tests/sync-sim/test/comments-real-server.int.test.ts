/**
 * PLAN-013 S3, the sync property suite for comments (not held, plans README §6), against the real
 * server: SPEC-013 AC-5 for comments (replies, edits, deletes, resolves and reopens from several
 * clients, in any interleaving, converge to the server's state and keep §4.3's rules: no orphan
 * placeholder, no reply under a hard-deleted comment), E2 (a reply racing a delete), E3 (two edits
 * from one base) and E13 (the last replies deleted from two clients).
 *
 * The plan names `comments.prop.test.ts`; the fake hub runs no operation handlers, so the suite
 * runs on the real server, like the issue suite. Reactions join in PLAN-013 S4.
 */
import fc from 'fast-check';
import { describe, expect, inject, it } from 'vitest';
import { simParameters } from '../src/context.js';
import { commentConvergence } from '../src/properties.js';
import type { RealServer } from '../src/real-server.js';
import { startRealServer } from '../src/real-server.js';
import type { SimServer } from '../src/server.js';
import { simulate } from '../src/simulate.js';
import type { Case, Step } from '../src/steps.js';
import { commentCase } from '../src/steps.js';

function commentServers() {
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

const issues: Step[] = [
  { t: 'issueCreate', tab: 0, title: 'Alpha', status: 'default', labels: [] },
  { t: 'wait', ms: 3_000 },
];

/**
 * Tab 0 (user 0) starts a thread and tab 1 (user 1) replies. Then, with tab 1 offline, tab 0
 * deletes its comment (soft: a reply is left); tab 1, offline, edits its reply twice and replies
 * to the thread again. Back online, its second edit carries the version the first raised (E22)
 * and its queued reply goes to a placeholder, so it is refused (E2). Tab 0 resolves the
 * placeholder's thread through the reply, then tab 1 deletes its reply: the placeholder goes with
 * it (§4.3), and nothing is left.
 */
const example: Case = {
  seed: 11,
  users: 2,
  lateUsers: 0,
  webLocks: true,
  steps: [
    ...issues,
    { t: 'commentCreate', tab: 0, issue: 0, text: 'LGTM' },
    { t: 'wait', ms: 2_000 },
    { t: 'commentCreate', tab: 1, issue: 0, parent: 0, text: 'Repro on **Safari**' },
    { t: 'wait', ms: 2_000 },
    { t: 'offline', tab: 1, ms: 5_000 },
    { t: 'commentDelete', tab: 0, comment: 0 },
    { t: 'commentEdit', tab: 1, comment: 1, text: '日本語' },
    { t: 'commentEdit', tab: 1, comment: 1, text: 'Done ✅' },
    { t: 'commentCreate', tab: 1, issue: 0, parent: 0, text: 'LGTM' },
    { t: 'wait', ms: 8_000 },
    { t: 'commentResolve', tab: 0, comment: 1 },
    { t: 'wait', ms: 2_000 },
    { t: 'commentDelete', tab: 1, comment: 1 },
    { t: 'wait', ms: 2_000 },
  ],
};

describe('comments against the real server', () => {
  it('orders a reply after a delete, chains queued edits, and removes the placeholder with its last reply (E2, E22)', async () => {
    const servers = commentServers();
    const result = await simulate(
      example,
      { ...commentConvergence.options, server: servers.server },
      async (outcome) => {
        await commentConvergence.check(outcome);
        return {
          outcomes: outcome.world.dispatched
            .filter((d) => d.op.startsWith('comment.'))
            .map((d) => `${d.op} ${String(d.outcome?.status)}`),
          stored: Object.keys((await servers.last()?.comments()) ?? {}).length,
        };
      },
    );
    expect(result.outcomes).toEqual([
      'comment.create confirmed',
      'comment.create confirmed',
      'comment.delete confirmed',
      'comment.update confirmed',
      'comment.update confirmed',
      // A reply to the placeholder: refused (E2).
      'comment.create rejected',
      'comment.resolve confirmed',
      'comment.delete confirmed',
    ]);
    expect(result.stored).toBe(0);
  });

  it('every tab converges on the comments, and threads keep §4.3’s rules, after any faults (AC-5)', async () => {
    const { server } = commentServers();
    // What the runs did, so a generator that stops reaching the server fails here, not silently.
    const confirmed = new Map<string, number>();
    await fc.assert(
      fc.asyncProperty(commentCase(), (simCase) =>
        simulate(simCase, { ...commentConvergence.options, server }, async (outcome) => {
          await commentConvergence.check(outcome);
          for (const d of outcome.world.dispatched) {
            if (d.op.startsWith('comment.') && d.outcome?.status === 'confirmed') {
              confirmed.set(d.op, (confirmed.get(d.op) ?? 0) + 1);
            }
          }
        }),
      ),
      simParameters(),
    );
    for (const op of ['comment.create', 'comment.update', 'comment.delete', 'comment.resolve']) {
      expect(confirmed.get(op) ?? 0, op).toBeGreaterThan(0);
    }
  });
});
