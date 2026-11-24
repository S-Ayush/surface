import { surfaceVitestIntegration } from '@surface/config/vitest';
import { SIM_DEFAULTS } from './vitest.config.js';

/**
 * The properties against the real server (PLAN-002 S9 part 2): 20 cases each
 * on every `pnpm test:int`, since each case starts a server on its own
 * database. The fake hub (`pnpm test`, `pnpm sim`) gives the depth.
 */
export default surfaceVitestIntegration({
  test: {
    environment: 'node',
    globalSetup: ['./test/support/global-setup.ts'],
    provide: { ...SIM_DEFAULTS, simRuns: 20 },
    // Files run in parallel: each case starts its own server (port 0) on its own database
    // (a random name cloned from `sync_sim_template`), so files share nothing but the cluster.
    // The slowest property takes about a minute alone; the margin covers a loaded machine.
    testTimeout: 5 * 60_000,
  },
});
