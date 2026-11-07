/**
 * Run one simulation case from start to quiescence (PLAN-002 S9), on a fake
 * clock and seeded randomness, then hand the settled world to a check.
 */
import { EPOCH, installClock, uninstallClock } from './clock.js';
import { seedGlobals, seededRandom } from './random.js';
import type { Case, RunOptions } from './steps.js';
import { apply, itemId, reopenClosedUsers } from './steps.js';
import { World } from './world.js';

export interface SimulateOptions extends RunOptions {
  /** Item indexes that exist on the server before the first tab opens. */
  readonly seedItems: (users: number) => readonly number[];
}

/** What a run produced, for checks and for the replay test. */
export interface Outcome {
  readonly world: World;
  /** Virtual ms from the first tab to quiescence. */
  readonly elapsedMs: number;
}

export async function simulate<T>(
  simCase: Case,
  options: SimulateOptions,
  check: (outcome: Outcome) => T,
): Promise<T> {
  installClock();
  const restore = seedGlobals(seededRandom(simCase.seed ^ 0x5eed5eed));
  const world = new World({ seed: simCase.seed, users: simCase.users, webLocks: simCase.webLocks });
  try {
    world.server.seed(
      options.seedItems(simCase.users).map((n) => ({ id: itemId(n), title: `Item ${n}` })),
    );
    for (const user of world.users) world.open(user);
    // Changes need a loaded tab; from here on, steps decide what happens.
    await world.loaded();
    for (const step of simCase.steps) await apply(world, step, options);
    reopenClosedUsers(world);
    await world.quiesce();
    await world.reopenEveryUser();
    return check({ world, elapsedMs: Date.now() - EPOCH });
  } finally {
    world.dispose();
    restore();
    uninstallClock();
  }
}
