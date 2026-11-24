/**
 * @vitest-environment jsdom
 */
// PLAN-015 S4 (SPEC-015 §3.4, D14, AC-15): Permanently delete… opens a plain confirm dialog,
// `Permanently delete "ENG-42 – <title>"?` with "This can't be undone.", **Cancel** and
// **Permanently delete**, focus on Cancel. `issue.purge` is sent only on **Permanently delete**,
// and its confirmation tells the archive page and the issue page. The delete dialog keeps the
// SPEC-015 wording (§3.1).
import { OverlayProvider, overlayManager } from '@surface/ui';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { AppContext } from '../src/app/context.js';
import { ArchiveHost } from '../src/features/archive/ArchiveHost.js';
import { lifecycleEvents, type LifecycleEvent } from '../src/features/archive/lifecycle-events.js';
import { PURGE_BODY } from '../src/features/archive/PurgeIssueDialog.js';
import { askPurge, purgeRequests } from '../src/features/archive/purge-flow.js';
import { DELETE_BODY, deleteTitle } from '../src/features/issues/DeleteIssueDialog.js';
import { ShortcutProvider } from '../src/shortcuts/ShortcutProvider.js';
import { FakeApp, installDomShims, ISSUE_A } from './issue-fixtures.js';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
installDomShims();

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  purgeRequests.close();
  overlayManager.clear();
});

async function mount(app: FakeApp): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  // The host reads the route (`G` `X`), so it renders inside a router.
  const router = createRouter({
    routeTree: createRootRoute({ component: ArchiveHost }),
    history: createMemoryHistory({ initialEntries: ['/'] }),
    origin: 'http://localhost',
    isServer: false,
    scrollRestoration: false,
  });
  await router.load();
  await act(async () => {
    root?.render(
      <AppContext value={app}>
        <OverlayProvider>
          <ShortcutProvider>
            <RouterProvider router={router} />
          </ShortcutProvider>
        </OverlayProvider>
      </AppContext>,
    );
    await Promise.resolve();
  });
}

const dialog = () => document.querySelector('[role="dialog"]');
const button = (name: string) =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent === name);

async function ask(): Promise<void> {
  await act(async () => {
    askPurge({ issueId: ISSUE_A, identifier: 'ENG-42', title: 'Fix login redirect' });
    await Promise.resolve();
  });
}

describe('the Permanently delete dialog', () => {
  it('names the issue, says it cannot be undone and starts with focus on Cancel', async () => {
    await mount(new FakeApp({ issues: [], role: 'admin' }));
    await ask();
    expect(dialog()?.textContent).toContain('Permanently delete "ENG-42 – Fix login redirect"?');
    expect(dialog()?.textContent).toContain(PURGE_BODY);
    expect(PURGE_BODY).toBe("This can't be undone.");
    expect(document.activeElement).toBe(button('Cancel'));
    expect(button('Permanently delete')).toBeDefined();
  });

  it('sends issue.purge only on Permanently delete, and tells the pages once confirmed', async () => {
    const app = new FakeApp({ issues: [], role: 'admin' });
    const seen: LifecycleEvent[] = [];
    const stop = lifecycleEvents.subscribe((event) => seen.push(event));
    await mount(app);
    await ask();
    await act(async () => {
      button('Permanently delete')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    stop();
    expect(dialog()).toBeNull();
    expect(app.dispatched).toEqual([{ op: 'issue.purge', input: { issue: ISSUE_A } }]);
    expect(seen).toContainEqual({ kind: 'confirmed', op: 'purge', issueId: ISSUE_A });
  });

  it('sends nothing on Cancel', async () => {
    const app = new FakeApp({ issues: [], role: 'admin' });
    await mount(app);
    await ask();
    await act(async () => {
      button('Cancel')?.click();
      await Promise.resolve();
    });
    expect(dialog()).toBeNull();
    expect(app.dispatched).toEqual([]);
  });
});

describe('the delete dialog wording (SPEC-015 §3.1)', () => {
  it('matches the spec', () => {
    expect(deleteTitle('ENG-42', 'Fix login redirect')).toBe(
      'Delete "ENG-42 – Fix login redirect"?',
    );
    expect(DELETE_BODY).toBe(
      'Deleted issues are available in the "Recently deleted" view for 30 days, before they are permanently deleted.',
    );
  });
});
