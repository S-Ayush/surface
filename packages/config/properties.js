// fast-check parameters by test tier (plans README §6, "Test tiers"; SPEC-004 D12). Property
// tests state their full case count and their fixed seed; these helpers decide how many run:
// - the gate (`pnpm test`, `pnpm check`): a share of the cases (`propertyScale`, set by
//   `vitest.js`), but never fewer than `GATE_FLOOR` (or the full count, when smaller), with each
//   test's fixed seed, so a run is fast and reproducible;
// - `pnpm test:deep`: every case, with one fresh seed for the whole run (`propertySeed`), which
//   the run prints so a failure can be replayed;
// - a run that provides `propertyRuns` (`pnpm sim:deep`): exactly that many cases.
// A property marked `{ full: true }` runs its full count in every tier: the private-team leak
// and permission properties (CLAUDE.md rule 4), whose cost is small next to what they guard.
import { inject } from 'vitest';

/** The fewest cases the gate runs of a property (all of them when it has fewer). */
export const GATE_FLOOR = 25;

/** Cases to run for a property whose full count is `fullRuns`. */
export function propertyRuns(fullRuns, { full = false } = {}) {
  const runs = inject('propertyRuns');
  if (runs !== undefined) return runs;
  if (full) return fullRuns;
  const scale = inject('propertyScale') ?? 1;
  return Math.max(Math.min(fullRuns, GATE_FLOOR), Math.ceil(fullRuns * scale));
}

/** The seed of a property: `seed`, unless the run rotates seeds (`pnpm test:deep`). */
export function propertySeed(seed) {
  return inject('propertySeed') ?? seed;
}

/**
 * `params` (fast-check's `seed` and `numRuns`, 100 when unset) for this tier. Other fields
 * (`path`, `endOnFailure`…) pass through. `{ full: true }` keeps the full count in every tier.
 */
export function propertyParameters(params = {}, options = {}) {
  const seed = propertySeed(params.seed);
  return {
    ...params,
    numRuns: propertyRuns(params.numRuns ?? 100, options),
    ...(seed === undefined ? {} : { seed }),
  };
}

/** Whether this is a `pnpm test:deep` run (full sizes). */
export function isDeepRun() {
  return inject('testTier') === 'deep';
}
