// Design system (docs/05-design/design-system.md). Global CSS: `@surface/ui/styles.css`.
export { LABEL_HUES, THEMES, token } from './tokens.gen.js';
export type { LabelHue, Theme, Token } from './tokens.gen.js';
export { THEME_PREFERENCES, THEME_STORAGE_KEY, isThemePreference, resolveTheme } from './theme.js';
export type { ThemePreference } from './theme.js';
export { THEME_BOOTSTRAP_SCRIPT } from './theme-bootstrap.js';
