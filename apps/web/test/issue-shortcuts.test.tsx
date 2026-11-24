/**
 * @vitest-environment jsdom
 */
// PLAN-012 S6 (SPEC-012 §3.6, AC-8, AC-10, E22): the real shortcut engine with the registry's M1
// bindings drives the `issue` scope. On a list the keys act on the focused row; on the page they act
// on the open issue. (The provider drops M1 bindings until PLAN-012 S7b raises `BUILD_MILESTONE`,
// so the tests build the engine themselves over the command registry the screens register into.)
import { overlayManager } from '@surface/ui';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { askDelete, deleteRequests, lastDelete } from '../src/features/issues/delete-flow.js';
import { IssueDeleteHost } from '../src/features/issues/IssueDeleteHost.js';
import { pickerRequests } from '../src/features/issues/pickers/picker-request.js';
import { EDIT_TITLE_STATE_KEY } from '../src/features/issues/focus-model.js';
import { ShortcutEngine } from '../src/shortcuts/engine.js';
import { SHORTCUTS, inBuild } from '../src/shortcuts/registry.js';
import { DES, DES_TODO, ENG_TODO } from './issue-list-fixtures.js';
import { IssueApp, issue, mountLists, type Mounted } from './issue-list-harness.js';
import {
  FakeApp,
  ISSUE_A,
  installDomShims,
  issueRow,
  keydown,
  mountIssuePage,
  type Mounted as PageMounted,
} from './issue-fixtures.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
installDomShims();
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 600 });

let mounted: Mounted | undefined;
let page: PageMounted | undefined;
let engine: ShortcutEngine | undefined;
let listener: ((event: KeyboardEvent) => void) | undefined;
const hints = { sequence: vi.fn(), unavailable: vi.fn(), clear: vi.fn() };

afterEach(async () => {
  if (listener !== undefined) window.removeEventListener('keydown', listener, { capture: true });
  engine?.dispose();
  engine = undefined;
  pickerRequests.close();
  deleteRequests.close();
  lastDelete.take();
  await mounted?.unmount();
  await page?.unmount();
  mounted = undefined;
  page = undefined;
  overlayManager.clear();
  localStorage.clear();
  hints.unavailable.mockClear();
});

function startEngine(commands: Mounted['commands'], pageScopes: () => never[] = () => []): void {
  engine = new ShortcutEngine({
    platform: 'mac',
    bindings: inBuild(SHORTCUTS, 'M1'),
    commands: commands(),
    overlay: { topLayer: () => undefined, isOverlayEscape: () => false },
    pageScopes,
    hints,
  });
  const current = engine;
  listener = (event) => {
    current.handleKeydown(event);
  };
  window.addEventListener('keydown', listener, { capture: true });
}

const rowOf = (title: string) =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="row"]')).find((row) =>
    row.textContent.includes(title),
  );

async function focusRow(title: string): Promise<HTMLElement> {
  const row = rowOf(title);
  if (row === undefined) throw new Error(`no row ${title}`);
  await act(async () => {
    row.focus();
    await Promise.resolve();
  });
  return row;
}

const alpha = issue({ title: 'Alpha', number: 1, statusId: ENG_TODO, dueDate: '2026-12-03' });
const bravo = issue({ title: 'Bravo', number: 2, statusId: ENG_TODO });

