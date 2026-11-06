import { fileURLToPath } from 'node:url';
import { defaultClientConditions, defaultServerConditions } from 'vite';
import { defineConfig, mergeConfig } from 'vitest/config';

/** Export condition that points workspace packages at their TypeScript source. */
export const SOURCE_CONDITION = '@surface/source';

const base = defineConfig({
  resolve: { conditions: [SOURCE_CONDITION, ...defaultClientConditions] },
  ssr: { resolve: { conditions: [SOURCE_CONDITION, ...defaultServerConditions] } },
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
    // Integration tests (real Postgres) run separately via `test:int`.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.int.test.{ts,tsx}'],
    // Unit tests may not reach the network: mock or fake every outside service.
    setupFiles: [fileURLToPath(new URL('./vitest-no-network.js', import.meta.url))],
  },
});

/**
 * Shared Vitest config for a workspace package.
 * @param {import('vitest/config').ViteUserConfig} [overrides]
 */
export function surfaceVitest(overrides = {}) {
  return mergeConfig(base, overrides);
}

const integrationBase = defineConfig({
  resolve: base.resolve,
  ssr: base.ssr,
  test: {
    include: ['src/**/*.int.test.{ts,tsx}', 'test/**/*.int.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Containers and real databases are slower than unit tests.
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});

/**
 * Vitest config for integration tests (`*.int.test.ts`, run by `test:int`).
 * @param {import('vitest/config').ViteUserConfig} [overrides]
 */
export function surfaceVitestIntegration(overrides = {}) {
  return mergeConfig(integrationBase, overrides);
}
