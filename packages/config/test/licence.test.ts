import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findViolations, isAllowedExpression } from '../licenses.js';

const root = join(import.meta.dirname, '..', '..', '..');

function workspacePackageFiles(): string[] {
  const files = [join(root, 'package.json')];
  for (const group of ['apps', 'packages', 'tests']) {
    for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
      const file = join(root, group, entry.name, 'package.json');
      if (entry.isDirectory() && existsSync(file)) files.push(file);
    }
  }
  return files;
}

describe('licence policy (ADR-0026)', () => {
  it('every package.json declares MIT', () => {
    const files = workspacePackageFiles();
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const pkg = JSON.parse(readFileSync(file, 'utf8')) as { license?: string };
      expect({ file, license: pkg.license }).toEqual({ file, license: 'MIT' });
    }
  });

  it('LICENSE is the MIT text for the Surface contributors', () => {
    const text = readFileSync(join(root, 'LICENSE'), 'utf8');
    expect(text).toContain('MIT License');
    expect(text).toContain('Copyright (c) 2026 The Surface contributors');
  });

  it('rejects GPL-3.0 and accepts the named libvips exception', () => {
    const report = {
      MIT: [{ name: 'left-pad', versions: ['1.0.0'] }],
      'GPL-3.0': [{ name: 'copyleft-lib', versions: ['2.0.0'] }],
      'LGPL-3.0-or-later': [
        { name: '@img/sharp-libvips-linux-x64', versions: ['1.2.4'] },
        { name: 'some-other-lgpl', versions: ['1.0.0'] },
      ],
    };
    expect(findViolations(report)).toEqual([
      { name: 'copyleft-lib', versions: ['2.0.0'], license: 'GPL-3.0' },
      { name: 'some-other-lgpl', versions: ['1.0.0'], license: 'LGPL-3.0-or-later' },
    ]);
  });

  it('accepts OR expressions with one allowed side and rejects when none is allowed', () => {
    expect(isAllowedExpression('(MIT OR CC0-1.0)')).toBe(true);
    expect(isAllowedExpression('GPL-3.0 OR MIT')).toBe(true);
    expect(isAllowedExpression('GPL-3.0 OR AGPL-3.0')).toBe(false);
    expect(isAllowedExpression('MIT AND GPL-3.0')).toBe(false);
    expect(isAllowedExpression('(MIT OR Apache-2.0) AND ISC')).toBe(true);
    expect(isAllowedExpression('')).toBe(false);
  });
});
