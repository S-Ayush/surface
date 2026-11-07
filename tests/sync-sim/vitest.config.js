import { surfaceVitest } from '@surface/config/vitest';

/**
 * Defaults for the property suite: 200 cases per property on every `pnpm test`
 * (PRs). `pnpm sim` overrides them (`scripts/sim.mjs`), e.g. 1,000 cases on
 * `main` or one seed to replay a failure.
 */
export const SIM_DEFAULTS = { simSeed: 20261107, simRuns: 200, simPath: '' };

export default surfaceVitest({
  test: {
    provide: SIM_DEFAULTS,
    // A property runs hundreds of simulated deployments.
    testTimeout: 15 * 60_000,
  },
});
