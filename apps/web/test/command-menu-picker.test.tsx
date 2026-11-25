/**
 * @vitest-environment jsdom
 */
// PLAN-016 S5 (command-menu.md §3.5, PLAN-016 D-d and D-e): a property key opens its picker as a
// page of the command menu: the issue chip, number key caps, a check on the current value; a
// number key or Enter applies one `issue.update`; Esc closes all; Backspace goes back. The page is
// the same bound picker the popover shows, so the options are asserted only once here.
import { OverlayProvider, overlayManager } from '@surface/ui';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppContext } from '../src/app/context.js';
import { CommandMenuProvider } from '../src/command-menu/CommandMenuProvider.js';
import { IssuePickersHost } from '../src/features/issues/pickers/IssuePickersHost.js';
import {
  openPicker,
  pickerRequests,
  type PickerRequest,
} from '../src/features/issues/pickers/picker-request.js';
import { ShortcutProvider } from '../src/shortcuts/ShortcutProvider.js';
import { FakeApp, installDomShims, ISSUE_A, issueRow, setValue, TEAM } from './issue-fixtures.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
installDomShims();
Element.prototype.scrollIntoView = () => undefined;

const TODO = '0192f0c1-7e5a-7b3c-9d4e-0000000000c2';
const DONE = '0192f0c1-7e5a-7b3c-9d4e-0000000000c3';
const BUG = '0192f0c1-7e5a-7b3c-9d4e-0000000000d1';

const status = (id: string, name: string, category: string, position: string) => ({
  id,
  teamId: TEAM,
  name,
  category,
  position,
  color: 'gray',
});

function makeApp(): FakeApp {
  return new FakeApp({
    issues: [issueRow(ISSUE_A, 42, { statusId: TODO, priority: 2, assigneeId: null })],
    statuses: [status(TODO, 'Todo', 'unstarted', 'a1'), status(DONE, 'Done', 'completed', 'a2')],
    labels: [
      {
        id: BUG,
        name: 'Bug',
        teamId: null,
        archivedAt: null,
        isGroup: false,
        parentId: null,
        exclusive: false,
        color: 'blue',
      },
    ],
  });
}

let root: Root | undefined;
let host: HTMLElement | undefined;

afterEach(() => {
  act(() => {
    pickerRequests.close();
    root?.unmount();
  });
  host?.remove();
  overlayManager.clear();
});

async function open(app: FakeApp, request: Pick<PickerRequest, 'kind'> & Partial<PickerRequest>) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <AppContext value={app}>
        <OverlayProvider>
          <ShortcutProvider>
            <CommandMenuProvider actor={app.actor} store={app.store}>
              <IssuePickersHost />
            </CommandMenuProvider>
          </ShortcutProvider>
        </OverlayProvider>
      </AppContext>,
    );
    await Promise.resolve();
  });
  // The row the key was pressed on: it has focus when the picker is asked for.
  const row = document.createElement('button');
  host.append(row);
  row.focus();
  await act(async () => {
    openPicker({ issueId: ISSUE_A, anchor: null, ...request });
    await Promise.resolve();
  });
  return row;
}

const dialog = () => document.querySelector('[role="dialog"]');
const field = () => document.querySelector<HTMLInputElement>('[role="dialog"] input');
const options = () => Array.from(document.querySelectorAll('[role="dialog"] [role="option"]'));

async function key(init: KeyboardEventInit & { key: string }): Promise<void> {
  await act(async () => {
    field()?.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    );
    await Promise.resolve();
  });
}

describe('the command menu frame', () => {
  it('the command menu has no visible backdrop and traps focus', async () => {
    await open(makeApp(), { kind: 'status', frame: 'menu' });
    expect(dialog()).not.toBeNull();
    // The overlay stays (scroll lock, click outside closes) but is transparent: `.clear`, whose
    // background is `transparent` (command-menu-css.test.ts).
    expect(document.querySelector('[class*="backdrop"][class*="clear"]')).not.toBeNull();
    // Focus is inside the menu, on the picker's own field, and the page behind is inert.
    expect(dialog()?.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(field());
    expect(host?.getAttribute('aria-hidden')).toBe('true');
  });

  it('a request without the menu frame still opens the anchored popover', async () => {
    await open(makeApp(), { kind: 'status' });
    expect(dialog()?.textContent).not.toContain('ENG-42');
    expect(options()).toHaveLength(2);
  });
});

describe('a property key opens the picker as a menu page', () => {
  it('S opens the status page with the issue chip and a check on the current status', async () => {
    await open(makeApp(), { kind: 'status', frame: 'menu' });
    expect(dialog()?.textContent).toContain('ENG-42 · Login page flickers');
    expect(dialog()?.textContent).toContain('Change status');
    const shown = options();
    expect(shown.map((o) => o.textContent?.replace(/\d+$/, '').replace(/(\d)\1$/, ''))).toEqual([
      'Todo',
      'Done',
    ]);
    expect(shown.map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false']);
  });

  it('a number key applies one update and the request is told it closed', async () => {
    const onClosed = vi.fn();
    const app = makeApp();
    await open(app, { kind: 'status', frame: 'menu', onClosed });
    await key({ key: '2' });
    expect(app.dispatched).toEqual([
      { op: 'issue.update', input: { issue: ISSUE_A, status: DONE } },
    ]);
    expect(dialog()).toBeNull();
    // The list moves focus back to its row from this callback.
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it('escape closes the whole menu, tells the request and sends nothing', async () => {
    const onClosed = vi.fn();
    const app = makeApp();
    const row = await open(app, { kind: 'priority', frame: 'menu', onClosed });
    await key({ key: 'Escape' });
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(row);
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(app.dispatched).toEqual([]);
  });

  it('backspace on an empty query goes back to the menu home and keeps it open', async () => {
    const onClosed = vi.fn();
    await open(makeApp(), { kind: 'status', frame: 'menu', onClosed });
    await key({ key: 'Backspace' });
    expect(field()?.getAttribute('aria-label')).toBe('Command menu');
    expect(dialog()).not.toBeNull();
    // Closing from the home page no longer calls the request: it cannot take focus from a later popover.
    await key({ key: 'Escape' });
    expect(onClosed).not.toHaveBeenCalled();
  });

  it('backspace with text in the search only deletes; it does not go back', async () => {
    await open(makeApp(), { kind: 'status', frame: 'menu' });
    const input = field();
    if (input === null) throw new Error('no field');
    await setValue(input, 'd');
    await key({ key: 'Backspace' });
    expect(field()?.getAttribute('aria-label')).toBe('Change status');
  });

  it('the footer shows the number range for the page until a query is typed', async () => {
    await open(makeApp(), { kind: 'priority', frame: 'menu' });
    // Key caps repeat their key for screen readers: "00 to 44 pick".
    expect(dialog()?.textContent).toMatch(/0\w* to 4\w* pick/);
    const input = field();
    if (input === null) throw new Error('no field');
    await setValue(input, 'u');
    expect(dialog()?.textContent).not.toContain(' pick');
  });

  it('labels keep Space to toggle and Enter to apply, as one update', async () => {
    const app = makeApp();
    await open(app, { kind: 'labels', frame: 'menu' });
    await key({ key: ' ' });
    expect(app.dispatched).toEqual([]);
    await key({ key: 'Enter' });
    expect(app.dispatched).toEqual([
      { op: 'issue.update', input: { issue: ISSUE_A, addLabels: [BUG] } },
    ]);
    expect(dialog()).toBeNull();
  });
});
