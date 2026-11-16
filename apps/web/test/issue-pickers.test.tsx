/**
 * @vitest-environment jsdom
 */
// PLAN-012 S6 (SPEC-012 §3.5, AC-7, AC-24, E17, E21): the bound pickers in their popover, driven
// with the real PropertyPicker and DatePicker. Each sends one `issue.update` with a partial input;
// the labels picker applies its toggles once, when it closes; `Esc` closes the picker and the
// engine's own `ui:escape` step does not run a second time for the same key press.
import { OverlayProvider, overlayManager } from '@surface/ui';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppContext } from '../src/app/context.js';
import { IssuePickersHost } from '../src/features/issues/pickers/IssuePickersHost.js';
import {
  openPicker,
  pickerRequests,
  type PickerRequest,
} from '../src/features/issues/pickers/picker-request.js';
import { ShortcutProvider, useCommand } from '../src/shortcuts/ShortcutProvider.js';
import { FakeApp, installDomShims, ISSUE_A, issueRow, TEAM } from './issue-fixtures.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
installDomShims();
// Radix scrolls the highlighted option into view.
Element.prototype.scrollIntoView = () => undefined;

const TODO = '0192f0c1-7e5a-7b3c-9d4e-0000000000c2';
const DONE = '0192f0c1-7e5a-7b3c-9d4e-0000000000c3';
const BUG = '0192f0c1-7e5a-7b3c-9d4e-0000000000d1';
const SMALL = '0192f0c1-7e5a-7b3c-9d4e-0000000000d2';

const status = (id: string, name: string, category: string, position: string) => ({
  id,
  teamId: TEAM,
  name,
  category,
  position,
  color: 'gray',
});
const label = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  teamId: null,
  archivedAt: null,
  isGroup: false,
  parentId: null,
  exclusive: false,
  color: 'blue',
  ...extra,
});

function makeApp(extra: Record<string, unknown> = {}): FakeApp {
  return new FakeApp({
    issues: [issueRow(ISSUE_A, 42, { statusId: TODO, priority: 2, assigneeId: null, ...extra })],
    statuses: [status(TODO, 'Todo', 'unstarted', 'a1'), status(DONE, 'Done', 'completed', 'a2')],
    labels: [label(BUG, 'Bug'), label(SMALL, 'Small')],
  });
}

let root: Root | undefined;
let host: HTMLElement | undefined;
let escapes = 0;

function EscapeProbe() {
  useCommand(
    'ui:escape',
    () => {
      escapes += 1;
    },
    { level: 'page' },
  );
  return null;
}

afterEach(() => {
  act(() => {
    pickerRequests.close();
    root?.unmount();
  });
  host?.remove();
  overlayManager.clear();
  escapes = 0;
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
            <EscapeProbe />
            <IssuePickersHost />
          </ShortcutProvider>
        </OverlayProvider>
      </AppContext>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    openPicker({ issueId: ISSUE_A, anchor: null, ...request });
    await Promise.resolve();
  });
}

const search = () => document.querySelector<HTMLInputElement>('[role="dialog"] input');
const options = () =>
  Array.from(document.querySelectorAll('[role="dialog"] [role="option"]')).map(
    (o) => o.textContent,
  );

async function key(init: KeyboardEventInit & { key: string }): Promise<void> {
  await act(async () => {
    (search() ?? document.activeElement)?.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    );
    await Promise.resolve();
  });
}

