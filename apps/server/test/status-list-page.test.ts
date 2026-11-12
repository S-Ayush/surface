// PLAN-010 S2: `status.list`'s default order (category, then position) pages with an opaque keyset
// cursor on the last row's (category rank, position, id), like SPEC-003 §7.1's: a status added or
// removed between two pages never repeats or skips one that existed throughout.
import { describe, expect, it } from 'vitest';
import { SurfaceError } from '../src/executor/errors.js';
import { pageStatuses } from '../src/handlers/statuses/page.js';

const s = (id: string, category: 'backlog' | 'started' | 'completed', position: string) => ({
  id,
  category,
  position,
});

const ALL = [
  s('b1', 'backlog', 'a0'),
  s('s1', 'started', 'a0'),
  s('s2', 'started', 'a1'),
  s('s3', 'started', 'a2'),
  s('c1', 'completed', 'a0'),
];

describe('pageStatuses', () => {
  it('cuts the list in display order and says whether more follow', () => {
    const first = pageStatuses(ALL, 2, undefined);
    expect(first.nodes.map((n) => n.id)).toEqual(['b1', 's1']);
    expect(first.hasNextPage).toBe(true);
    const second = pageStatuses(ALL, 2, first.endCursor ?? undefined);
    expect(second.nodes.map((n) => n.id)).toEqual(['s2', 's3']);
    const third = pageStatuses(ALL, 2, second.endCursor ?? undefined);
    expect(third.nodes.map((n) => n.id)).toEqual(['c1']);
    expect(third.hasNextPage).toBe(false);
  });

  it('keeps its place when statuses change between pages', () => {
    const first = pageStatuses(ALL, 2, undefined);
    // s1 (the cursor's row) is deleted and a status is added before the cursor and one after it.
    const changed = [
      s('new0', 'backlog', 'Zz'),
      ...ALL.filter((n) => n.id !== 's1'),
      s('new1', 'started', 'a1V'),
    ];
    const second = pageStatuses(changed, 10, first.endCursor ?? undefined);
    expect(second.nodes.map((n) => n.id)).toEqual(['s2', 'new1', 's3', 'c1']);
  });

  it('gives a cursor that is opaque and says nothing of the rows', () => {
    const { endCursor } = pageStatuses(ALL, 2, undefined);
    expect(endCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(endCursor).not.toContain('s1');
  });

  it('refuses a cursor that is not one of this list’s', () => {
    for (const cursor of ['o:3', 'not a cursor', 'e30']) {
      expect(() => pageStatuses(ALL, 2, cursor)).toThrow(SurfaceError);
    }
  });

  it('has no cursor for an empty page', () => {
    expect(pageStatuses([], 5, undefined)).toEqual({
      nodes: [],
      hasNextPage: false,
      endCursor: null,
    });
  });
});
