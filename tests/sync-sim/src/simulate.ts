/**
 * Run one simulation case from start to quiescence (PLAN-002 S9), on a fake
 * clock and seeded randomness, then hand the settled world to a check.
 */
import { EPOCH, installClock, uninstallClock } from './clock.js';
import { SERVER_CODE, seedGlobals, seededRandom } from './random.js';
import type { ItemState, SimServer } from './server.js';
import { FakeHubServer } from './server.js';
import type { Case, RunOptions } from './steps.js';
import { apply, itemId, reopenClosedUsers } from './steps.js';
import { World } from './world.js';

export interface SimulateOptions extends RunOptions {
  /** Item indexes that exist on the server before the first tab opens. */
  readonly seedItems: (users: number) => readonly number[];
  /**
   * The server for a case, with `users` signed in; the fake hub by default.
   * Called once the clock is installed, so its timers are the fake ones.
   */
  readonly server?: (users: number) => Promise<SimServer>;
}

/** What a run produced, for checks and for the replay test. */
export interface Outcome {
  readonly world: World;
  /** Virtual ms from the first tab to quiescence. */
  readonly elapsedMs: number;
  /** The server's state once everything settled. */
  readonly server: { readonly head: number; readonly items: Record<string, ItemState> };
}

const fakeHub = (users: number): Promise<SimServer> => Promise.resolve(new FakeHubServer(users));

export async function simulate<T>(
  simCase: Case,
  options: SimulateOptions,
  check: (outcome: Outcome) => T | Promise<T>,
): Promise<T> {
  installClock();
  // A real server's own draws stay out of the case's (`SERVER_CODE`); the fake hub draws none.
  const restore = seedGlobals(
    seededRandom(simCase.seed ^ 0x5eed5eed),
    options.server === undefined ? {} : { realFor: SERVER_CODE },
  );
  let world: World | undefined;
  try {
    const server = await (options.server ?? fakeHub)(simCase.users);
    world = new World({ seed: simCase.seed, webLocks: simCase.webLocks }, server);
    await server.seed(
      options.seedItems(simCase.users).map((n) => ({ id: itemId(n), title: `Item ${n}` })),
    );
    // Late users get their first tab from an `open` step, or at the end.
    for (const user of world.users.slice(0, simCase.users - simCase.lateUsers)) world.open(user);
    // Changes need a loaded tab; from here on, steps decide what happens.
    await world.loaded();
    for (const step of simCase.steps) await apply(world, step, options);
    reopenClosedUsers(world);
    await world.quiesce();
    await world.reopenEveryUser();
    const elapsedMs = Date.now() - EPOCH;
    const settled = { head: await server.head(), items: await server.items() };
    return await check({ world, elapsedMs, server: settled });
  } finally {
    await world?.dispose();
    restore();
    uninstallClock();
  }
}
