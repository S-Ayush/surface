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
    testTimeout: 15 * 60_000,
    // One server at a time: the cases already run one after another.
    fileParallelism: false,
  },
});
