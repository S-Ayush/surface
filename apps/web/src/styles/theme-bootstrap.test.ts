// PLAN-005 S1: index.html sets the theme before the first paint (no flash). The script's behaviour is
// tested in @surface/ui; this checks index.html carries exactly that script in <head>. Its position
// relative to the stylesheet and module script Vite injects is checked on the built page in S2.
import { THEME_BOOTSTRAP_SCRIPT } from '@surface/ui';
import { describe, expect, it } from 'vitest';
import html from '../../index.html?raw';

/** Collapses whitespace runs, so indentation differs but `var dark` never equals `vardark`. */
const squash = (code: string): string => code.replace(/\s+/g, ' ').trim();
const head = html.slice(0, html.indexOf('</head>'));

describe('index.html theme bootstrap', () => {
  // Any <script> without src, whatever its other attributes.
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
    (m) => m[1] ?? '',
  );

  it('has exactly one inline script, so the CSP allows a single hash', () => {
    expect(inline).toHaveLength(1);
  });

  it('inlines the @surface/ui bootstrap script verbatim (modulo whitespace)', () => {
    expect(squash(inline[0] ?? '')).toBe(squash(THEME_BOOTSTRAP_SCRIPT));
  });

  it('sits in <head>, so it runs before the body renders', () => {
    expect(head).toContain('<script>');
  });

  it('declares both colour schemes, so form controls and scrollbars match the theme', () => {
    expect(head).toContain('<meta name="color-scheme" content="light dark" />');
  });
});
