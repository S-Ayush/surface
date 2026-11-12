/**
 * The arithmetic of the virtual window (SPEC-012 §3.3 item 9, AC-6). Rows and group headers have
 * fixed heights, so the window comes from prefix sums and a binary search; nothing is measured.
 */

/** Row and header heights in px: the numbers behind `--row-height` and `--control-lg` (tested). */
export const ROW_HEIGHT = 36;
export const ROW_HEIGHT_COMPACT = 32;
export const GROUP_HEADER_HEIGHT = 32;
/** Rows kept mounted beyond each edge of the view. */
export const DEFAULT_OVERSCAN = 8;

/** `offsets[i]` is the top of item i; `offsets[n]` is the total height. */
export function buildOffsets(heights: ArrayLike<number>): Float64Array {
  const offsets = new Float64Array(heights.length + 1);
  for (let i = 0; i < heights.length; i++) {
    offsets[i + 1] = (offsets[i] ?? 0) + (heights[i] ?? 0);
  }
  return offsets;
}

/** The item that contains `y`: the last i with `offsets[i] <= y`, clamped to a real item. */
export function indexAt(offsets: ArrayLike<number>, y: number): number {
  const count = offsets.length - 1;
  if (count <= 0) return 0;
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if ((offsets[mid] ?? 0) <= y) low = mid;
    else high = mid - 1;
  }
  return low;
}

export interface WindowInput {
  offsets: ArrayLike<number>;
  scrollTop: number;
  viewportHeight: number;
  overscan?: number;
  /** The focused row: always mounted, even when scrolled out of view. */
  pinnedIndex?: number | null;
  /** Ascending indices of group headers; the one above the view sticks to the top. */
  headerIndices?: readonly number[];
}

export interface VirtualWindow {
  /** The contiguous range `[start, end)` that is in view plus the overscan. */
  start: number;
  end: number;
  /** Every index to mount, ascending: the range, the pinned row and the sticky header. */
  indices: number[];
  /** The header that sticks, and its `top` (it is pushed up by the next header). */
  sticky: { index: number; top: number } | null;
  totalHeight: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** The last header whose top is at or above `scrollTop`, pushed up by the next one. */
export function stickyHeader(
  offsets: ArrayLike<number>,
  headerIndices: readonly number[],
  scrollTop: number,
): { index: number; top: number } | null {
  let low = 0;
  let high = headerIndices.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const index = headerIndices[mid] ?? 0;
    if ((offsets[index] ?? 0) <= scrollTop) {
      found = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  const index = headerIndices[found];
  if (index === undefined) return null;
  const natural = offsets[index] ?? 0;
  const height = (offsets[index + 1] ?? 0) - natural;
  const nextIndex = headerIndices[found + 1];
  const limit =
    nextIndex === undefined ? Number.POSITIVE_INFINITY : (offsets[nextIndex] ?? 0) - height;
  return { index, top: Math.max(natural, Math.min(scrollTop, limit)) };
}

export function computeWindow(input: WindowInput): VirtualWindow {
  const {
    offsets,
    viewportHeight,
    overscan = DEFAULT_OVERSCAN,
    pinnedIndex,
    headerIndices,
  } = input;
  const count = offsets.length - 1;
  const totalHeight = offsets[count] ?? 0;
  if (count <= 0) return { start: 0, end: 0, indices: [], sticky: null, totalHeight };

  const scrollTop = clamp(input.scrollTop, 0, Math.max(0, totalHeight - viewportHeight));
  const first = indexAt(offsets, scrollTop);
  const last = indexAt(offsets, scrollTop + Math.max(viewportHeight, 0));
  const start = Math.max(0, first - overscan);
  const end = Math.min(count, last + 1 + overscan);

  const extra = new Set<number>();
  if (
    pinnedIndex !== undefined &&
    pinnedIndex !== null &&
    pinnedIndex >= 0 &&
    pinnedIndex < count
  ) {
    extra.add(pinnedIndex);
  }
  const sticky = headerIndices ? stickyHeader(offsets, headerIndices, scrollTop) : null;
  if (sticky) extra.add(sticky.index);

  const indices: number[] = [];
  const outside = [...extra].filter((i) => i < start || i >= end).sort((a, b) => a - b);
  let next = 0;
  for (let i = start; i < end; i++) {
    while (next < outside.length && (outside[next] ?? 0) < i) indices.push(outside[next++] ?? 0);
    indices.push(i);
  }
  while (next < outside.length) indices.push(outside[next++] ?? 0);
  return { start, end, indices, sticky, totalHeight };
}

/** The `scrollTop` that brings item `index` fully into view with the least movement. */
export function scrollTopFor(
  offsets: ArrayLike<number>,
  index: number,
  scrollTop: number,
  viewportHeight: number,
  /** Height kept free at the top for the sticky header. */
  topInset = 0,
): number {
  const top = offsets[index] ?? 0;
  const bottom = offsets[index + 1] ?? top;
  if (top - topInset < scrollTop) return Math.max(0, top - topInset);
  if (bottom > scrollTop + viewportHeight) return bottom - viewportHeight;
  return scrollTop;
}
