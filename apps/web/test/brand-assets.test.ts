// PLAN-017 S1: the build hashes the brand icons into assets/, so the offline cache (ADR-0019,
// which keeps only /index.html and assets/) has them. `withIconUrls` is the step that rewrites the
// manifest's icon paths to those hashed files.
import { existsSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { appBuild } from '../vite-app-cache.js';
import { withIconUrls } from '../vite-brand.js';

const SOURCE = JSON.stringify({
  name: 'Surface',
  icons: [
    { src: '/src/brand/icon-192.png', sizes: '192x192' },
    { src: '/src/brand/icon-512.png', sizes: '512x512' },
  ],
});

describe('brand icons are hashed into assets', () => {
  it('points the manifest at the hashed icon files, keeping its other fields', () => {
    const out = JSON.parse(withIconUrls(SOURCE, (file) => `/assets/${file}-HASH`)) as {
      name: string;
      icons: { src: string; sizes: string }[];
    };
    expect(out.name).toBe('Surface');
    expect(out.icons).toEqual([
      { src: '/assets/icon-192.png-HASH', sizes: '192x192' },
      { src: '/assets/icon-512.png-HASH', sizes: '512x512' },
    ]);
  });

  it('refuses an icon outside src/brand, which the build would not find', () => {
    const bad = JSON.stringify({ icons: [{ src: '/elsewhere/icon.png' }] });
    expect(() => withIconUrls(bad, (file) => file)).toThrow(/Unexpected icon path/);
  });

  it('the offline cache lists the hashed icons and the manifest', () => {
    const files = [
      'assets/favicon-AAAA.svg',
      'assets/icon-192-BBBB.png',
      'assets/manifest-CCCC.webmanifest',
    ];
    expect(appBuild(files, '<html></html>').files).toEqual([
      '/index.html',
      ...files.map((f) => `/${f}`),
    ]);
  });

  it('has every file the manifest and page name', () => {
    for (const file of [
      'favicon.svg',
      'favicon.ico',
      'apple-touch-icon.png',
      'icon-192.png',
      'icon-512.png',
      'icon-maskable-512.png',
      'manifest.webmanifest',
    ]) {
      expect(existsSync(new URL(`../src/brand/${file}`, import.meta.url)), file).toBe(true);
    }
  });

  // brand.md §9: the brand folder is the source of truth, and the app ships copies of it.
  it('ships icon files identical to the brand assets', () => {
    for (const file of [
      'favicon.svg',
      'favicon.ico',
      'apple-touch-icon.png',
      'icon-192.png',
      'icon-512.png',
      'icon-maskable-512.png',
    ]) {
      const app = readFileSync(new URL(`../src/brand/${file}`, import.meta.url));
      const brand = readFileSync(
        new URL(`../../../docs/05-design/brand/assets/${file}`, import.meta.url),
      );
      expect(app.equals(brand), file).toBe(true);
    }
  });

  // Desktop installs (Chrome and Edge on macOS and Windows) show `any` icons as drawn, so they
  // carry the rounded tile with clear corners. iOS and Android mask theirs: those stay full bleed.
  it('draws the general-purpose icons with clear corners and the masked ones full bleed', () => {
    expect(cornerAlpha('icon-192.png')).toBe(0);
    expect(cornerAlpha('icon-512.png')).toBe(0);
    expect(cornerAlpha('apple-touch-icon.png')).toBe(255);
    expect(cornerAlpha('icon-maskable-512.png')).toBe(255);
  });
});

/**
 * The alpha of an 8-bit PNG's top-left pixel: 255 for RGB (no alpha channel, as iOS wants), else
 * read from RGBA. Every PNG row filter leaves the first pixel of the first row unchanged.
 */
function cornerAlpha(file: string): number | undefined {
  const png = readFileSync(new URL(`../src/brand/${file}`, import.meta.url));
  expect(png.readUInt8(24), `${file} bit depth`).toBe(8);
  const colourType = png.readUInt8(25);
  expect([2, 6], `${file} colour type (RGB or RGBA)`).toContain(colourType);
  if (colourType === 2) return 255;
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    if (png.toString('latin1', at + 4, at + 8) === 'IDAT') {
      idat.push(png.subarray(at + 8, at + 8 + length));
    }
    at += 12 + length;
  }
  // Byte 0 is the row's filter type, then R, G, B, A.
  return inflateSync(Buffer.concat(idat))[4];
}
