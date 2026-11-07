import { describe, expect, it } from 'vitest';
import { simulate } from '../src/simulate.js';

describe('the simulation', () => {
  it('brings three tabs to the server state with no faults', async () => {
    const result = await simulate(
      {
        seed: 1,
        users: 3,
        webLocks: true,
        steps: [
          { t: 'wait', ms: 1000 },
          { t: 'rename', tab: 0, item: 0, title: 'Alpha' },
          { t: 'touch', tab: 1, item: 1 },
          { t: 'create', tab: 2, item: 4, title: 'Beta' },
          { t: 'wait', ms: 1000 },
        ],
      },
      { seedItems: () => [0, 1, 2] },
      ({ world, elapsedMs }) => ({
        server: world.server.items(),
        views: world.live.map((tab) => world.view(tab)),
        problems: world.problems,
        outcomes: world.dispatched.map((d) => d.outcome?.status),
        elapsedMs,
      }),
    );
    expect(result.problems).toEqual([]);
    for (const view of result.views) expect(view).toEqual(result.server);
    expect(result.outcomes).toEqual(['confirmed', 'confirmed', 'confirmed']);
    expect(Object.keys(result.server)).toHaveLength(4);
  });
});
