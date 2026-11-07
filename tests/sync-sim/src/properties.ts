/**
 * The two properties' checks (SPEC-002 AC-2, AC-3), shared by the fake hub's
 * suite (`pnpm test`, `pnpm sim`) and the real server's (`pnpm test:int`).
 */
import { expect } from 'vitest';
import type { Outcome, SimulateOptions } from './simulate.js';
import { itemId } from './steps.js';

export interface Property {
  readonly options: SimulateOptions;
  readonly check: (outcome: Outcome) => void;
}

/** Property 1: each tab shows exactly the server's rows, with nothing pending. */
export const convergence: Property = {
  options: { seedItems: () => [0, 1, 2] },
  check: ({ world, server }) => {
    expect(world.problems).toEqual([]);
    for (const tab of world.live) {
      expect(tab.store.pending, tab.name).toEqual([]);
      expect(world.view(tab), tab.name).toEqual(server.items);
    }
  },
};

/** Property 2: every saved touch is applied exactly once, and none is rejected. */
export const exactlyOnce: Property = {
  options: {
    seedItems: (users) => Array.from({ length: users }, (_, n) => n),
    itemFor: (_item, user) => user,
  },
  check: ({ world, server }) => {
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
    world.users.forEach((user, n) => {
      const id = itemId(n);
      const touches = saved.filter(
        ([, { input }]) =>
          typeof input === 'object' && input !== null && Reflect.get(input, 'id') === id,
      );
      expect(server.items[id]?.counter, user.name).toBe(touches.length);
    });
    const rejected = world.dispatched.filter((d) => d.outcome?.status === 'rejected');
    expect(rejected).toEqual([]);
    for (const tab of world.live) expect(world.view(tab), tab.name).toEqual(server.items);
  },
};
