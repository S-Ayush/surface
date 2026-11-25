/**
 * @vitest-environment jsdom
 */
// PLAN-016 S4 (design-system §4): the list draws keyboard focus only after a key press, and a
// pointer press hides it again. Nothing looks focused on first load.
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { ENG_TODO } from './issue-list-fixtures.js';
import { IssueApp, issue, mountLists, type Mounted } from './issue-list-harness.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
class NoResize {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= NoResize;
window.scrollTo = () => undefined;
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 600 });

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  localStorage.clear();
});

const dispatch = async (event: Event) => {
  await act(async () => {
    document.body.dispatchEvent(event);
    await Promise.resolve();
  });
};

describe('list focus treatment', () => {
  it('shows focus only after a key press and hides it again after a pointer press', async () => {
    mounted = await mountLists(
      new IssueApp([issue({ title: 'Alpha', number: 1, statusId: ENG_TODO })]),
      '/team/ENG/issues',
    );
    const grid = mounted.host;
    // The list took focus on arrival, so a row is focused but nothing is drawn as focused.
    expect(grid.querySelector('[data-focused]')).not.toBeNull();
    expect(grid.querySelector('[data-focus-visible]')).toBeNull();
    await dispatch(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    expect(grid.querySelector('[data-focus-visible]')).not.toBeNull();
    await dispatch(new Event('pointerdown', { bubbles: true }));
    expect(grid.querySelector('[data-focus-visible]')).toBeNull();
    expect(grid.querySelector('[data-focused]')).not.toBeNull();
  });
});
