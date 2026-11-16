/**
 * @vitest-environment jsdom
 */
// PLAN-010 S5, SPEC-010 §3.1 and §5 (D15, AC-26, AC-17, E8): the workflow page's issue counts come
// from the server's `issue.groupBy` by status, archived issues included, "—" until it answers and
// offline. Deleting a status the replica shows an issue on is a toast with no dialog and sends
// nothing; otherwise the dialog confirms and a server refusal is the shell's toast.
import type { IssueGroupByInput, SettingsReads } from '../src/features/teams/settings-reads.js';
import { overlayManager } from '@surface/ui';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowScreen } from '../src/features/statuses/WorkflowScreen.js';
import {
  DONE,
  ENG,
  EstimateApp,
  STARTED,
  TODO,
  pageTree,
  status,
  type ReplicaIssue,
} from './estimate-fixtures.js';
import { SILENT_READS } from './label-fixtures.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class NoResize {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= NoResize;
window.scrollTo = () => undefined;

let host: HTMLElement;
let root: Root | undefined;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
    await Promise.resolve();
  });
  root = undefined;
  host.remove();
  overlayManager.clear();
});

async function settle(change: () => void = () => undefined): Promise<void> {
  await act(async () => {
    change();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });
}

async function mount(app: EstimateApp, reads: SettingsReads): Promise<void> {
  const tree = await pageTree(app, page, reads);
  root = createRoot(host);
  await settle(() => root?.render(tree));
}

async function press(button: Element | null | undefined): Promise<void> {
  if (!(button instanceof HTMLElement)) throw new Error('no such button');
  await settle(() => {
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    button.click();
  });
}

const page = (): ReactNode => <WorkflowScreen params={{ key: 'ENG' }} />;

/** A fake `issue.groupBy` that answers `groups` and records what it was asked. */
function groupByReads(groups: readonly { key: string | null; count: number }[]) {
  const asked: IssueGroupByInput[] = [];
  const reads: SettingsReads = {
    ...SILENT_READS,
    issueGroupBy: (input) => {
      asked.push(input);
      return Promise.resolve({
        ok: true,
        result: { groups: groups.map((g) => ({ ...g, name: g.key ?? 'None' })) },
      });
    },
  };
  return { reads, asked };
}

/** The count cell of each status row, by status name. */
function counts(): Record<string, string> {
  const rows = [...document.querySelectorAll('[role="option"]')];
  return Object.fromEntries(
    rows.map((row) => [
      row.querySelector('[class*="rowTitle"]')?.textContent ?? '',
      row.querySelector('[class*="count"]')?.textContent ?? '',
    ]),
  );
}

const toasts = () => {
  const { visibleToasts, queuedToasts } = overlayManager.getSnapshot();
  return [...visibleToasts, ...queuedToasts].map((t) => t.message);
};

async function deleteFromMenu(status: string): Promise<void> {
  await press(document.querySelector(`button[aria-label="Actions for ${status}"]`));
  await press(
    [...document.querySelectorAll('[role="menuitem"]')].find(
      (el) => el.textContent?.trim() === 'Delete…',
    ),
  );
}

