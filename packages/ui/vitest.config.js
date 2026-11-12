import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { SOURCE_CONDITION, surfaceVitest } from '@surface/config/vitest';
import { playwright } from '@vitest/browser-playwright';
import { defaultClientConditions } from 'vite';
import { defineConfig } from 'vitest/config';

/** Stories as browser tests: play functions (keyboard) and axe (AC-12), in one theme each. */
function storybookProject(theme) {
  return {
    // addon-vitest applies the preview and addon annotations itself (no setup file needed).
    plugins: [storybookTest({ configDir: '.storybook' })],
    // Workspace packages (@surface/domain) are served from their TypeScript source.
    resolve: { conditions: [SOURCE_CONDITION, ...defaultClientConditions] },
    define: { 'import.meta.env.VITE_STORYBOOK_THEME': JSON.stringify(theme) },
    test: {
      name: `storybook-${theme}`,
      browser: {
        enabled: true,
        headless: true,
        provider: playwright(),
        instances: [{ browser: 'chromium' }],
      },
    },
  };
}

export default defineConfig({
  test: {
    projects: [
      // Node-only tests: part of `pnpm test` and the gate.
      surfaceVitest({ test: { name: 'unit' } }),
      // Browser tests: `pnpm test:storybook` (needs Playwright's Chromium).
      storybookProject('light'),
      storybookProject('dark'),
    ],
  },
});
