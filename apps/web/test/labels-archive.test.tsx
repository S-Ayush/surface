/**
 * @vitest-environment jsdom
 */
// PLAN-010 S6, SPEC-010 §3.2 items 1, 2 and 6 and AC-11 (page half): the table hides archived
// labels, a collapsed "Archived" section at the end lists them, the row menu offers "Archive…"
// (with the §3.2 dialog wording) on live rows and "Unarchive" on archived ones, and "Add label to
// group" is not offered on an archived group (E14). The model half (`archivedEntries`) is checked
// on plain items.
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppModel } from '../src/app/AppModel.js';
import { TeamLabelsScreen, WorkspaceLabelsScreen } from '../src/features/labels/LabelsScreen.js';
import { archivedEntries, type LabelItem } from '../src/features/labels/model.js';
import { FakeApp, TEAM, pageTree } from './label-fixtures.js';

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
  await inAct(() => {
    root?.unmount();
  });
  root = undefined;
  host.remove();
});

async function inAct(change: () => void): Promise<void> {
  await act(async () => {
    change();
    await Promise.resolve();
  });
}

async function mount(app: AppModel, page: () => ReactNode): Promise<void> {
  const tree = await pageTree(app, page);
  root = createRoot(host);
  await inAct(() => {
    root?.render(tree);
  });
}

async function press(button: Element | null | undefined): Promise<void> {
  if (!(button instanceof HTMLElement)) throw new Error('no such button');
  await inAct(() => {
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    button.click();
  });
}

async function openMenu(rowName: string): Promise<string[]> {
  await press(document.querySelector(`button[aria-label="Actions for ${rowName}"]`));
  return [...document.querySelectorAll('[role="menuitem"]')].map(
    (el) => el.textContent?.trim() ?? '',
  );
}

const workspacePage = () => <WorkspaceLabelsScreen />;
const teamPage = () => <TeamLabelsScreen params={{ key: 'ENG' }} />;
const rowNames = () =>
  [...document.querySelectorAll('[role="option"] span')].map((el) => el.textContent);

describe('the Archived section (§3.2)', () => {
  it('leaves archived labels out of the table and lists them in a collapsed section at the end', async () => {
    await mount(new FakeApp([TEAM]), workspacePage);
    const toggle = document.querySelector('button[aria-expanded]:not([aria-label])');
    expect(toggle?.textContent).toContain('Archived (1)');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(rowNames()).not.toContain('Archived one');
    // The section is the last thing in the list.
    const list = document.querySelector('[role="listbox"]');
    expect(list?.lastElementChild?.contains(toggle ?? null)).toBe(true);
  });

  it('opens on click and shows the archived label with Unarchive in its menu', async () => {
    await mount(new FakeApp([TEAM]), workspacePage);
    await press(document.querySelector('button[aria-expanded]:not([aria-label])'));
    expect(rowNames()).toContain('Archived one');
    const items = await openMenu('Archived one');
    expect(items).toContain('Unarchive');
    expect(items).not.toContain('Archive…');
  });

  it('is not shown on a page with nothing archived', async () => {
    await mount(new FakeApp([TEAM]), teamPage);
    expect(document.body.textContent).not.toContain('Archived (');
  });
});

describe('the Archive dialog (§3.2 item 6)', () => {
  it('offers "Archive…" on a live label and says issues keep it', async () => {
    await mount(new FakeApp([TEAM]), teamPage);
    const items = await openMenu('Perf');
    expect(items).toContain('Archive…');
    expect(items).not.toContain('Unarchive');
    const entry = [...document.querySelectorAll('[role="menuitem"]')].find(
      (el) => el.textContent?.trim() === 'Archive…',
    );
    await press(entry);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Archive label "Perf"?');
    expect(dialog?.textContent).toContain(
      'This label will no longer be available to apply to issues. Issues with the label already applied will remain unchanged.',
    );
  });
});

const item = (id: string, name: string, extra: Partial<LabelItem> = {}): LabelItem => ({
  id,
  teamId: null,
  name,
  color: 'blue',
  description: null,
  parentId: null,
  isGroup: false,
  exclusive: true,
  archived: false,
  createdAt: '2026-11-13T10:00:00.000Z',
  ...extra,
});

describe('archivedEntries', () => {
  it('groups archived labels under their archived group and lists others as plain entries', () => {
    const items = [
      item('g1', 'Size', { isGroup: true, archived: true }),
      item('l1', 'Small', { parentId: 'g1', archived: true }),
      item('l2', 'Large', { parentId: 'g1' }),
      item('g2', 'Area', { isGroup: true }),
      item('l3', 'Web', { parentId: 'g2', archived: true }),
      item('l4', 'Live'),
    ];
    const entries = archivedEntries(items, '');
    expect(entries.map((e) => [e.label.name, e.children.map((c) => c.name)])).toEqual([
      ['Size', ['Small']],
      ['Web', []],
    ]);
    expect(archivedEntries(items, 'sma').map((e) => e.label.name)).toEqual(['Size']);
  });
});