describe('the issue count per status (§3.1, §5)', () => {
  it('shows each status’s count from issue.groupBy by status, archived included, 0 for none', async () => {
    const { reads, asked } = groupByReads([
      { key: TODO, count: 12 },
      { key: STARTED, count: 1 },
    ]);
    await mount(new EstimateApp([ENG]), reads);
    expect(asked).toEqual([{ team: 'ENG', by: 'status', includeArchived: true }]);
    expect(counts()).toEqual({ Backlog: '0', Todo: '12', 'In Progress': '1', Done: '0' });
    expect(document.querySelector('[aria-label="1 issue"]')?.textContent).toBe('1');
    expect(document.querySelector('[aria-label="12 issues"]')?.textContent).toBe('12');
  });

  it('shows "—" until the server answers', async () => {
    await mount(new EstimateApp([ENG]), SILENT_READS);
    expect(Object.values(counts())).toEqual(['—', '—', '—', '—']);
  });

  it('shows "—" offline and asks nothing', async () => {
    const { reads, asked } = groupByReads([{ key: TODO, count: 3 }]);
    await mount(new EstimateApp([ENG]).goOffline(), reads);
    expect(asked).toEqual([]);
    expect(Object.values(counts())).toEqual(['—', '—', '—', '—']);
  });

  it('asks again once when the tab becomes visible, and not on focus alone', async () => {
    const { reads, asked } = groupByReads([{ key: TODO, count: 3 }]);
    await mount(new EstimateApp([ENG]), reads);
    await settle(() => window.dispatchEvent(new Event('focus')));
    expect(asked).toHaveLength(1);
    await settle(() => {
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(asked).toHaveLength(2);
  });

  it('shows "—" after a refused read', async () => {
    const reads: SettingsReads = {
      ...SILENT_READS,
      issueGroupBy: () =>
        Promise.resolve({ ok: false, code: 'NOT_FOUND', message: 'Team not found' }),
    };
    await mount(new EstimateApp([ENG]), reads);
    expect(Object.values(counts())).toEqual(['—', '—', '—', '—']);
  });
});

describe('deleting a status (§3.1 item 6, AC-17, E8)', () => {
  // A second Completed status, so deleting it is refused for its issues only (not as the last of
  // its category).
  const SHIPPED = '0192f0c1-7e5a-7b3c-9d4e-0000000000b5';
  const statuses = [status(SHIPPED, 'Shipped', 'completed', 'a1')];
  const issue = (id: string, extra: Partial<ReplicaIssue> = {}): ReplicaIssue => ({
    id: `0192f0c1-7e5a-7b3c-9d4e-0000000010${id}`,
    statusId: SHIPPED,
    ...extra,
  });
  const app = (options: ConstructorParameters<typeof EstimateApp>[3] = {}) =>
    new EstimateApp([ENG], {}, 'member', { statuses, ...options });
  const confirm = () =>
    press(
      [...(document.querySelector('[role="dialog"]')?.querySelectorAll('button') ?? [])].find(
        (b) => b.textContent === 'Delete',
      ),
    );

  it('toasts the refusal with the count, opens no dialog and sends nothing when the replica shows issues', async () => {
    const page = app({
      issues: [issue('01'), issue('02', { archivedAt: '2026-11-01T00:00:00.000Z' })],
    });
    await mount(page, SILENT_READS);
    await deleteFromMenu('Shipped');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(page.dispatched).toEqual([]);
    expect(toasts()).toEqual([
      'Can\'t delete the "Shipped" status. It has 2 issues (1 archived or recently deleted). Move them to another status first.',
    ]);
  });

  it('says the server’s count once it has answered, when it is larger than the replica’s', async () => {
    const issues = [issue('01'), issue('02', { archivedAt: '2026-11-01T00:00:00.000Z' })];
    const { reads } = groupByReads([{ key: SHIPPED, count: 7 }]);
    await mount(app({ issues }), reads);
    await deleteFromMenu('Shipped');
    expect(toasts()).toEqual([
      'Can\'t delete the "Shipped" status. It has 7 issues (1 archived or recently deleted). Move them to another status first.',
    ]);
  });

  it('keeps the replica’s count when the server’s is smaller (it leaves deleted issues out)', async () => {
    const issues = [issue('01'), issue('02', { deletedAt: '2026-11-01T00:00:00.000Z' })];
    const { reads } = groupByReads([{ key: SHIPPED, count: 1 }]);
    await mount(app({ issues }), reads);
    await deleteFromMenu('Shipped');
    expect(toasts()).toEqual([
      'Can\'t delete the "Shipped" status. It has 2 issues (1 archived or recently deleted). Move them to another status first.',
    ]);
  });

  it('asks to confirm when the replica shows none, then dispatches status.delete', async () => {
    const page = app({ issues: [issue('03', { statusId: TODO })] });
    await mount(page, SILENT_READS);
    await deleteFromMenu('Shipped');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Delete the "Shipped" status?',
    );
    await confirm();
    expect(page.dispatched).toEqual([
      { op: 'status.delete', input: { team: 'ENG', status: SHIPPED } },
    ]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('closes the dialog on the server’s refusal and leaves the toast to the shell', async () => {
    const page = app({
      refusal: {
        code: 'CONFLICT',
        message:
          'Can\'t delete the "Shipped" status. It has 4 issues. Move them to another status first.',
      },
    });
    await mount(page, SILENT_READS);
    await deleteFromMenu('Shipped');
    await confirm();
    expect(page.dispatched).toHaveLength(1);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // The shell's toast reports a server refusal (SPEC-002 §3.5); the page adds none of its own.
    expect(toasts()).toEqual([]);
  });

  it('toasts a change the store did not take', async () => {
    const page = app();
    await mount(page, SILENT_READS);
    await deleteFromMenu('Shipped');
    page.failure.message =
      'Changes cannot be saved yet. Wait for the workspace to load, then try again.';
    await confirm();
    expect(toasts()).toEqual([
      'Changes cannot be saved yet. Wait for the workspace to load, then try again.',
    ]);
  });

  it('leaves the other refusals to the server: the last Completed status still opens the dialog', async () => {
    const page = new EstimateApp([ENG], {}, 'member', {
      issues: [issue('04', { statusId: DONE })],
    });
    await mount(page, SILENT_READS);
    await deleteFromMenu('Done');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(toasts()).toEqual([]);
  });
});
