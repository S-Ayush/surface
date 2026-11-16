import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Ref,
  type ReactNode,
} from 'react';
import { cx } from '../../internal/cx.js';
import styles from './VirtualList.module.css';
import { DEFAULT_OVERSCAN, buildOffsets, computeWindow, scrollTopFor } from './window.js';

export interface VirtualListHandle {
  /** Scrolls the item into view (no-op when it already is). */
  scrollToIndex(index: number): void;
}

export interface VirtualItemProps {
  index: number;
  /** Absolute position and height. Pass it to the row as `style`. */
  style: CSSProperties;
  /** Roving tabindex: 0 for the pinned (focused) row, or the first item when none is pinned. */
  tabIndex: 0 | -1;
}

export type VirtualListProps = {
  count: number;
  /**
   * Height in px of item `index` (fixed per kind: row, compact row, group header). Must be
   * stable (`useCallback` or module-level): a new function rebuilds every offset.
   */
  itemHeight: (index: number) => number;
  /** Whether item `index` is a group header. Must be stable, like `itemHeight`. */
  isHeader?: (index: number) => boolean;
  renderItem: (item: VirtualItemProps) => ReactNode;
  /** The focused row: kept mounted while scrolled out of view, and the roving tab stop. */
  pinnedIndex?: number | null;
  overscan?: number;
  /** Used until the viewport is measured (and in server rendering). */
  initialViewportHeight?: number;
  initialScrollTop?: number;
  onScrollTopChange?: (scrollTop: number) => void;
  /**
   * The items rendered changed: `start` to `end` (exclusive), the viewport plus the overscan, in
   * an effect after the render. Must be stable, like `itemHeight`. For prefetching what is shown.
   */
  onRangeChange?: (start: number, end: number) => void;
  /** Names the grid ("Issues in ENG"). */
  'aria-label': string;
  className?: string;
  ref?: Ref<VirtualListHandle>;
};

/**
 * A windowed `treegrid` (design-system §2.5, SPEC-012 §7.4: group headers are expandable rows, which a plain `grid` can't express): `aria-rowcount` counts every item, and
 * the items you render must carry `aria-rowindex={index + 1}`. Heights are fixed, so the window is
 * arithmetic (`window.ts`); the viewport is measured in an observer, never during render.
 */
export function VirtualList({
  count,
  itemHeight,
  isHeader,
  renderItem,
  pinnedIndex = null,
  overscan = DEFAULT_OVERSCAN,
  initialViewportHeight = 600,
  initialScrollTop = 0,
  onScrollTopChange,
  onRangeChange,
  'aria-label': ariaLabel,
  className,
  ref,
}: VirtualListProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(initialScrollTop);
  const [viewportHeight, setViewportHeight] = useState(initialViewportHeight);

  // `itemHeight` and `isHeader` are real deps, so they must be stable (see the prop docs): an
  // inline arrow would rebuild the offsets (O(count)) on every render, and a scroll event
  // causes one.
  const { offsets, headerIndices } = useMemo(() => {
    const heights = new Float64Array(count);
    const headers: number[] = [];
    for (let i = 0; i < count; i++) {
      heights[i] = itemHeight(i);
      if (isHeader?.(i)) headers.push(i);
    }
    return { offsets: buildOffsets(heights), headerIndices: headers };
  }, [count, itemHeight, isHeader]);

  const win = computeWindow({
    offsets,
    scrollTop,
    viewportHeight,
    overscan,
    pinnedIndex,
    headerIndices,
  });

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    setViewportHeight(element.clientHeight || initialViewportHeight);
    element.scrollTop = initialScrollTop;
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() =>
      setViewportHeight(element.clientHeight || initialViewportHeight),
    );
    observer.observe(element);
    return () => observer.disconnect();
    // Only the first scroll position is applied; later ones come from the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    onRangeChange?.(win.start, win.end);
  }, [onRangeChange, win.start, win.end]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex(index: number) {
        const element = scroller.current;
        if (!element || index < 0 || index >= count) return;
        const sticky =
          headerIndices.length > 0 && !headerIndices.includes(index)
            ? itemHeight(headerIndices[0] ?? 0)
            : 0;
        const next = scrollTopFor(
          offsets,
          index,
          element.scrollTop,
          element.clientHeight || viewportHeight,
          sticky,
        );
        if (next !== element.scrollTop) element.scrollTop = next;
      },
    }),
    [count, headerIndices, itemHeight, offsets, viewportHeight],
  );

  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    setScrollTop(element.scrollTop);
    onScrollTopChange?.(element.scrollTop);
  }, [onScrollTopChange]);

  const tabStop =
    pinnedIndex !== null && pinnedIndex >= 0 && pinnedIndex < count
      ? pinnedIndex
      : (win.indices[0] ?? 0);

  return (
    <div ref={scroller} className={cx(styles.scroller, className)} onScroll={onScroll}>
      <div
        role="treegrid"
        aria-label={ariaLabel}
        aria-rowcount={count}
        className={styles.grid}
        style={{ height: win.totalHeight }}
      >
        {win.indices.map((index) => {
          // The sticky header is positioned from React state, so in a fast scroll it can lag the
          // native scroll by a frame (it jumps, never flickers). CSS `position: sticky` can't
          // work here: the rows are absolutely positioned in a windowed list. Accepted for M1.
          const sticky = win.sticky?.index === index;
          const top = sticky ? (win.sticky?.top ?? 0) : (offsets[index] ?? 0);
          return (
            <Item
              key={index}
              index={index}
              top={top}
              height={itemHeight(index)}
              sticky={sticky}
              tabIndex={index === tabStop ? 0 : -1}
              renderItem={renderItem}
            />
          );
        })}
      </div>
    </div>
  );
}

function Item({
  index,
  top,
  height,
  sticky,
  tabIndex,
  renderItem,
}: {
  index: number;
  top: number;
  height: number;
  sticky: boolean;
  tabIndex: 0 | -1;
  renderItem: (item: VirtualItemProps) => ReactNode;
}) {
  const style: CSSProperties = {
    position: 'absolute',
    insetInline: 0,
    top,
    height,
    ...(sticky ? { zIndex: 'var(--z-sticky)' } : null),
  };
  return renderItem({ index, style, tabIndex });
}