/** Sets an input's value the way a user typing does, so React sees the change. */
function setValue(input: HTMLInputElement, text: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  const setter: unknown = descriptor === undefined ? undefined : Reflect.get(descriptor, 'set');
  if (typeof setter !== 'function') throw new Error('no value setter');
  Reflect.apply(setter, input, [text]);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function type(text: string): Promise<void> {
  await act(async () => {
    const input = search();
    if (input === null) throw new Error('no search field');
    setValue(input, text);
    await Promise.resolve();
  });
}

describe('single-value pickers (AC-7)', () => {
  it('status: the team’s statuses; a quick key picks by position and sends one update', async () => {
    const app = makeApp();
    await open(app, { kind: 'status' });
    expect(options().map((text) => text?.replace(/\d+$/, ''))).toEqual(['Todo', 'Done']);
    await key({ key: '2' });
    expect(app.dispatched).toEqual([
      { op: 'issue.update', input: { issue: ISSUE_A, status: DONE } },
    ]);
    expect(pickerRequests.snapshot()).toBeUndefined();
  });

  it('priority: 0 to 4 pick by number', async () => {
    const app = makeApp();
    await open(app, { kind: 'priority' });
    await key({ key: '1' });
    expect(app.dispatched[0]?.input).toEqual({ issue: ISSUE_A, priority: 1 });
  });

  it('digits typed after a letter go into the search, not a quick pick (E17)', async () => {
    const app = makeApp();
    await open(app, { kind: 'status' });
    await type('v');
    await key({ key: '2' });
    expect(app.dispatched).toEqual([]);
    expect(pickerRequests.snapshot()).toBeDefined();
  });

  it('assignee: Me is offered and sends the user’s id', async () => {
    const app = makeApp();
    await open(app, { kind: 'assignee' });
    const shown = options();
    expect(shown).toHaveLength(2);
    expect(shown[0]).toBe('No assignee');
    // The avatar's initials come first in the text.
    expect(shown[1]?.endsWith('Me')).toBe(true);
    await key({ key: 'ArrowDown' });
    await key({ key: 'Enter' });
    expect(app.dispatched).toEqual([
      { op: 'issue.update', input: { issue: ISSUE_A, assignee: 'u-ada' } },
    ]);
  });

  it('estimate: a digit equal to a scale value picks it', async () => {
    const app = makeApp();
    await open(app, { kind: 'estimate' });
    await key({ key: '3' });
    expect(app.dispatched[0]?.input).toEqual({ issue: ISSUE_A, estimate: 3 });
  });

  it('picking the current value sends nothing', async () => {
    const app = makeApp();
    await open(app, { kind: 'status' });
    await key({ key: '1' });
    expect(app.dispatched).toEqual([]);
  });
});

describe('the labels picker (AC-24, E21)', () => {
  it('Space then Enter applies the label once; Enter does not toggle it back', async () => {
    const app = makeApp();
    await open(app, { kind: 'labels' });
    await key({ key: ' ' });
    await key({ key: 'Enter' });
    expect(app.dispatched).toEqual([
      { op: 'issue.update', input: { issue: ISSUE_A, addLabels: [BUG] } },
    ]);
  });

  it('Esc applies the pending toggles as one update and closes', async () => {
    const app = makeApp();
    await open(app, { kind: 'labels' });
    await key({ key: ' ' });
    await key({ key: 'ArrowDown' });
    await key({ key: ' ' });
    await key({ key: 'Escape' });
    expect(app.dispatched).toHaveLength(1);
    expect(app.dispatched[0]?.input).toEqual({ issue: ISSUE_A, addLabels: [BUG, SMALL] });
    expect(pickerRequests.snapshot()).toBeUndefined();
  });

  it('closing with nothing toggled sends nothing', async () => {
    const app = makeApp();
    await open(app, { kind: 'labels' });
    await key({ key: 'Escape' });
    expect(app.dispatched).toEqual([]);
  });

  it('a label the replica no longer holds is skipped and never offered', async () => {
    const app = makeApp({ labelIds: ['0192f0c1-7e5a-7b3c-9d4e-0000000000ff'] });
    await open(app, { kind: 'labels' });
    expect(options()).toEqual(['Bug', 'Small']);
  });
});

describe('the due date picker', () => {
  it('a typed date picks it, and one update is sent', async () => {
    const app = makeApp();
    await open(app, { kind: 'dueDate' });
    const input = document.querySelector<HTMLInputElement>(
      '[role="dialog"] input[aria-label="Due date"]',
    );
    expect(input).not.toBeNull();
    await act(async () => {
      if (input !== null) setValue(input, '2026-12-03');
      await Promise.resolve();
    });
    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });
    expect(app.dispatched).toEqual([
      { op: 'issue.update', input: { issue: ISSUE_A, dueDate: '2026-12-03' } },
    ]);
  });
});

describe('closing', () => {
  it('Esc closes the picker, and the engine’s Esc step does not run for the same key press', async () => {
    const app = makeApp();
    await open(app, { kind: 'status' });
    await key({ key: 'Escape' });
    expect(pickerRequests.snapshot()).toBeUndefined();
    expect(escapes).toBe(0);
    expect(app.dispatched).toEqual([]);
  });

  it('tells the request it closed, so the list can take focus back (§3.5)', async () => {
    const onClosed = vi.fn();
    await open(makeApp(), { kind: 'status', onClosed });
    await key({ key: 'Escape' });
    expect(onClosed).toHaveBeenCalledTimes(1);
  });
});
