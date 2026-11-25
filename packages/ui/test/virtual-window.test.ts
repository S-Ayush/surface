// SPEC-012 AC-6 (unit part): the window renders the rows in view plus a fixed overscan, whatever
// the list's length, keeps the pinned row mounted and sticks the header above the view.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  GROUP_HEADER_HEIGHT,
  ROW_HEIGHT,
  ROW_HEIGHT_COMPACT,
  buildOffsets,
  computeWindow,
  indexAt,
  scrollTopFor,
  stickyHeader,
} from '../src/components/VirtualList/window.js';
import { componentTokens } from '../tokens/component.js';

const px = (token: string) => Number.parseInt(componentTokens[token] ?? '', 10);

describe('layout constants', () => {
  it('equal the design tokens they stand for (CSS and arithmetic must agree)', () => {
    expect(ROW_HEIGHT).toBe(px('row-height'));
    expect(ROW_HEIGHT_COMPACT).toBe(px('row-height-compact'));
    expect(GROUP_HEADER_HEIGHT).toBe(px('group-header-height'));
  });
});

describe('density tokens', () => {
  it('row and header heights follow the density tokens (44 comfortable, 36 compact, 36 header)', () => {
    expect([ROW_HEIGHT, ROW_HEIGHT_COMPACT, GROUP_HEADER_HEIGHT]).toEqual([44, 36, 36]);
    expect(buildOffsets([GROUP_HEADER_HEIGHT, ROW_HEIGHT, ROW_HEIGHT_COMPACT]).at(-1)).toBe(116);
  });
});

describe('buildOffsets and indexAt', () => {
  it('builds prefix sums and finds the item containing a position', () => {
    const offsets = buildOffsets([36, 44, 44, 36]);
    expect(Array.from(offsets)).toEqual([0, 36, 80, 124, 160]);
    expect(indexAt(offsets, 0)).toBe(0);
    expect(indexAt(offsets, 35.9)).toBe(0);
    expect(indexAt(offsets, 36)).toBe(1);
    expect(indexAt(offsets, 159)).toBe(3);
    expect(indexAt(offsets, 9999)).toBe(3);
    expect(indexAt(offsets, -5)).toBe(0);
  });

  it('copes with an empty list', () => {
    const win = computeWindow({ offsets: buildOffsets([]), scrollTop: 0, viewportHeight: 500 });
    expect(win.indices).toEqual([]);
    expect(win.totalHeight).toBe(0);
  });
});

describe('computeWindow', () => {
  const rows = (n: number) => buildOffsets(Array.from({ length: n }, () => ROW_HEIGHT));

  it('renders the rows in view plus the overscan at the top of a long list', () => {
    const win = computeWindow({
      offsets: rows(10_000),
      scrollTop: 0,
      viewportHeight: 10 * ROW_HEIGHT,
      overscan: 5,
    });
    // 10 rows in view rows fully in view; the row at the bottom edge counts; then 5 more.
    expect(win.start).toBe(0);
    expect(win.end).toBe(10 + 1 + 5);
    expect(win.indices).toHaveLength(16);
    expect(win.totalHeight).toBe(10_000 * ROW_HEIGHT);
  });

  it('starts the overscan above the first visible row when scrolled', () => {
    const win = computeWindow({
      offsets: rows(1_000),
      scrollTop: ROW_HEIGHT * 100,
      viewportHeight: 10 * ROW_HEIGHT,
      overscan: 5,
    });
    expect(win.start).toBe(95);
    expect(win.indices[0]).toBe(95);
    expect(win.indices.at(-1)).toBe(100 + 10 + 5);
  });

  it('clamps at the end of the list', () => {
    const win = computeWindow({
      offsets: rows(50),
      scrollTop: 1_000_000,
      viewportHeight: 10 * ROW_HEIGHT,
      overscan: 5,
    });
    expect(win.end).toBe(50);
    expect(win.indices.at(-1)).toBe(49);
  });

  it('keeps the pinned row mounted when it is far outside the window, in order', () => {
    const above = computeWindow({
      offsets: rows(1_000),
      scrollTop: ROW_HEIGHT * 500,
      viewportHeight: 10 * ROW_HEIGHT,
      overscan: 2,
      pinnedIndex: 3,
    });
    expect(above.indices[0]).toBe(3);
    expect(above.indices).toEqual([...above.indices].sort((a, b) => a - b));
    const below = computeWindow({
      offsets: rows(1_000),
      scrollTop: 0,
      viewportHeight: 10 * ROW_HEIGHT,
      overscan: 2,
      pinnedIndex: 900,
    });
    expect(below.indices.at(-1)).toBe(900);
    expect(new Set(below.indices).size).toBe(below.indices.length);
  });

  it('ignores a pinned index that is not in the list', () => {
    const win = computeWindow({
      offsets: rows(20),
      scrollTop: 0,
      viewportHeight: 10 * ROW_HEIGHT,
      pinnedIndex: 99,
    });
    expect(win.indices.every((i) => i < 20)).toBe(true);
  });

  it('mixes header and row heights', () => {
    // header, 3 rows, header, 3 rows
    const heights = [32, 36, 36, 36, 32, 36, 36, 36];
    const win = computeWindow({
      offsets: buildOffsets(heights),
      scrollTop: 100,
      viewportHeight: 40,
      overscan: 0,
    });
    // 100 is inside item 2 (68..104) and 140 inside item 4 (136..172), so [2, 5)
    expect(win.start).toBe(2);
    expect(win.end).toBe(5);
  });
});

