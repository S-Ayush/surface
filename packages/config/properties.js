// fast-check parameters by test tier (plans README §6, "Test tiers"). Property tests state
// their full case count and their fixed seed; these helpers decide how many run:
// - the gate (`pnpm test`, `pnpm check`): a fraction of the cases (`propertyScale`, set by
//   `vitest.js`), with each test's fixed seed, so a run is fast and reproducible;
// - `pnpm test:deep`: every case, with one fresh seed for the whole run (`propertySeed`), which
//   the run prints so a failure can be replayed;
// - a run that provides `propertyRuns` (`pnpm sim:deep`): exactly that many cases.
import { inject } from 'vitest';

/** Cases to run for a property whose full count is `fullRuns`. */
export function propertyRuns(fullRuns) {
  const runs = inject('propertyRuns');
  if (runs !== undefined) return runs;
  const scale = inject('propertyScale') ?? 1;
  return Math.max(1, Math.ceil(fullRuns * scale));
}

/** The seed of a property: `seed`, unless the run rotates seeds (`pnpm test:deep`). */
export function propertySeed(seed) {
  return inject('propertySeed') ?? seed;
}

/**
 * `params` (fast-check's `seed` and `numRuns`, 100 when unset) for this tier. Other fields
 * (`path`, `endOnFailure`…) pass through.
 */
export function propertyParameters(params = {}) {
  const seed = propertySeed(params.seed);
  return {
    ...params,
    numRuns: propertyRuns(params.numRuns ?? 100),
    ...(seed === undefined ? {} : { seed }),
  };
}

/** Whether this is a `pnpm test:deep` run (full sizes, timing budgets). */
export function isDeepRun() {
  return inject('testTier') === 'deep';
}
