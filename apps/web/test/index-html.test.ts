// PLAN-017 S1 (brand.md §7): the page links the brand icons, the manifest and the theme colours,
// without adding an inline script or style (the CSP hashes the one bootstrap script).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const manifest = JSON.parse(
  readFileSync(new URL('../src/brand/manifest.webmanifest', import.meta.url), 'utf8'),
) as { icons: { src: string; sizes: string; purpose?: string }[] } & Record<string, unknown>;

describe('index.html', () => {
  it('links the brand icons and manifest', () => {
    expect(html).toMatch(
      /<link rel="icon" href="\/src\/brand\/favicon\.svg" type="image\/svg\+xml"/,
    );
    expect(html).toMatch(/<link rel="icon" href="\/src\/brand\/favicon\.ico"/);
    expect(html).toContain('<link rel="apple-touch-icon" href="/src/brand/apple-touch-icon.png"');
    expect(html).toContain('<link rel="manifest" href="/src/brand/manifest.webmanifest"');
    expect(html).toContain('content="#F3F4F6" media="(prefers-color-scheme: light)"');
    expect(html).toContain('content="#0B0D0F" media="(prefers-color-scheme: dark)"');
  });

  it('keeps the theme bootstrap as the only inline script and adds no inline style', () => {
    expect(html.match(/<script(?![^>]*\bsrc=)[^>]*>/g)).toHaveLength(1);
    expect(html).not.toMatch(/<style|style="/);
  });

  it('names the app Surface and lists the 192, 512 and maskable icons', () => {
    expect(manifest.name).toBe('Surface');
    expect(manifest.short_name).toBe('Surface');
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons.map((i) => [i.sizes, i.purpose ?? 'any'])).toEqual([
      ['192x192', 'any'],
      ['512x512', 'any'],
      ['512x512', 'maskable'],
    ]);
  });
});
