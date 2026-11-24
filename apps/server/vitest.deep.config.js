import { surfaceVitestIntegration } from '@surface/config/vitest';

// `pnpm test:deep` (plans README §6): the full-size ordering stress (SPEC-002 AC-1, 20 × 500) in
// its first phase (`SURFACE_TEST_TIER=deep`), the latency budgets (SPEC-003 AC-11) in its timing
// phase (`timing`), which runs one package at a time. One file at a time within each.
const TIMING = process.env.SURFACE_TEST_TIER === 'timing';

const config = surfaceVitestIntegration({
  test: {
    environment: 'node',
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
  },
});
// mergeConfig concatenates arrays, so the include list is replaced rather than merged.
config.test = {
  ...config.test,
  include: [TIMING ? 'test/**/*.perf.int.test.ts' : 'test/**/*.stress.int.test.ts'],
};
export default config;
