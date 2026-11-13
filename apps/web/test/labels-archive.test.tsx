/**
 * @vitest-environment jsdom
 */
// PLAN-010 S6, SPEC-010 §3.2 items 1, 2 and 6 and AC-11 (page half): the table hides archived
// labels, a collapsed "Archived" section at the end lists them, the row menu offers "Archive…"
// (with the §3.2 dialog wording) on live rows and "Unarchive" on archived ones, and "Add label to
// group" is not offered on an archived group and "Unarchive" is not offered on a label of one
// (E14), confirming the dialog dispatches `label.archive`, and a refused Unarchive toasts. The
// model half (`archivedEntries`, `groupChoices`) is checked on plain items.
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Ui from '@surface/ui';
import type { AppModel } from '../src/app/AppModel.js';
import { TeamLabelsScreen, WorkspaceLabelsScreen } from '../src/features/labels/LabelsScreen.js';
import { archivedEntries, groupChoices, type LabelItem } from '../src/features/labels/model.js';
import { FakeApp, TEAM, pageTree } from './label-fixtures.js';

const toast = vi.hoisted(() => vi.fn<(options: unknown) => void>());
vi.mock('@surface/ui', async (original) => ({ ...(await original<typeof Ui>()), toast }));

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

const toggle = () => document.querySelector('section[aria-label="Archived labels"] > button');

describe('the Archived section (§3.2)', () => {
  it('leaves archived labels out of the table and lists them in a collapsed section at the end', async () => {
    await mount(new FakeApp([TEAM]), workspacePage);
    expect(toggle()?.textContent).toContain('Archived (3)');
    expect(toggle()?.getAttribute('aria-expanded')).toBe('false');
    expect(rowNames()).not.toContain('Archived one');
    const section = toggle()?.parentElement;
    expect(section?.parentElement?.lastElementChild).toBe(section);
  });

  it('keeps the toggle outside the listbox, whose children are rows, as a focusable button', async () => {
    await mount(new FakeApp([TEAM]), workspacePage);
    const button = toggle();
    expect(button?.tagName).toBe('BUTTON');
    expect(button?.closest('[role="listbox"]')).toBeNull();
    expect(button?.getAttribute('tabindex')).toBeNull();
    (button as HTMLElement).focus();
    expect(document.activeElement).toBe(button);
    await press(button);
    const archived = document.querySelector('[role="listbox"][aria-label^="Archived"]');
    expect(archived?.querySelector('[role="option"]')).not.toBeNull();
    for (const list of document.querySelectorAll('[role="listbox"]')) {
      for (const child of list.children) {
        expect(child.querySelector('button[aria-expanded]:not([aria-label])')).toBeNull();
      }
    }
  });

  it('opens on click and shows the archived label with Unarchive in its menu', async () => {
    await mount(new FakeApp([TEAM]), workspacePage);
    await press(toggle());
    expect(rowNames()).toContain('Archived one');
    const items = await openMenu('Archived one');
    expect(items).toContain('Unarchive');
    expect(items).not.toContain('Archive…');
  });

  it('does not offer "Add label to group" on an archived group (E14)', async () => {
    await mount(new FakeApp([TEAM]), workspacePage);
    await press(toggle());
    const items = await openMenu('Retired');
    expect(items).toContain('Unarchive');
    expect(items).not.toContain('Add label to group');
  });

  it('does not offer "Unarchive" on an archived label of an archived group (E14)', async () => {
    await mount(new FakeApp([TEAM]), workspacePage);
    await press(toggle());
    await press(document.querySelector('button[aria-label="Expand Retired"]'));
    const items = await openMenu('Old size');
    expect(items).toContain('Delete…');
    expect(items).not.toContain('Unarchive');
  });

  it('shows the archived group as the selected group when editing its archived label', async () => {
    await mount(new FakeApp([TEAM]), workspacePage);
    await press(toggle());
    await press(document.querySelector('button[aria-label="Expand Retired"]'));
    await openMenu('Old size');
    const edit = [...document.querySelectorAll('[role="menuitem"]')].find(
      (el) => el.textContent?.trim() === 'Edit label name',
    );
    await press(edit);
    const select = document.querySelector<HTMLSelectElement>('form select');
    expect(select?.selectedOptions[0]?.textContent).toBe('Retired (archived)');
  });

  it('is not shown on a page with nothing archived', async () => {
    await mount(new FakeApp([TEAM]), teamPage);
    expect(document.body.textContent).not.toContain('Archived (');
  });
});

