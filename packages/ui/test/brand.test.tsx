/**
 * @vitest-environment jsdom
 */
// PLAN-017 S1 (brand.md §2-3): the components draw the brand asset files' paths, and are
// decorative unless named.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SurfaceLockup, SurfaceMark } from '../src/components/Brand/Brand.js';

// A path, not a URL: jsdom replaces the URL class, which `readFileSync` then rejects.
const ASSETS = path.resolve(import.meta.dirname, '../../../docs/05-design/brand/assets');

function paths(file: string): string[] {
  const svg = readFileSync(path.join(ASSETS, file), 'utf8');
  return [...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1] ?? '');
}

function render(node: React.ReactElement): Element {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(node);
  const svg = host.firstElementChild;
  if (svg === null) throw new Error('nothing rendered');
  return svg;
}

const drawn = (svg: Element) => [...svg.querySelectorAll('path')].map((p) => p.getAttribute('d'));

describe('the brand components', () => {
  it('SurfaceMark and SurfaceLockup match the brand asset paths', () => {
    const mark = paths('surface-mark.svg');
    const lockup = paths('surface-lockup-mono.svg');
    expect(mark).toHaveLength(2);
    expect(lockup).toHaveLength(3);
    expect(drawn(render(<SurfaceMark />))).toEqual(mark);
    expect(drawn(render(<SurfaceLockup />))).toEqual(lockup);
  });

  it('draws the colour mark in the brand colours and mono in currentColor', () => {
    const fills = (svg: Element) =>
      [...svg.querySelectorAll('path')].map((p) => p.getAttribute('fill'));
    expect(fills(render(<SurfaceMark />))).toEqual(['#2EC4BF', '#0A7A77']);
    expect(fills(render(<SurfaceMark mono />))).toEqual(['currentColor', 'currentColor']);
    expect(fills(render(<SurfaceLockup />))).toEqual(['#2EC4BF', '#0A7A77', 'currentColor']);
  });

  it('the mark is aria-hidden by default and role img with a title', () => {
    for (const decorative of [<SurfaceMark key="m" />, <SurfaceLockup key="l" />]) {
      const svg = render(decorative);
      expect(svg.getAttribute('aria-hidden')).toBe('true');
      expect(svg.getAttribute('focusable')).toBe('false');
      expect(svg.getAttribute('role')).toBeNull();
    }
    for (const named of [
      <SurfaceMark key="m" title="Surface" />,
      <SurfaceLockup key="l" title="Surface" />,
    ]) {
      const svg = render(named);
      expect(svg.getAttribute('role')).toBe('img');
      expect(svg.getAttribute('aria-label')).toBe('Surface');
      expect(svg.getAttribute('aria-hidden')).toBeNull();
      expect(svg.querySelector('title')?.textContent).toBe('Surface');
    }
  });

  it('sizes the mark from size and the lockup from its height', () => {
    expect(render(<SurfaceMark size={20} />).getAttribute('width')).toBe('20');
    const lockup = render(<SurfaceLockup height={24} />);
    expect(lockup.getAttribute('height')).toBe('24');
    expect(Number(lockup.getAttribute('width'))).toBeCloseTo((24 * 156.794) / 32, 3);
  });
});
