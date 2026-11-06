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
  },
});

/**
 * Shared Vitest config for a workspace package.
 * @param {import('vitest/config').ViteUserConfig} [overrides]
 */
export function surfaceVitest(overrides = {}) {
  return mergeConfig(base, overrides);
}
