import { surfaceVitest } from '@surface/config/vitest';

/**
 * Defaults for the property suite: 200 cases per property and a fixed seed. The gate
 * (`pnpm test`) runs a share of them, `pnpm test:deep` all 200 with a fresh seed (plans
 * README §6). `pnpm sim` overrides them (`scripts/sim.mjs`), e.g. 1,000 cases on `main` or one
 * seed to replay a failure.
 */
export const SIM_DEFAULTS = { simSeed: 20261107, simRuns: 200, simPath: '' };

export default surfaceVitest({
  test: {
    provide: SIM_DEFAULTS,
    // A property runs many simulated deployments: about 5 s in the gate and 25 s at 200 cases
    // alone, longer on a loaded machine. `pnpm sim` sets its own timeout for 1,000 cases.
    testTimeout: 5 * 60_000,
  },
});
