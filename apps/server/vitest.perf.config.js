import { surfaceVitestIntegration } from '@surface/config/vitest';

// Latency budgets (SPEC-003 AC-11): one file at a time, after the other integration tests.
const config = surfaceVitestIntegration({
  test: {
    environment: 'node',
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
  },
});
// mergeConfig concatenates arrays, so the include list is replaced rather than merged.
config.test = { ...config.test, include: ['test/**/*.perf.int.test.ts'] };
export default config;
