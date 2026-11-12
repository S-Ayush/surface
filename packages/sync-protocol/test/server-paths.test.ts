// The server's own paths (`server-paths.ts`, PLAN-005 S9 handoff): one list for the server's app-shell
// fallback and the offline worker (ADR-0019), matched the same way by both.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as root from '../src/index.js';
import { isServerPath, SERVER_PREFIXES } from '@surface/sync-protocol/server-paths';

describe('isServerPath', () => {
  it.each(SERVER_PREFIXES.map((prefix) => [prefix]))('claims everything under %s', (prefix) => {
    expect(isServerPath(prefix)).toBe(true);
    expect(isServerPath(`${prefix}${prefix.endsWith('/') ? '' : '/'}x/y`)).toBe(true);
  });

  it('claims the bare segment of a prefix that ends in /, and a trailing slash', () => {
    expect(['/api', '/sync', '/auth', '/files', '/api/', '/files/'].map(isServerPath)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it('leaves look-alikes of a whole-segment prefix to the app, but not of a plain prefix', () => {
    expect(['/apix', '/sync-other', '/authors', '/filesystem'].map(isServerPath)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    // `/mcp`, `/healthz`, `/readyz` and `/metrics` are plain prefixes, as the server matched them.
    expect(['/mcpx', '/metrics/x'].map(isServerPath)).toEqual([true, true]);
  });

  it('leaves the app’s own pages to the app', () => {
    expect(
      ['/', '/setup', '/login', '/ENG/issues', '/assets/index-abc.js'].map(isServerPath),
    ).toEqual([false, false, false, false, false]);
  });

  it('takes a path without its query string: callers strip it first', () => {
    // `/api?x=1` isn't a path; the server and the worker both match `URL.pathname`.
    expect(isServerPath(new URL('http://h/api?x=1').pathname)).toBe(true);
    expect(isServerPath(new URL('http://h/?next=/api/').pathname)).toBe(false);
  });
});

describe('the server-paths module', () => {
  it('is exported from the package root too, as the same functions', () => {
    expect([root.isServerPath, root.SERVER_PREFIXES]).toEqual([isServerPath, SERVER_PREFIXES]);
  });

  it('imports nothing, so the offline worker can bundle it without the package’s schemas', () => {
    const source = readFileSync(new URL('../src/server-paths.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/^\s*import\b|^\s*export\s[^;]*\sfrom\s|\brequire\(|\bimport\(/m);
  });
});