describe('the Archive dialog (§3.2 item 6)', () => {
  const dispatched: { name: string; input: unknown }[] = [];
  const confirmed = () => Promise.resolve({ status: 'confirmed' });
  beforeEach(() => {
    dispatched.length = 0;
    toast.mockClear();
  });

  async function openArchive(row: string): Promise<void> {
    const items = await openMenu(row);
    expect(items).toContain('Archive…');
    expect(items).not.toContain('Unarchive');
    const entry = [...document.querySelectorAll('[role="menuitem"]')].find(
      (el) => el.textContent?.trim() === 'Archive…',
    );
    await press(entry);
  }

  it('offers "Archive…" on a live label and says issues keep it', async () => {
    await mount(new FakeApp([TEAM]), teamPage);
    await openArchive('Perf');
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Archive label "Perf"?');
    expect(dialog?.textContent).toContain(
      'This label will no longer be available to apply to issues. Issues with the label already applied will remain unchanged.',
    );
    expect(dialog?.textContent).not.toContain('Its labels are archived too');
  });

  it('says a group takes its labels with it', async () => {
    await mount(new FakeApp([TEAM]), teamPage);
    await openArchive('Size');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Its labels are archived too.',
    );
  });

  it('dispatches label.archive with the label id and the team when confirmed', async () => {
    const app = new FakeApp([TEAM], 'member', (op, input) => {
      dispatched.push({ name: op.name, input });
      return confirmed();
    });
    await mount(app, teamPage);
    await openArchive('Perf');
    const confirm = [...document.querySelectorAll('[role="dialog"] button')].find(
      (el) => el.textContent?.trim() === 'Archive',
    );
    await press(confirm);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.name).toBe('label.archive');
    expect(dispatched[0]?.input).toMatchObject({ team: 'ENG' });
    expect((dispatched[0]?.input as { label: string }).label).toMatch(/^[0-9a-f-]{36}$/);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('toasts a refused Unarchive with the server’s message', async () => {
    const app = new FakeApp([TEAM], 'member', (op, input) => {
      dispatched.push({ name: op.name, input });
      return Promise.resolve({
        status: 'rejected',
        error: { code: 'INVALID_INPUT', message: 'That label is not here. Reload and try again.' },
      });
    });
    await mount(app, workspacePage);
    await press(toggle());
    const entry = async () => {
      await openMenu('Archived one');
      return [...document.querySelectorAll('[role="menuitem"]')].find(
        (el) => el.textContent?.trim() === 'Unarchive',
      );
    };
    await press(await entry());
    expect(dispatched.map((d) => d.name)).toEqual(['label.unarchive']);
    expect(toast).toHaveBeenCalledWith({
      tone: 'danger',
      message: 'That label is not here. Reload and try again.',
    });
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

describe('archived labels in the Archived section', () => {
  it('names the group of an archived label whose group is live, so two "Small" differ', () => {
    const items = [
      item('g1', 'Size', { isGroup: true }),
      item('g2', 'Shirt', { isGroup: true }),
      item('l1', 'Small', { parentId: 'g1', archived: true }),
      item('l2', 'Small', { parentId: 'g2', archived: true }),
    ];
    const entries = archivedEntries(items, '');
    expect(entries.map((e) => [e.label.groupName, e.label.name])).toEqual([
      ['Size', 'Small'],
      ['Shirt', 'Small'],
    ]);
  });
});

describe('groupChoices', () => {
  it('keeps the group a label is in now even when archived, and drops other archived groups', () => {
    const items = [
      item('g1', 'Old', { isGroup: true, archived: true }),
      item('g2', 'Older', { isGroup: true, archived: true }),
      item('g3', 'Live', { isGroup: true }),
    ];
    expect(groupChoices(items).map((g) => g.name)).toEqual(['Live']);
    expect(groupChoices(items, 'g1').map((g) => g.name)).toEqual(['Live', 'Old']);
  });
});
