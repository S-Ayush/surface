import type { Decorator, Preview } from '@storybook/react-vite';
import { overlayManager } from '../src/overlays/manager.js';
import { OverlayProvider } from '../src/overlays/OverlayProvider.js';
import { PlatformProvider, type Platform } from '../src/platform.js';
import { THEMES, type Theme } from '../src/tokens.gen.js';
import '../src/styles/index.css';
import './preview.css';

// The Vitest "storybook-dark" project sets this, so axe also runs every story in the dark theme.
const DEFAULT_THEME: Theme = import.meta.env.VITE_STORYBOOK_THEME === 'dark' ? 'dark' : 'light';

const isTheme = (value: unknown): value is Theme => THEMES.some((theme) => theme === value);
const isPlatform = (value: unknown): value is Platform => value === 'mac' || value === 'other';

const withThemeAndPlatform: Decorator = (Story, context) => {
  const theme = isTheme(context.globals['theme']) ? context.globals['theme'] : DEFAULT_THEME;
  const platform = isPlatform(context.globals['platform']) ? context.globals['platform'] : 'mac';
  // Tokens are scoped by <html data-theme> (PLAN-005 S1); portals (tooltips) inherit it too.
  document.documentElement.setAttribute('data-theme', theme);
  return (
    <PlatformProvider platform={platform}>
      <OverlayProvider>
        <Story />
      </OverlayProvider>
    </PlatformProvider>
  );
};

const preview: Preview = {
  decorators: [withThemeAndPlatform],
  // The overlay manager is app-wide: start every story without leftover toasts or banners.
  beforeEach: () => {
    overlayManager.clear();
  },
  globalTypes: {
    theme: {
      description: 'Colour theme',
      toolbar: {
        title: 'Theme',
        icon: 'mirror',
        items: [
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
        ],
        dynamicTitle: true,
      },
    },
    platform: {
      description: 'Platform for key labels',
      toolbar: {
        title: 'Platform',
        icon: 'key',
        items: [
          { value: 'mac', title: 'macOS (⌘)' },
          { value: 'other', title: 'Windows / Linux (Ctrl)' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: DEFAULT_THEME, platform: 'mac' },
  parameters: {
    layout: 'padded',
    backgrounds: { disable: true },
    controls: { expanded: true },
    // AC-12: any axe violation fails the story's test (design-system §5.4).
    a11y: { test: 'error' },
  },
};

export default preview;
