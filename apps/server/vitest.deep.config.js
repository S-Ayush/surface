import { surfaceVitestIntegration } from '@surface/config/vitest';

// `pnpm test:deep` (plans README §6): the latency budgets (SPEC-003 AC-11) and the full-size
// ordering stress (SPEC-002 AC-1, 20 × 500), one file at a time so neither skews the other.
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
  include: ['test/**/*.perf.int.test.ts', 'test/**/*.stress.int.test.ts'],
};
export default config;
