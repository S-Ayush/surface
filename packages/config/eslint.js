import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const REACT_FILES = [
  'apps/web/**/*.{ts,tsx}',
  'packages/ui/**/*.{ts,tsx}',
  'packages/editor/**/*.{ts,tsx}',
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
    prettier,
  );
}
