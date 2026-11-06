import { surfaceVitestIntegration } from '@surface/config/vitest';

export default surfaceVitestIntegration({
  test: {
    environment: 'node',
    // Starts Postgres 17 (or uses TEST_DATABASE_URL) and builds the migrated template database.
    globalSetup: ['./test/global-setup.ts'],
  },
});
