// AC-11 (lint part): component CSS uses only tokens. Hex, rgb()/hsl()-style functions, named colours
// and raw px are allowed only in token files: packages/ui/tokens/*.ts (not CSS, so never linted) and
// the generated packages/ui/src/styles/tokens.css (ignored below). px stays legal in media queries,
// which cannot read custom properties. Inline `style={{…}}` in TSX is not covered by this config.
/** @type {import('stylelint').Config} */
export default {
  ignoreFiles: [
    '**/node_modules/**',
    '**/dist/**',
    '**/coverage/**',
    'packages/ui/src/styles/tokens.css',
  ],
  rules: {
    'color-no-hex': [
      true,
      { message: 'Use a semantic colour token (var(--…)) instead of a hex value' },
    ],
    'color-named': [
      'never',
      { message: 'Use a semantic colour token (var(--…)) instead of a named colour' },
    ],
    'function-disallowed-list': [
      ['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix'],
      { message: 'Use a semantic colour token (var(--…)) instead of a colour function' },
    ],
    'unit-disallowed-list': [
      // Physical units too, so a raw length cannot dodge the px ban.
      ['px', 'pt', 'pc', 'cm', 'mm', 'q', 'in'],
      {
        ignoreMediaFeatureNames: {
          px: ['width', 'min-width', 'max-width', 'height', 'min-height', 'max-height'],
        },
        message: 'Use a spacing, sizing or radius token (var(--…)) instead of raw px',
      },
    ],
  },
};
