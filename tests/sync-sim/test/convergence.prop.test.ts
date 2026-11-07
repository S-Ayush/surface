/**
 * Property 1, convergence (SPEC-002 AC-2): 3–6 tabs of 3–4 users create,
 * rename, touch and delete colliding items while the network delays, drops,
 * reorders and disconnects, abandoned requests arrive late, the server
 * restarts and tabs crash (also between storage writes) or reload. Once the
 * faults stop and every tab has settled, each tab shows exactly the server's
 * rows and has nothing pending (so its overlay is empty). One more tab per
 * user then warm-starts from the saved replica and must agree too, and no
 * store reports an error.
 */
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { simParameters } from '../src/context.js';
import { simulate } from '../src/simulate.js';
import { convergenceCase } from '../src/steps.js';

it('every tab converges on the server state after any faults (AC-2)', async () => {
  await fc.assert(
    fc.asyncProperty(convergenceCase(), (simCase) =>
      simulate(simCase, { seedItems: () => [0, 1, 2] }, ({ world }) => {
        expect(world.problems).toEqual([]);
        const server = world.server.items();
        for (const tab of world.live) {
          expect(tab.store.pending, tab.name).toEqual([]);
          expect(world.view(tab), tab.name).toEqual(server);
        }
      }),
    ),
    simParameters(),
  );
});
