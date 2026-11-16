/**
 * @vitest-environment jsdom
 */
// PLAN-012 S6 (SPEC-012 §3.11, AC-16): the delete dialog. SPEC-015 wording, focus on **Delete**,
// `issue.delete` only on **Delete** (click, `Enter` or `Mod+Enter`), nothing on **Cancel** or
// `Esc`, no Undo toast. A refused delete rolling the row back (SPEC-015 E25) is the store's
// optimistic overlay; `last-delete.test.ts` checks the memory it leaves.
import { OverlayProvider, overlayManager } from '@surface/ui';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { AppContext } from '../src/app/context.js';
import { askDelete, deleteRequests, lastDelete } from '../src/features/issues/delete-flow.js';
import { DELETE_BODY } from '../src/features/issues/DeleteIssueDialog.js';
import { IssueDeleteHost } from '../src/features/issues/IssueDeleteHost.js';
import { ShortcutProvider } from '../src/shortcuts/ShortcutProvider.js';
import { submitFocusedDialog } from '../src/shortcuts/dialogSubmit.js';
import { FakeApp, installDomShims, ISSUE_A, issueRow } from './issue-fixtures.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
installDomShims();

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  deleteRequests.close();
  lastDelete.take();
  overlayManager.clear();
});

async function mount(app: FakeApp): Promise<void> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <AppContext value={app}>
        <OverlayProvider>
          <ShortcutProvider>
            <IssueDeleteHost />
          </ShortcutProvider>
        </OverlayProvider>
      </AppContext>,
    );
    await Promise.resolve();
  });
}

const dialog = () => document.querySelector('[role="dialog"]');
const button = (name: string) =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent.startsWith(name));

async function ask(onClosed?: () => void): Promise<void> {
  await act(async () => {
    askDelete({
      issueId: ISSUE_A,
      identifier: 'ENG-42',
      title: 'Fix login redirect',
      ...(onClosed === undefined ? {} : { onClosed }),
    });
    await Promise.resolve();
  });
}

describe('the delete dialog', () => {
  it('names the issue with the SPEC-015 wording and starts with focus on Delete', async () => {
    await mount(new FakeApp({ issues: [issueRow(ISSUE_A, 42)] }));
    await ask();
    expect(dialog()?.textContent).toContain('Delete "ENG-42 – Fix login redirect"?');
    expect(dialog()?.textContent).toContain(DELETE_BODY);
    expect(document.activeElement).toBe(button('Delete'));
    expect(button('Cancel')).toBeDefined();
  });

  it('sends issue.delete on Delete, closes, remembers the issue and shows no Undo toast', async () => {
    const app = new FakeApp({ issues: [issueRow(ISSUE_A, 42)] });
    await mount(app);
    let closed = 0;
    await ask(() => {
      closed += 1;
    });
    await act(async () => {
      button('Delete')?.click();
      await Promise.resolve();
    });
    expect(app.dispatched).toEqual([{ op: 'issue.delete', input: { issue: ISSUE_A } }]);
    expect(dialog()).toBeNull();
    expect(closed).toBe(1);
    expect(lastDelete.get()).toEqual({ id: ISSUE_A, identifier: 'ENG-42' });
    expect(overlayManager.getSnapshot().visibleToasts).toEqual([]);
  });

  it('Mod+Enter submits it like any dialog', async () => {
    const app = new FakeApp({ issues: [issueRow(ISSUE_A, 42)] });
    await mount(app);
    await ask();
    await act(async () => {
      submitFocusedDialog();
      await Promise.resolve();
    });
    expect(app.dispatched.map((d) => d.op)).toEqual(['issue.delete']);
  });

  it('Cancel and Esc send nothing and still tell the list so it can take focus back', async () => {
    const app = new FakeApp({ issues: [issueRow(ISSUE_A, 42)] });
    await mount(app);
    let closed = 0;
    await ask(() => {
      closed += 1;
    });
    await act(async () => {
      button('Cancel')?.click();
      await Promise.resolve();
    });
    await ask(() => {
      closed += 1;
    });
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    expect(app.dispatched).toEqual([]);
    expect(closed).toBe(2);
    expect(lastDelete.get()).toBeUndefined();
  });
});
