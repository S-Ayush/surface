/**
 * Property 2, exactly once (SPEC-002 AC-3, E3, E4): each user's tabs touch
 * that user's own item while requests and responses are lost or hang,
 * abandoned requests arrive late, connections drop, the server restarts, and
 * tabs crash (also between storage writes) or reload, their queues adopted
 * (E5). A touch counts once it was saved to the replica, since a mutation is
 * durable only once stored (SPEC-002 §3.3 step 2, AC-3). A crash before that
 * may lose it. Every saved touch is applied by the
 * server exactly once, and none is rejected.
 */
import fc from 'fast-check';
import { expect, it } from 'vitest';
import { simParameters } from '../src/context.js';
import { simulate } from '../src/simulate.js';
import { exactlyOnceCase, itemId } from '../src/steps.js';

it('applies every saved mutation exactly once across crashes and resends (AC-3)', async () => {
  await fc.assert(
    fc.asyncProperty(exactlyOnceCase(), (simCase) =>
      simulate(
        simCase,
        {
          seedItems: (users) => Array.from({ length: users }, (_, n) => n),
          itemFor: (_item, user) => user,
        },
        ({ world }) => {
          expect(world.problems).toEqual([]);
          const dispatched = new Set(world.dispatched.map((d) => d.key));
          const saved = [...world.saved].filter(([, { op }]) => op === 'debug.touch');
          // Only dispatches are saved, and a tab that never crashed loses none.
          for (const [key] of saved) expect(dispatched, key).toContain(key);
          const kept = new Set(saved.map(([key]) => key));
          const survivors = new Set(world.live.map((tab) => tab.name));
          for (const d of world.dispatched) {
            if (survivors.has(d.tab)) expect(kept, `${d.tab} ${d.key}`).toContain(d.key);
          }
          const server = world.server.items();
          world.users.forEach((user, n) => {
            const id = itemId(n);
            const touches = saved.filter(
              ([, { input }]) =>
                typeof input === 'object' && input !== null && Reflect.get(input, 'id') === id,
            );
            expect(server[id]?.counter, user.id).toBe(touches.length);
          });
          const rejected = world.dispatched.filter((d) => d.outcome?.status === 'rejected');
          expect(rejected).toEqual([]);
          for (const tab of world.live) expect(world.view(tab), tab.name).toEqual(server);
        },
      ),
    ),
    simParameters(),
  );
});
