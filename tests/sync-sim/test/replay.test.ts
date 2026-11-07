/**
 * `pnpm sim --seed <n>` is only useful if a case replays exactly: the same
 * case must produce the same run, down to every tab's queue id and the
 * virtual time it settles at. Sampled cases from both properties, plus a
 * lease-mode one with reloads and a crash between storage writes.
 */
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { simulate } from '../src/simulate.js';
import type { Case } from '../src/steps.js';
import { convergenceCase, exactlyOnceCase } from '../src/steps.js';

const reclaiming: Case = {
  seed: 99,
  users: 3,
  lateUsers: 1,
  webLocks: false,
  steps: [
    { t: 'touch', tab: 0, item: 0 },
    { t: 'reload', tab: 0 },
    {
      t: 'faults',
      faults: { dropRequest: 0.3, dropResponse: 0.3, hangResponse: 0.2, maxDelayMs: 500 },
    },
    { t: 'touch', tab: 1, item: 1 },
    { t: 'crashMidway', tab: 1, calls: 2 },
    { t: 'touch', tab: 1, item: 1 },
    { t: 'wait', ms: 20_000 },
    { t: 'reload', tab: 2 },
    { t: 'compact' },
    { t: 'open', user: 1 },
    { t: 'open', user: 2 },
    { t: 'touch', tab: 3, item: 2 },
  ],
};

const cases: Case[] = [
  reclaiming,
  ...fc.sample(convergenceCase(), { seed: 42, numRuns: 4 }),
  ...fc.sample(exactlyOnceCase(), { seed: 43, numRuns: 4 }),
];

it.each(cases.map((c, i) => [i, c] as const))(
  'replays case %i exactly from its seed',
  async (_, simCase) => {
    const run = () =>
      simulate(simCase, { seedItems: () => [0, 1, 2] }, ({ world, elapsedMs }) => ({
        elapsedMs,
        head: world.server.head(),
        items: world.server.items(),
        dispatched: world.dispatched.map((d) => [d.tab, d.op, d.key, d.outcome?.status]),
        saved: [...world.saved.keys()],
        tabs: world.tabs.map((t) => [t.name, t.alive, t.store.clientId]),
        // The engine's own draws (lease tokens, the fresh id after a claim,
        // backoff jitter) rarely show in the state above, so draw from each
        // global it uses: one left unseeded differs between runs (review M1).
        draws: [
          Math.random(),
          crypto.getRandomValues(new Uint8Array(8)).join(),
          crypto.randomUUID(),
        ],
      }));
    const first = await run();
    expect(await run()).toEqual(first);
  },
);
