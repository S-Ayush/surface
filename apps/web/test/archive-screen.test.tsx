/**
 * @vitest-environment jsdom
 */
// PLAN-015 S4 (SPEC-015 §3.3, §7; AC-14, AC-19, E23): the team archive page's two tabs read the
// server, never subscribe the team, list rows flat with the archive or deletion day, restore by
// `#` (the row leaves at once). The team list's "N archived issues" is
// `archived-count-footer.test.tsx`.
import { overlayManager } from '@surface/ui';
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { focusMemory } from '../src/features/issues/focus-model.js';
import { ARCHIVE_PAGE_SIZE } from '../src/features/archive/archive-source.js';
import { deletedNode, summary } from './archive-fixtures.js';
import { IssueApp, mountLists, type Mounted } from './issue-list-harness.js';

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
  overlayManager.clear();
});

/** Lets the answers the page asked for land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const rowNames = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLElement>('[role="row"]')].map((row) => row.textContent);

const DAY = 86_400_000;

describe('archive page, Issues tab', () => {
  it('reads the archived issues from the server, newest archived first, in pages of 50 (§3.3 item 4)', async () => {
    const app = new IssueApp([]);
    app.api.archived = [
      summary(7, { title: 'Old flaky test', archivedAt: '2026-11-10T10:00:00.000Z' }),
    ];
    mounted = await mountLists(app, '/team/ENG/archive');
    await settle();
    expect(app.api.calls).toContainEqual({
      op: 'issue.list',
      input: {
        team: 'ENG',
        limit: ARCHIVE_PAGE_SIZE,
        includeArchived: true,
        filter: { field: 'archivedAt', op: 'exists', value: true },
        orderBy: { field: 'archivedAt', direction: 'desc' },
      },
    });
    expect(mounted.host.textContent).toContain('Archived issues');
    expect(mounted.host.textContent).toContain('Old flaky test');
    // A flat list: no group header row, and the date shown is the archive day.
    expect(mounted.host.querySelectorAll('[role="row"]')).toHaveLength(1);
    expect(rowNames(mounted.host)[0]).toContain('Nov 10');
  });

  it('never subscribes the team: opening the page calls no openTeam (§3.3 item 6)', async () => {
    const app = new IssueApp([]);
    app.api.archived = [summary(7, { archivedAt: '2026-11-10T10:00:00.000Z' })];
    mounted = await mountLists(app, '/team/ENG/archive');
    await settle();
    expect(app.opened).toEqual([]);
  });

  it('shows "No matching issues" when the team has none (§3.3 item 3)', async () => {
    const app = new IssueApp([]);
    mounted = await mountLists(app, '/team/ENG/archive');
    await settle();
    expect(mounted.host.textContent).toContain('No matching issues');
  });

  it('offline, shows "Available when online" and asks nothing (E23)', async () => {
    const app = new IssueApp([]);
    app.setOnline(false);
    mounted = await mountLists(app, '/team/ENG/archive');
    await settle();
    expect(mounted.host.textContent).toContain('Available when online');
    expect(app.api.calls.filter((call) => call.op === 'issue.list')).toEqual([]);
  });

  it('links both tabs, with the current one marked', async () => {
    const app = new IssueApp([]);
    mounted = await mountLists(app, '/team/ENG/archive');
    await settle();
    const tabs = [...mounted.host.querySelectorAll('nav[aria-label="Archive views"] a')];
    expect(tabs.map((tab) => [tab.textContent, tab.getAttribute('href')])).toEqual([
      ['Issues', '/team/ENG/archive'],
      ['Recently deleted issues', '/team/ENG/archive/recently-deleted'],
    ]);
    expect(tabs[0]?.getAttribute('aria-current')).toBe('page');
  });
});

describe('archive page, Recently deleted issues tab', () => {
  it('reads issue.listDeleted and shows the deletion day (§3.3)', async () => {
    const app = new IssueApp([]);
    const deletedAt = new Date(Date.now() - DAY).toISOString();
    app.api.deleted = [deletedNode(9, deletedAt, { title: 'Wrong issue' })];
    mounted = await mountLists(app, '/team/ENG/archive/recently-deleted');
    await settle();
    expect(app.api.calls).toContainEqual({
      op: 'issue.listDeleted',
      input: { team: 'ENG', limit: ARCHIVE_PAGE_SIZE },
    });
    expect(mounted.host.textContent).toContain('Wrong issue');
  });

  it('restores the focused row with # (AC-14): the row leaves at once, the toast finishes on the confirmation', async () => {
    const app = new IssueApp([]);
    const deletedAt = new Date(Date.now() - DAY).toISOString();
    app.api.deleted = [deletedNode(9, deletedAt, { title: 'Wrong issue' })];
    mounted = await mountLists(app, '/team/ENG/archive/recently-deleted');
    await settle();
    const registry = mounted.commands();
    expect(registry.isAvailable('issue:restore')).toBe(true);
    // The server's next answer no longer has it.
    app.api.deleted = [];
    await act(async () => {
      registry.run('issue:restore');
      await Promise.resolve();
    });
    expect(app.dispatched).toContainEqual({
      op: 'issue.restore',
      input: { issue: summary(9).id },
    });
    await settle();
    expect(mounted.host.textContent).not.toContain('Wrong issue');
    expect(overlayManager.getSnapshot().visibleToasts.map((t) => t.message)).toEqual([
      'Restored ENG-9',
    ]);
  });

  it('offers no Restore on a row past its purgeAfter (§3.4)', async () => {
    const app = new IssueApp([]);
    // Answered a moment before it expired: the client's filter leaves it out too.
    const deletedAt = new Date(Date.now() - 31 * DAY).toISOString();
    app.api.deleted = [deletedNode(9, deletedAt, { title: 'Too old' })];
    mounted = await mountLists(app, '/team/ENG/archive/recently-deleted');
    await settle();
    expect(mounted.host.textContent).not.toContain('Too old');
    expect(mounted.commands().isAvailable('issue:restore')).toBe(false);
  });
});
