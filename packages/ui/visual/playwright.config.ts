// AC-13 visual regression: every story without a play function, in both themes, screenshotted from
// the static Storybook build. Run only inside the pinned Playwright image (`pnpm test:visual`), so
// fonts and rasterisation match CI; baselines live in visual/__screenshots__ and are reviewed in PRs.
import { defineConfig, devices } from '@playwright/test';

const PORT = 6007;

export default defineConfig({
  testDir: '.',
  testMatch: '*.visual.ts',
  outputDir: '../dist/visual-results',
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  fullyParallel: true,
  forbidOnly: true,
  retries: 0,
  reporter: [['list'], ['html', { outputFolder: '../dist/visual-report', open: 'never' }]],
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
      // Same image, fonts and DPR, so renders are pixel-identical. Keep this strict: a lost 2 px
      // focus ring is ~200 px, and a one-step grey change is a small per-pixel colour shift.
      maxDiffPixels: 10,
      threshold: 0.05,
    },
  },
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    reducedMotion: 'reduce',
  },
  webServer: {
    command: `node serve.mjs ${PORT}`,
    url: `http://127.0.0.1:${PORT}/index.json`,
    reuseExistingServer: false,
  },
});
