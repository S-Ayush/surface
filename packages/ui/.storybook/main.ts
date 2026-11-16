import type { StorybookConfig } from '@storybook/react-vite';
import { defaultClientConditions, mergeConfig } from 'vite';

// No telemetry, crash reports or update checks (CLAUDE.md rule 5: no outbound calls).
const config: StorybookConfig = {
  framework: '@storybook/react-vite',
  stories: [
    '../src/**/*.stories.tsx',
    '../../editor/stories/**/*.stories.tsx',
    // Feature stories that need the editor, which `ui` may not import (PLAN-013 S5).
    '../../../apps/web/src/**/*.stories.tsx',
  ],
  addons: ['@storybook/addon-a11y', '@storybook/addon-vitest', 'storybook-addon-pseudo-states'],
  // Workspace packages (@surface/domain) are served from their TypeScript source.
  viteFinal: (viteConfig) =>
    mergeConfig(viteConfig, {
      resolve: { conditions: ['@surface/source', ...defaultClientConditions] },
    }),
  core: {
    disableTelemetry: true,
    disableWhatsNewNotifications: true,
    enableCrashReports: false,
  },
};

export default config;
