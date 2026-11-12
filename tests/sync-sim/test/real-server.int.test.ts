/**
 * The sync simulation against the real server (PLAN-002 S9 part 2, ADR-0016):
 * the same properties as the fake hub's suite (SPEC-002 AC-2, AC-3), with the
 * executor, the repo layer, `sync_log`, `client_mutations`, the hub and
 * Postgres behind the simulated network, one fresh database per case. Bursts
 * run a tab past the rate limit, so a batch stops at a 429 mid-way. Part of
 * the sync property suite, which the testing hold exempts.
 */
import fc from 'fast-check';
import { describe, expect, inject, it } from 'vitest';
import { simParameters } from '../src/context.js';
import { archiveConvergence, convergence, exactlyOnce } from '../src/properties.js';
import { SERVER_CODE, seedGlobals, seededRandom } from '../src/random.js';
import type { RealServer } from '../src/real-server.js';
import { startRealServer } from '../src/real-server.js';
import type { SimServer } from '../src/server.js';
import type { Outcome } from '../src/simulate.js';
import { simulate } from '../src/simulate.js';
import type { Case } from '../src/steps.js';
import { archiveCase, convergenceCase, exactlyOnceCase, itemId } from '../src/steps.js';

/** A factory for `simulate` that remembers the last server it started (and only that one). */
function realServers() {
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

/** Rows seeded as `Item n`: renaming one to that title changes nothing. */
const examples: Case = {
  seed: 7,
  users: 3,
  lateUsers: 0,
  webLocks: true,
  steps: [
    { t: 'wait', ms: 1_000 },
    { t: 'rename', tab: 0, item: 0, title: 'Item 0' },
    { t: 'burst', tab: 1, item: 1, count: 130 },
    { t: 'rename', tab: 2, item: 2, title: 'Gamma' },
    { t: 'wait', ms: 1_000 },
  ],
};

const [sampled] = fc.sample(convergenceCase({ bursts: true }), { seed: 42, numRuns: 1 });
if (sampled === undefined) throw new Error('fast-check sampled no case.');

/** Lease mode, so a reloaded tab's queue is adopted by renewal (E5). */
const faulty: Case = {
  seed: 11,
  users: 3,
  lateUsers: 1,
  webLocks: false,
  steps: [
    { t: 'touch', tab: 0, item: 0 },
    {
      t: 'faults',
      faults: { dropRequest: 0.1, dropResponse: 0.1, hangResponse: 0.05, maxDelayMs: 500 },
    },
    { t: 'burst', tab: 1, item: 1, count: 125 },
    { t: 'restart', downMs: 3_000 },
    { t: 'rename', tab: 0, item: 2, title: 'Alpha' },
    { t: 'compact' },
    { t: 'open', user: 2 },
    { t: 'wait', ms: 20_000 },
    { t: 'reload', tab: 1 },
    { t: 'disconnect', tab: 0 },
    { t: 'restart', downMs: 0 },
    { t: 'touch', tab: 2, item: 1 },
    { t: 'wait', ms: 5_000 },
  ],
};

describe('against the real server', () => {
  it("never draws from the case's seeded randomness, so its connections cannot shift a run", async () => {
    // Each new Postgres connection makes a SCRAM nonce (pg's `startSession`), and how many the
    // pools open depends on real timing. Drawn from the seeded stream, one more under load
    // shifted every later draw: a reloaded tab got another client id (E's flake, 2026-11-12).
    const seeded = seededRandom(1);
    let draws = 0;
    const restore = seedGlobals(
      () => {
        draws += 1;
        return seeded();
      },
      { realFor: SERVER_CODE },
    );
    try {
      // Starts the server, opens its pools and signs two users in.
      const server = await startRealServer({
        adminUrl: inject('pgAdminUrl'),
        template: inject('pgTemplateDb'),
        users: 2,
      });
      await server.dispose();
    } finally {
      restore();
    }
    expect(draws).toBe(0);
  });

  it('confirms a no-op change and a burst cut short by the rate limit', async () => {
    const servers = realServers();
    const result = await simulate(
      examples,
      { ...convergence.options, server: servers.server },
      (outcome) => {
        convergence.check(outcome);
        return {
          items: outcome.server.items,
          outcomes: outcome.world.dispatched.map((d) => [d.op, d.outcome?.status]),
        };
      },
    );
    // Over 120 mutations a minute: a batch was refused after part of it committed,
    // and the committed part was replayed when the client resent it (SPEC-002 Q12).
    expect(servers.last()?.refusedMidBatch ?? 0).toBeGreaterThan(0);
    expect(result.outcomes).toHaveLength(132);
    expect(result.outcomes.every(([, status]) => status === 'confirmed')).toBe(true);
    expect(result.items[itemId(0)]?.title).toBe('Item 0');
    expect(result.items[itemId(1)]?.counter).toBe(130);
    expect(result.items[itemId(2)]?.title).toBe('Gamma');
  });

  it('every tab converges on the server state after any faults (AC-2)', async () => {
    const { server } = realServers();
    await fc.assert(
      fc.asyncProperty(convergenceCase({ bursts: true }), (simCase) =>
        simulate(simCase, { ...convergence.options, server }, convergence.check),
      ),
      simParameters(),
    );
  });

  // PLAN-011 S2 (SPEC-011 AC-18): the repo's A and V rows, through the real delta writer.
  it('archive, unarchive, edits and deletes in any interleaving equal a fresh bootstrap (AC-18)', async () => {
    const { server } = realServers();
    await fc.assert(
      fc.asyncProperty(archiveCase({ bursts: true }), (simCase) =>
        simulate(simCase, { ...archiveConvergence.options, server }, archiveConvergence.check),
      ),
      simParameters(),
    );
  });

  it('applies every saved mutation exactly once across crashes and resends (AC-3)', async () => {
    const { server } = realServers();
    await fc.assert(
      fc.asyncProperty(exactlyOnceCase({ bursts: true }), (simCase) =>
        simulate(simCase, { ...exactlyOnce.options, server }, exactlyOnce.check),
      ),
      simParameters(),
    );
  });

  /**
   * Exact replay rests on the server answering one thing at a time and on
   * unprompted frames (pings) arriving within a few real turns. A sampled
   * case, and one built to hit restarts, compaction, a burst and lease-mode
   * adoption, each run twice.
   */
  it.each([
    ['a sampled case', sampled],
    ['restarts, a compaction, a burst and a reload', faulty],
  ])('replays %s exactly from its seed, so a failing seed can be debugged', async (_, simCase) => {
    const servers = realServers();
    const run = () =>
      simulate(simCase, { ...convergence.options, server: servers.server }, (outcome: Outcome) => ({
        elapsedMs: outcome.elapsedMs,
        server: outcome.server,
        dispatched: outcome.world.dispatched.map((d) => [d.tab, d.op, d.key, d.outcome?.status]),
        saved: [...outcome.world.saved.keys()],
        tabs: outcome.world.tabs.map((t) => [t.name, t.alive, t.store.clientId]),
        statuses: [...(servers.last()?.statuses ?? [])].sort(([a], [b]) => a - b),
        problems: outcome.world.problems,
      }));
    const first = await run();
    expect(first.problems).toEqual([]);
    expect(await run()).toEqual(first);
  });
});
