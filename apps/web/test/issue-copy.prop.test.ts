// PLAN-012 S6 (SPEC-012 AC-10): for any title, the URL slug and the git branch name are lowercase
// ASCII and bounded, the same title always gives the same text, and a pending issue never copies.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { COPY_ITEMS, planCopy } from '../src/features/issues/copy-actions.js';

const ORIGIN = 'https://s.example';

describe('copy actions, for any title', () => {
  it('the URL slug and the branch name are lowercase ASCII, bounded and stable', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 300 }), (title) => {
        const target = { identifier: 'ENG-42', title };
        const url = planCopy('url', target, ORIGIN, 'Ada Lovelace');
        const branch = planCopy('branch', target, ORIGIN, 'Ada Lovelace');
        expect(url).toEqual(planCopy('url', target, ORIGIN, 'Ada Lovelace'));
        if (!url.ok || !branch.ok) throw new Error('a live issue always copies');
        const slug = url.text.slice(`${ORIGIN}/issue/ENG-42`.length).replace(/^\//, '');
        expect(slug).toMatch(/^[a-z0-9-]{0,60}$/);
        expect(branch.text).toMatch(/^[a-z0-9-/]+$/);
      }),
    );
  });

  it('a pending issue copies nothing, whatever the title', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), fc.constantFrom(...COPY_ITEMS), (title, item) => {
        expect(planCopy(item.kind, { identifier: null, title }, ORIGIN, 'a').ok).toBe(false);
      }),
    );
  });
});
