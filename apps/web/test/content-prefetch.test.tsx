/**
 * @vitest-environment jsdom
 */
// PLAN-011 S7 (SPEC-011 §5.4): what the app prefetches. The list asks for the rows it shows and a
// row under the pointer; the shell, for the open issues assigned to the user, most recently
// updated first. The store's debounce, hover delay and request limits are sync-client's
// (`content-prefetch.test.ts`); here the fake store records what it was asked.
import { PREFETCH_ASSIGNED } from '@surface/sync-client';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { assignedPrefetchIds } from '../src/features/issues/content-prefetch.js';
import { ContentPrefetchHost } from '../src/features/issues/ContentPrefetchHost.js';
import { focusMemory } from '../src/features/issues/focus-model.js';
import { ENG_CANCELED, ENG_DOING, ENG_DONE, ENG_TODO, ME, OTHER } from './issue-list-fixtures.js';
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
  focusMemory.clear();
  localStorage.clear();
});

const at = (day: number) => `2026-11-${String(day).padStart(2, '0')}T12:00:00.000Z`;

describe('assignedPrefetchIds', () => {
  const categories = new Map([
    [ENG_TODO, 'unstarted' as const],
    [ENG_DOING, 'started' as const],
    [ENG_DONE, 'completed' as const],
    [ENG_CANCELED, 'canceled' as const],
  ]);

  it('takes the open issues assigned to the user, most recently updated first', () => {
    const old = issue({ assigneeId: ME, updatedAt: at(1) });
    const recent = issue({ assigneeId: ME, statusId: ENG_DOING, updatedAt: at(9) });
    const done = issue({ assigneeId: ME, statusId: ENG_DONE, updatedAt: at(10) });
    const canceled = issue({ assigneeId: ME, statusId: ENG_CANCELED, updatedAt: at(10) });
    const theirs = issue({ assigneeId: OTHER, updatedAt: at(10) });
    const archived = issue({ assigneeId: ME, archivedAt: at(5), updatedAt: at(10) });
    const issues = [old, recent, done, canceled, theirs, archived];
    expect(assignedPrefetchIds(issues, categories, ME, 10)).toEqual([recent.id, old.id]);
  });

  it(`keeps at most the limit (${String(PREFETCH_ASSIGNED)} in the app)`, () => {
    const issues = Array.from({ length: 5 }, (_, n) =>
      issue({ assigneeId: ME, updatedAt: at(n + 1) }),
    );
    expect(assignedPrefetchIds(issues, categories, ME, 2)).toEqual([issues[4]?.id, issues[3]?.id]);
  });
});

describe('the issue list', () => {
  it('asks the store to prefetch the rows it shows, in order', async () => {
    const first = issue({ title: 'First', priority: 1 });
    const second = issue({ title: 'Second', priority: 2 });
    const done = issue({ title: 'Done one', statusId: ENG_DONE });
    const app = new IssueApp([second, first, done]);
    mounted = await mountLists(app, '/team/ENG/issues');
    // Done is collapsed: its row isn't shown, so it isn't prefetched.
    expect([...app.content.lists.values()]).toEqual([[first.id, second.id]]);
  });

  it('asks the store to prefetch a row the pointer enters', async () => {
    const one = issue({ title: 'Hover me' });
    const app = new IssueApp([one]);
    mounted = await mountLists(app, '/team/ENG/issues');
    const row = [...mounted.host.querySelectorAll('[role="row"]')].find((element) =>
      element.textContent.includes('Hover me'),
    );
    await act(async () => {
      row?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
      await Promise.resolve();
    });
    expect(app.content.hovered).toEqual([one.id]);
  });
});

describe('after start', () => {
  it('prefetches the open issues assigned to the user, most recently updated first', async () => {
    const mine = issue({ assigneeId: ME, updatedAt: at(3) });
    const newer = issue({ assigneeId: ME, updatedAt: at(7) });
    const closed = issue({ assigneeId: ME, statusId: ENG_DONE });
    const theirs = issue({ assigneeId: OTHER });
    const app = new IssueApp([mine, newer, closed, theirs]);
    mounted = await mountLists(app, '/my-issues', <ContentPrefetchHost />);
    expect(app.content.lists.get('assigned')).toEqual([newer.id, mine.id]);
  });
});
