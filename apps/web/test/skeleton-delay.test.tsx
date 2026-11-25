/**
 * @vitest-environment jsdom
 */
// PLAN-016 S8 (design-system §4 "Loading"): the list skeleton paints only after 150 ms, so a fast
// load never flashes it. The status text for screen readers is there from the start.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ListSkeleton } from '../src/features/issues/ListParts.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.useRealTimers();
});

describe('ListSkeleton', () => {
  it('skeleton shows after 150ms with fake timers', () => {
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root?.render(<ListSkeleton />));
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Loading…');
    expect(host.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(0);
    act(() => {
      vi.advanceTimersByTime(149);
    });
    expect(host.querySelectorAll('span[aria-hidden="true"]')).toHaveLength(0);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(host.querySelectorAll('span[aria-hidden="true"]').length).toBeGreaterThan(0);
  });
});