describe('the issue keys on a list act on the focused row (AC-8)', () => {
  it.each([
    ['S', { key: 's', code: 'KeyS' }, 'status'],
    ['P', { key: 'p', code: 'KeyP' }, 'priority'],
    ['A', { key: 'a', code: 'KeyA' }, 'assignee'],
    ['L', { key: 'l', code: 'KeyL' }, 'labels'],
    ['Shift+E', { key: 'E', code: 'KeyE', shiftKey: true }, 'estimate'],
    ['Shift+D', { key: 'D', code: 'KeyD', shiftKey: true }, 'dueDate'],
  ])('%s opens the %s picker for that row, anchored to it', async (_name, init, kind) => {
    mounted = await mountLists(new IssueApp([alpha, bravo]), '/team/ENG/issues');
    startEngine(mounted.commands);
    const row = await focusRow('Bravo');
    await keydown(row, init.key, init);
    expect(pickerRequests.snapshot()).toMatchObject({ kind, issueId: bravo.id });
    // Compared by identity: a deep match of two DOM nodes never ends.
    expect(pickerRequests.snapshot()?.anchor === row).toBe(true);
  });

  it('I assigns the focused issue to me, and does nothing when it is already mine', async () => {
    const app = new IssueApp([alpha, { ...bravo, assigneeId: 'u-ada' }]);
    mounted = await mountLists(app, '/team/ENG/issues');
    startEngine(mounted.commands);
    await keydown(await focusRow('Alpha'), 'i', { code: 'KeyI' });
    expect(app.dispatched).toEqual([
      { op: 'issue.update', input: { issue: alpha.id, assignee: 'u-ada' } },
    ]);
    await keydown(await focusRow('Bravo'), 'i', { code: 'KeyI' });
    expect(app.dispatched).toHaveLength(1);
  });

  it('Mod+Shift+D removes the due date, and does nothing on an issue without one', async () => {
    const app = new IssueApp([alpha, bravo]);
    mounted = await mountLists(app, '/team/ENG/issues');
    startEngine(mounted.commands);
    const init = { code: 'KeyD', metaKey: true, shiftKey: true };
    await keydown(await focusRow('Bravo'), 'D', init);
    expect(app.dispatched).toEqual([]);
    await keydown(await focusRow('Alpha'), 'D', init);
    expect(app.dispatched).toEqual([
      { op: 'issue.update', input: { issue: alpha.id, dueDate: null } },
    ]);
  });

  it('Shift+E on a team whose scale is off shows the hint and opens nothing', async () => {
    const onDes = issue({ title: 'Delta', number: 7, teamId: DES, statusId: DES_TODO });
    mounted = await mountLists(new IssueApp([onDes]), '/team/DES/issues');
    startEngine(mounted.commands);
    await keydown(await focusRow('Delta'), 'E', { code: 'KeyE', shiftKey: true });
    expect(pickerRequests.snapshot()).toBeUndefined();
    const toasts = overlayManager.getSnapshot().visibleToasts.map((t) => t.message);
    expect(toasts).toEqual(["DES doesn't use estimates. Turn them on in team settings."]);
  });

  it('Mod+Backspace opens the delete dialog for the focused row', async () => {
    mounted = await mountLists(new IssueApp([alpha, bravo]), '/team/ENG/issues');
    startEngine(mounted.commands);
    await keydown(await focusRow('Bravo'), 'Backspace', { code: 'Backspace', metaKey: true });
    expect(deleteRequests.snapshot()).toMatchObject({
      issueId: bravo.id,
      identifier: 'ENG-2',
      title: 'Bravo',
    });
  });

  it('Mod+. copies the ID of the focused row', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    try {
      mounted = await mountLists(new IssueApp([alpha, bravo]), '/team/ENG/issues');
      startEngine(mounted.commands);
      await keydown(await focusRow('Bravo'), '.', { code: 'Period', metaKey: true });
      expect(writeText).toHaveBeenCalledWith('ENG-2');
    } finally {
      // jsdom has no clipboard: the stub goes, so later tests and files see none.
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('Shift+R opens the issue with the title in edit mode', async () => {
    mounted = await mountLists(new IssueApp([alpha, bravo]), '/team/ENG/issues');
    startEngine(mounted.commands);
    await keydown(await focusRow('Bravo'), 'R', { code: 'KeyR', shiftKey: true });
    expect(document.querySelector('[data-testid="issue-path"]')?.textContent).toMatch(
      /^\/issue\/ENG-2/,
    );
  });

  it('does nothing while a group header has focus: no issue is the target', async () => {
    mounted = await mountLists(new IssueApp([alpha, bravo]), '/team/ENG/issues');
    startEngine(mounted.commands);
    const header = Array.from(document.querySelectorAll<HTMLElement>('[role="row"]')).find((row) =>
      row.textContent.startsWith('Todo'),
    );
    await act(async () => {
      header?.focus();
      await Promise.resolve();
    });
    await keydown(header ?? document.body, 's', { code: 'KeyS' });
    expect(pickerRequests.snapshot()).toBeUndefined();
  });
});

describe('Mod+Z restores the last deleted issue through the engine (SPEC-012 §3.11, AC-16, E23)', () => {
  const modZ = { code: 'KeyZ', metaKey: true };
  const mountWithHost = async () => {
    const app = new IssueApp([alpha, bravo]);
    mounted = await mountLists(app, '/team/ENG/issues', <IssueDeleteHost />);
    startEngine(mounted.commands);
    return app;
  };

  it('does nothing when no delete is remembered (E23)', async () => {
    const app = await mountWithHost();
    await keydown(await focusRow('Alpha'), 'z', modZ);
    expect(app.dispatched).toEqual([]);
  });

  it('does not dispatch while focus is in a text field, where Mod+Z undoes typing', async () => {
    const app = await mountWithHost();
    lastDelete.set({ id: 'gone-1', identifier: 'ENG-9' });
    const input = document.createElement('input');
    document.body.append(input);
    await act(async () => {
      input.focus();
      await Promise.resolve();
    });
    await keydown(input, 'z', modZ);
    input.remove();
    expect(app.dispatched).toEqual([]);
    expect(lastDelete.get()?.id).toBe('gone-1');
  });

  it('with focus on a row it dispatches issue.restore for the remembered issue, once', async () => {
    const app = await mountWithHost();
    lastDelete.set({ id: 'gone-1', identifier: 'ENG-9' });
    const row = await focusRow('Alpha');
    await keydown(row, 'z', modZ);
    expect(app.dispatched).toEqual([{ op: 'issue.restore', input: { issue: 'gone-1' } }]);
    await keydown(row, 'z', modZ);
    expect(app.dispatched).toHaveLength(1);
  });

  it('is unavailable while the delete dialog is open', async () => {
    const app = await mountWithHost();
    lastDelete.set({ id: 'gone-1', identifier: 'ENG-9' });
    const row = await focusRow('Alpha');
    await act(async () => {
      askDelete({ issueId: alpha.id, identifier: 'ENG-1', title: 'Alpha' });
      await Promise.resolve();
    });
    await keydown(row, 'z', modZ);
    expect(app.dispatched).toEqual([]);
  });
});

describe('the issue keys on the page act on the open issue (AC-8, E22)', () => {
  const layout = () => document.querySelector<HTMLElement>('[data-shortcut-scope="issue"]');

  // The page's handlers are in the shortcut provider the fixtures mount, with the M1 keys put in
  // the build (`ALL_KEYS`), so a key pressed inside the page's `issue` scope reaches them.
  it('P opens the priority picker for the open issue, anchored to its panel pill', async () => {
    page = await mountIssuePage({
      app: new FakeApp({ issues: [issueRow(ISSUE_A, 42)] }),
      ref: 'ENG-42',
    });
    await keydown(layout() ?? document.body, 'p', { code: 'KeyP' });
    expect(pickerRequests.snapshot()).toMatchObject({ kind: 'priority', issueId: ISSUE_A });
    const pill = document.querySelector('[data-property="priority"]');
    expect(pickerRequests.snapshot()?.anchor === pill).toBe(true);
  });

  it('Mod+Backspace opens the delete dialog for the open issue', async () => {
    page = await mountIssuePage({
      app: new FakeApp({ issues: [issueRow(ISSUE_A, 42)] }),
      ref: 'ENG-42',
    });
    await keydown(layout() ?? document.body, 'Backspace', { code: 'Backspace', ctrlKey: true });
    expect(deleteRequests.snapshot()).toMatchObject({
      issueId: ISSUE_A,
      identifier: 'ENG-42',
      title: 'Login page flickers',
    });
  });

  it('an archived issue gives the reason on its key and opens nothing (E22)', async () => {
    const app = new FakeApp({
      issues: [issueRow(ISSUE_A, 41, { archivedAt: '2026-11-01T00:00:00.000Z' })],
    });
    page = await mountIssuePage({ app, ref: 'ENG-41' });
    await keydown(layout() ?? document.body, 'p', { code: 'KeyP' });
    expect(pickerRequests.snapshot()).toBeUndefined();
    expect(app.dispatched).toEqual([]);
    const toasts = overlayManager.getSnapshot().visibleToasts.map((t) => t.message);
    expect(toasts).toEqual(['ENG-41 is archived. Restore it to edit it.']);
    // The pills of an archived issue are read-only text.
    expect(document.querySelector('[data-property]')).toBeNull();
  });

  it('Mod+Backspace deletes an archived issue (SPEC-015 §3.4) but not a deleted one', async () => {
    const del = { code: 'Backspace', ctrlKey: true };
    page = await mountIssuePage({
      app: new FakeApp({
        issues: [issueRow(ISSUE_A, 41, { archivedAt: '2026-11-01T00:00:00.000Z' })],
      }),
      ref: 'ENG-41',
    });
    await keydown(layout() ?? document.body, 'Backspace', del);
    expect(deleteRequests.snapshot()).toMatchObject({ issueId: ISSUE_A, identifier: 'ENG-41' });
    deleteRequests.close();
    await page.unmount();
    page = await mountIssuePage({
      app: new FakeApp({
        issues: [issueRow(ISSUE_A, 43, { deletedAt: '2026-11-10T00:00:00.000Z' })],
      }),
      ref: 'ENG-43',
    });
    await keydown(layout() ?? document.body, 'Backspace', del);
    expect(deleteRequests.snapshot()).toBeUndefined();
  });

  it('opens with the title in edit mode when a list row asked for it (Shift+R)', async () => {
    page = await mountIssuePage({
      app: new FakeApp({ issues: [issueRow(ISSUE_A, 42)] }),
      ref: 'ENG-42',
      state: { [EDIT_TITLE_STATE_KEY]: true },
    });
    expect(document.querySelector('input')).not.toBeNull();
  });

  it('pills of a live issue open the picker anchored to the pill', async () => {
    page = await mountIssuePage({
      app: new FakeApp({ issues: [issueRow(ISSUE_A, 42)] }),
      ref: 'ENG-42',
    });
    const pill = document.querySelector<HTMLElement>('[data-property="priority"]');
    expect(pill).not.toBeNull();
    await act(async () => {
      pill?.click();
      await Promise.resolve();
    });
    expect(pickerRequests.snapshot()).toMatchObject({ kind: 'priority', issueId: ISSUE_A });
    expect(pickerRequests.snapshot()?.anchor === pill).toBe(true);
  });
});
