import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { THEME_STORAGE_KEY, resolveTheme } from '../src/theme.js';
import { THEME_BOOTSTRAP_SCRIPT } from '../src/theme-bootstrap.js';

type Env = {
  stored?: string | null;
  storageThrows?: boolean;
  prefersDark?: boolean | 'no-matchMedia';
};

/** Runs the bootstrap in an isolated context with a fake window and returns the data-theme it set. */
function bootstrap({ stored = null, storageThrows = false, prefersDark = false }: Env): unknown {
  const attributes = new Map<string, string>();
  const window = {
    localStorage: {
      getItem(key: string) {
        if (storageThrows) throw new Error('SecurityError: storage is disabled');
        return key === THEME_STORAGE_KEY ? stored : null;
      },
    },
    matchMedia:
      prefersDark === 'no-matchMedia'
        ? undefined
        : (query: string) => ({ matches: query === '(prefers-color-scheme: dark)' && prefersDark }),
  };
  const document = {
    documentElement: { setAttribute: (name: string, value: string) => attributes.set(name, value) },
  };
  runInNewContext(THEME_BOOTSTRAP_SCRIPT, { window, document });
  return attributes.get('data-theme');
}

describe('theme bootstrap script', () => {
  const preferences = ['light', 'dark', 'system', null, 'garbage'];

  it.each(
    preferences.flatMap((stored) => [false, true].map((prefersDark) => ({ stored, prefersDark }))),
  )(
    'agrees with resolveTheme for stored=$stored, OS dark=$prefersDark',
    ({ stored, prefersDark }) => {
      expect(bootstrap({ stored, prefersDark })).toBe(resolveTheme(stored, prefersDark));
    },
  );

  it('follows the OS when storage throws (privacy mode, blocked cookies)', () => {
    expect(bootstrap({ storageThrows: true, prefersDark: true })).toBe('dark');
    expect(bootstrap({ storageThrows: true, prefersDark: false })).toBe('light');
  });

  it('falls back to light, or the stored choice, without matchMedia', () => {
    expect(bootstrap({ prefersDark: 'no-matchMedia' })).toBe('light');
    expect(bootstrap({ stored: 'dark', prefersDark: 'no-matchMedia' })).toBe('dark');
  });
});
