import type { StorybookConfig } from '@storybook/react-vite';

// No telemetry, crash reports or update checks (CLAUDE.md rule 5: no outbound calls).
const config: StorybookConfig = {
  framework: '@storybook/react-vite',
  stories: ['../src/**/*.stories.tsx'],
  addons: ['@storybook/addon-a11y', '@storybook/addon-vitest', 'storybook-addon-pseudo-states'],
  core: {
    disableTelemetry: true,
    disableWhatsNewNotifications: true,
    enableCrashReports: false,
  },
};

export default config;
