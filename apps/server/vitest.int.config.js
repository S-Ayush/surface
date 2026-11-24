import { surfaceVitestIntegration } from '@surface/config/vitest';

export default surfaceVitestIntegration({
  test: {
    environment: 'node',
    // Starts Postgres 17 (or uses TEST_DATABASE_URL) and builds the migrated template database.
    globalSetup: ['./test/global-setup.ts'],
    // Latency budgets run in `pnpm test:deep` (vitest.deep.config.js), alone, so parallel files
    // can't skew them. The ordering stress runs here at a tenth of its size, there in full.
    exclude: ['**/*.perf.int.test.{ts,tsx}'],
  },
});
