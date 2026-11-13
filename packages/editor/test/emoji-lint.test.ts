// PLAN-013 S2: the ESLint ban on CDN-capable emoji libraries is in the shared config and works
// (SPEC-013 AC-16, "lint rule check"). The libraries can fetch data or sprites from a CDN.
import { EMOJI_DYNAMIC_IMPORT_BAN, EMOJI_LIBRARY_BAN, surfaceEslint } from '@surface/config/eslint';
import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';

const linter = new Linter({ configType: 'flat' });
const config: Linter.Config[] = [
  { files: ['**/*.js'], rules: { 'no-restricted-imports': ['error', EMOJI_LIBRARY_BAN] } },
];

const syntaxConfig: Linter.Config[] = [
  {
    files: ['**/*.js'],
    rules: { 'no-restricted-syntax': ['error', EMOJI_DYNAMIC_IMPORT_BAN] },
  },
];

const messages = (code: string) =>
  linter.verify(code, config, 'x.js').map((message) => message.ruleId);
const dynamicMessages = (code: string) =>
  linter.verify(code, syntaxConfig, 'x.js').map((message) => message.ruleId);

describe('the emoji library ban', () => {
  it.each([
    "import { fetchEmojis } from 'emojibase';",
    "import { init } from 'emoji-mart';",
    "import data from 'emoji-mart/data/all.json';",
    "import data from '@emoji-mart/data';",
    "import { x } from 'emojibase/lib/fetch';",
  ])('refuses %s', (code) => {
    expect(messages(code)).toEqual(['no-restricted-imports']);
  });

  it.each([
    "import data from 'emojibase-data/en/compact.json';",
    "import data from 'emojibase-data/en/shortcodes/emojibase.json';",
  ])('allows the bundled data: %s', (code) => {
    expect(messages(code)).toEqual([]);
  });

  it.each([
    "const lib = await import('emojibase');",
    "const lib = await import('emoji-mart');",
    "const data = await import('emoji-mart/data/all.json');",
    "const data = await import('@emoji-mart/data');",
  ])('refuses the dynamic import %s', (code) => {
    expect(dynamicMessages(code)).toEqual(['no-restricted-syntax']);
  });

  it.each([
    "const data = await import('emojibase-data/en/compact.json');",
    "const other = await import('./emojibase.js');",
  ])('allows the dynamic import %s', (code) => {
    expect(dynamicMessages(code)).toEqual([]);
  });

  it('is in every config block that sets no-restricted-syntax, TSX included', () => {
    const shared = surfaceEslint({ rootDir: '/' });
    const lists = shared
      .map((entry) => entry.rules?.['no-restricted-syntax'])
      .filter((value) => value !== undefined);
    expect(lists.length).toBeGreaterThanOrEqual(2);
    for (const list of lists) {
      expect(JSON.stringify(list)).toContain(EMOJI_DYNAMIC_IMPORT_BAN.message);
    }
  });

  it('is part of the shared config every package uses', () => {
    const shared = surfaceEslint({ rootDir: '/' });
    const rule = shared
      .map((entry) => entry.rules?.['no-restricted-imports'])
      .find((value) => value !== undefined);
    expect(rule).toEqual(['error', EMOJI_LIBRARY_BAN]);
  });
});
