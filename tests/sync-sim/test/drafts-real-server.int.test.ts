/**
 * PLAN-012 S5, the sync property suite for drafts (not held, plans README §6), against the real
 * server: concurrent `draft.save` and `draft.discard` from several tabs and users converge
 * (SPEC-012 AC-3, E13, E19), each user's replica holds exactly that user's drafts (rule 4), and a
 * key never holds two drafts.
 */
import fc from 'fast-check';
import { describe, expect, inject, it } from 'vitest';
import { simParameters } from '../src/context.js';
import { draftConvergence } from '../src/properties.js';
import { startRealServer, type RealServer } from '../src/real-server.js';
import type { SimServer } from '../src/server.js';
import { simulate } from '../src/simulate.js';
import { draftCase, type Case } from '../src/steps.js';

function draftServers() {
  let latest: RealServer | undefined;
  const server = async (users: number): Promise<SimServer> => {
    latest = await startRealServer({
      adminUrl: inject('pgAdminUrl'),
      template: inject('pgTemplateDb'),
      users,
    });
    return latest;
  };
  return { server, last: () => latest };
}

/**
 * Two users save the same keys; a second tab of the first user saves over the first tab's draft
 * while offline, so its save commits last (E13), and a discard races a save of another key.
 */
const example: Case = {
  seed: 11,
  users: 2,
  lateUsers: 0,
  webLocks: true,
  steps: [
    { t: 'open', user: 0 },
    { t: 'wait', ms: 1_000 },
    { t: 'draftSave', tab: 0, key: 0, title: 'Alpha' },
    { t: 'draftSave', tab: 1, key: 0, title: 'Beta' },
    { t: 'offline', tab: 2, ms: 3_000 },
    { t: 'draftSave', tab: 2, key: 0, title: 'Gamma' },
    { t: 'draftSave', tab: 0, key: 2, title: 'Delta' },
    { t: 'draftDiscard', tab: 2, key: 2 },
    { t: 'wait', ms: 6_000 },
  ],
};

describe('drafts against the real server', () => {
  it('each user sees only their own drafts, one per key, the last save winning (E13)', async () => {
    const servers = draftServers();
    const result = await simulate(
      example,
      { ...draftConvergence.options, server: servers.server },
      async (outcome) => {
        await draftConvergence.check(outcome);
        const drafts = (await servers.last()?.drafts()) ?? {};
        return {
          saves: outcome.world.dispatched
            .filter((d) => d.op === 'draft.save')
            .map((d) => d.outcome?.status),
          owners: new Set(Object.values(drafts).map((d) => d.userId)).size,
          count: Object.keys(drafts).length,
        };
      },
    );
    expect(result.saves.every((s) => s === 'confirmed')).toBe(true);
    // One composer draft per user for key 0; the comment draft was saved and then discarded or
    // saved after the discard, depending on the commit order: at most one.
    expect(result.owners).toBe(2);
    expect(result.count).toBeGreaterThanOrEqual(2);
    expect(result.count).toBeLessThanOrEqual(3);
  });

  it('every tab converges on its user’s drafts after any faults (AC-3, E13, E19)', async () => {
    const { server } = draftServers();
    await fc.assert(
      fc.asyncProperty(draftCase(), (simCase) =>
        simulate(simCase, { ...draftConvergence.options, server }, draftConvergence.check),
      ),
      simParameters(),
    );
  });
});
