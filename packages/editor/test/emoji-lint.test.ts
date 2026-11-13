// PLAN-013 S2: the ESLint ban on CDN-capable emoji libraries is in the shared config and works
// (SPEC-013 AC-16, "lint rule check"). The libraries can fetch data or sprites from a CDN.
import { EMOJI_LIBRARY_BAN, surfaceEslint } from '@surface/config/eslint';
import { Linter } from 'eslint';
import { describe, expect, it } from 'vitest';

const linter = new Linter({ configType: 'flat' });
const config: Linter.Config[] = [
  { files: ['**/*.js'], rules: { 'no-restricted-imports': ['error', EMOJI_LIBRARY_BAN] } },
];

const messages = (code: string) =>
  linter.verify(code, config, 'x.js').map((message) => message.ruleId);

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

  it('is part of the shared config every package uses', () => {
    const shared = surfaceEslint({ rootDir: '/' });
    const rule = shared
      .map((entry) => entry.rules?.['no-restricted-imports'])
      .find((value) => value !== undefined);
    expect(rule).toEqual(['error', EMOJI_LIBRARY_BAN]);
  });
});