describe('stickyHeader', () => {
  // headers at 0 (height 32) and 4 (height 32)
  const offsets = buildOffsets([32, 36, 36, 36, 32, 36, 36]);
  const headers = [0, 4];

  it('is null above the first header', () => {
    expect(stickyHeader(buildOffsets([36, 32, 36]), [1], 10)).toBeNull();
  });

  it('sticks the header above the view to the top', () => {
    expect(stickyHeader(offsets, headers, 50)).toEqual({ index: 0, top: 50 });
  });

  it('is pushed up by the next header', () => {
    // the next header is at 140: the first one leaves at 140 - 32 = 108
    expect(stickyHeader(offsets, headers, 120)).toEqual({ index: 0, top: 108 });
  });

  it('hands over to the next header once it reaches the top', () => {
    expect(stickyHeader(offsets, headers, 140)).toEqual({ index: 4, top: 140 });
  });

  it('is mounted by the window even when it is far above the view', () => {
    const big = buildOffsets(Array.from({ length: 500 }, (_, i) => (i % 50 === 0 ? 32 : 36)));
    const headerIndices = Array.from({ length: 10 }, (_, i) => i * 50);
    const win = computeWindow({
      offsets: big,
      scrollTop: big[275] ?? 0,
      viewportHeight: 10 * ROW_HEIGHT,
      overscan: 2,
      headerIndices,
    });
    expect(win.sticky?.index).toBe(250);
    expect(win.indices).toContain(250);
  });
});

describe('scrollTopFor', () => {
  const offsets = buildOffsets(Array.from({ length: 100 }, () => ROW_HEIGHT));
  it('does not move for a row already in view', () => {
    expect(scrollTopFor(offsets, 5, 0, 360)).toBe(0);
  });
  it('moves the least distance to show a row below the view', () => {
    expect(scrollTopFor(offsets, 20, 0, 360)).toBe(21 * ROW_HEIGHT - 360);
  });
  it('moves up to show a row above the view, leaving room for the sticky header', () => {
    expect(scrollTopFor(offsets, 2, 1000, 360, 32)).toBe(2 * ROW_HEIGHT - 32);
  });
});

describe('computeWindow (properties)', () => {
  const heights = fc.array(fc.constantFrom(ROW_HEIGHT, ROW_HEIGHT_COMPACT, GROUP_HEADER_HEIGHT), {
    maxLength: 3_000,
  });

  it('mounts a bounded number of items, whatever the length (AC-6)', () => {
    fc.assert(
      fc.property(
        heights,
        fc.nat(200_000),
        fc.integer({ min: 100, max: 1_200 }),
        fc.integer({ min: 0, max: 12 }),
        (list, scrollTop, viewport, overscan) => {
          const win = computeWindow({
            offsets: buildOffsets(list),
            scrollTop,
            viewportHeight: viewport,
            overscan,
          });
          const minHeight = Math.min(GROUP_HEADER_HEIGHT, ROW_HEIGHT_COMPACT);
          const bound = Math.ceil(viewport / minHeight) + 2 + 2 * overscan;
          expect(win.indices.length).toBeLessThanOrEqual(bound);
        },
      ),
    );
  });

  it('always covers every item that is in view, and lists indices ascending and unique', () => {
    fc.assert(
      fc.property(
        heights.filter((l) => l.length > 0),
        fc.nat(200_000),
        fc.integer({ min: 100, max: 1_200 }),
        fc.nat(),
        (list, scrollTop, viewport, pinned) => {
          const offsets = buildOffsets(list);
          const win = computeWindow({
            offsets,
            scrollTop,
            viewportHeight: viewport,
            overscan: 3,
            pinnedIndex: pinned % list.length,
          });
          const top = Math.min(scrollTop, Math.max(0, (offsets[list.length] ?? 0) - viewport));
          for (let i = 0; i < list.length; i++) {
            const itemTop = offsets[i] ?? 0;
            const itemBottom = offsets[i + 1] ?? 0;
            if (itemBottom > top && itemTop < top + viewport) expect(win.indices).toContain(i);
          }
          expect([...new Set(win.indices)]).toEqual(win.indices);
          expect([...win.indices].sort((a, b) => a - b)).toEqual(win.indices);
          expect(win.indices).toContain(pinned % list.length);
        },
      ),
    );
  });
});
