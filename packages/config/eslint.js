import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import noSyncedTableWrites from './eslint-rules/no-synced-table-writes.js';

const REACT_FILES = [
  'apps/web/**/*.{ts,tsx}',
  'packages/ui/**/*.{ts,tsx}',
  'packages/editor/**/*.{ts,tsx}',
  'packages/sync-react/**/*.{ts,tsx}',
];

/** Hex colours, px lengths and colour functions inside inline style values (esquery regex). */
const INLINE_STYLE_RAW_VALUE =
  '/#[0-9a-fA-F]{3,8}\\b|\\dpx\\b|\\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\\(/';
const INLINE_STYLE_MESSAGE =
  'Inline styles use tokens only (var(--…)): no hex, px or colour functions (design-system §5.4).';

/**
 * Synced tables (SPEC-002 §4.1) and the sync-log tables only the repo layer writes: the Drizzle
 * export and the SQL name. `apps/server/test/sync-lint.test.ts` checks this list against the
 * server's `SYNCED_MODELS`, so a new synced model can't be left out.
 */
export const SYNCED_TABLES = [
  { identifier: 'debugItems', name: 'debug_items' },
  { identifier: 'workspace', name: 'workspace' },
  { identifier: 'users', name: 'users' },
  { identifier: 'userPreferences', name: 'user_preferences' },
  { identifier: 'teams', name: 'teams' },
  { identifier: 'teamMemberships', name: 'team_memberships' },
  { identifier: 'workflowStatuses', name: 'workflow_statuses' },
  { identifier: 'labels', name: 'labels' },
  { identifier: 'syncLog', name: 'sync_log' },
  { identifier: 'syncState', name: 'sync_state' },
];

/**
 * Surface ESLint flat config.
 * @param {{ rootDir: string }} options  rootDir = repository root (for typed linting).
 */
export function surfaceEslint({ rootDir }) {
  return defineConfig(
    {
      ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', '**/coverage/**', 'docs/**'],
    },
    js.configs.recommended,
    tseslint.configs.recommendedTypeChecked,
    {
      languageOptions: {
        parserOptions: { projectService: true, tsconfigRootDir: rootDir },
      },
      rules: {
        '@typescript-eslint/consistent-type-imports': 'error',
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
        ],
        '@typescript-eslint/switch-exhaustiveness-check': 'error',
        eqeqeq: ['error', 'smart'],
        'no-console': 'error',
      },
    },
    {
      // Plain JS config files are not part of any tsconfig.
      files: ['**/*.{js,cjs,mjs}'],
      extends: [tseslint.configs.disableTypeChecked],
      languageOptions: { globals: globals.node },
    },
    {
      files: ['apps/server/**/*.ts'],
      languageOptions: { globals: globals.node },
    },
    {
      files: REACT_FILES,
      extends: [reactHooks.configs.flat.recommended],
      languageOptions: { globals: globals.browser },
    },
    {
      // AC-11 (lint part) for TSX: Stylelint covers CSS files, this covers inline `style={…}`.
      // Values must be tokens (var(--…)) or computed numbers, never hex, px or colour functions.
      files: [
        'apps/web/src/**/*.tsx',
        'packages/ui/src/**/*.tsx',
        'packages/editor/src/**/*.tsx',
        'packages/sync-react/src/**/*.tsx',
      ],
      rules: {
        'no-restricted-syntax': [
          'error',
          {
            selector: `JSXAttribute[name.name='style'] Literal[value=${INLINE_STYLE_RAW_VALUE}]`,
            message: INLINE_STYLE_MESSAGE,
          },
          {
            selector: `JSXAttribute[name.name='style'] TemplateElement[value.raw=${INLINE_STYLE_RAW_VALUE}]`,
            message: INLINE_STYLE_MESSAGE,
          },
        ],
      },
    },
    {
      // AC-12 (SPEC-002): synced tables are written only by the repo layer.
      files: ['apps/server/src/**/*.ts'],
      ignores: ['apps/server/src/sync/repo.ts'],
      plugins: { surface: { rules: { 'no-synced-table-writes': noSyncedTableWrites } } },
      rules: { 'surface/no-synced-table-writes': ['error', { tables: SYNCED_TABLES }] },
    },
    prettier,
  );
}
