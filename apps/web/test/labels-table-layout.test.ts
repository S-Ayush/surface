// PLAN-016 visual pass: the labels table keeps its Name column readable on narrow screens
// (SPEC-005 AC-16) and shows dates the way the issue list does.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dayText, fullDayText } from '../src/features/labels/model.js';

const css = readFileSync(
  new URL('../src/features/labels/labels.module.css', import.meta.url),
  'utf8',
);
const rule = (selector: string) =>
  new RegExp(`(?:^|\\n)${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';

describe('labels table dates', () => {
  const now = new Date(2026, 10, 25, 12);
  it('shows a short day, with the year when it is not this year', () => {
    expect(dayText('2026-11-13T10:00:00.000Z', now)).toMatch(/^Nov 1[2-4]$/);
    expect(dayText('2025-03-02T12:00:00.000Z', now)).toBe('Mar 2, 2025');
  });
  it('shows "—" for no date and the long day as the tooltip', () => {
    expect(dayText(null, now)).toBe('—');
    expect(fullDayText('2026-11-13T12:00:00.000Z')).toBe('November 13, 2026');
    expect(fullDayText(null)).toBeUndefined();
  });
});

describe('labels table css', () => {
  it('the name never shrinks below a minimum and the description truncates', () => {
    expect(rule('\\.name')).toMatch(/min-width:\s*var\(--labels-name-min\)/);
    expect(rule('\\.name')).toMatch(/flex:\s*2 0 var\(--labels-name-min\)/);
    expect(rule('\\.description')).toMatch(/text-overflow:\s*ellipsis/);
    expect(css).toMatch(/\.descriptionText \{[^}]*text-overflow:\s*ellipsis/);
  });
  it('hides the secondary columns below 768px and keeps Issues', () => {
    const narrow = /@media \(width < 768px\)\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? '';
    for (const column of ['used-in', 'last-applied', 'created']) {
      expect(narrow).toContain(`[data-column='${column}']`);
    }
    expect(narrow).not.toContain("[data-column='issues']");
    expect(narrow).toMatch(/flex-wrap:\s*wrap/);
  });
});
