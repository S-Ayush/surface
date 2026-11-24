/**
 * @vitest-environment jsdom
 */
// PLAN-012 S7a (SPEC-012 §7.4, AC-18, AC-19): the accessibility contract of what is on `main`:
// grid roles and names, pill names, the live region, and the composer's focus trap and return.
// axe itself runs on the stories (`pnpm --filter @surface/ui test:storybook`, local DoD). The
// activity stream's `article` items (actor and time in each label) are pinned in
// `issue-activity.test.tsx` (PLAN-012 S4b) and the comment cards' in the comment tests.
import { overlayManager } from '@surface/ui';
import { act } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { AnnouncerHost } from '../src/features/issues/AnnouncerHost.js';
import { announce, announcer } from '../src/features/issues/announcer.js';
import { PropertiesPanel } from '../src/features/issues/PropertiesPanel.js';
import { issueViewFromOutput, type IssueOutput } from '../src/features/issues/issue-view.js';
import { focusMemory } from '../src/features/issues/focus-model.js';
import { ComposerApp, dialogNamed, mountComposer, type Mounted } from './composer-harness.js';
import { ENG_TODO } from './issue-list-fixtures.js';
import { IssueApp, issue, mountLists, type Mounted as ListMounted } from './issue-list-harness.js';
import { inAct } from './issue-fixtures.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class NoResize {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= NoResize;
window.scrollTo = () => undefined;
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 600 });

let lists: ListMounted | undefined;
let composer: Mounted | undefined;
afterEach(async () => {
  await lists?.unmount();
  lists = undefined;
  composer?.unmount();
  composer = undefined;
  focusMemory.clear();
  localStorage.clear();
  overlayManager.clear();
  document.body.innerHTML = '';
});

describe('the issue list as a grid (AC-19, §7.4)', () => {
  it('gives every row a level and an index, and pills the names "Property: value, change"', async () => {
    const todo = issue({ title: 'Fix login', number: 42, statusId: ENG_TODO, priority: 2 });
    lists = await mountLists(new IssueApp([todo]), '/team/ENG/issues');
    const grid = lists.host.querySelector('[role="treegrid"]');
    expect(grid?.getAttribute('aria-rowcount')).not.toBeNull();
    const rows = [...lists.host.querySelectorAll('[role="row"]')];
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(row.getAttribute('aria-rowindex')).not.toBeNull();
    expect(rows[0]?.getAttribute('aria-level')).toBe('1');
    expect(rows[0]?.getAttribute('aria-expanded')).toBe('true');
    expect(rows[1]?.getAttribute('aria-level')).toBe('2');
    // Every cell sits in a row; only one row is in the tab order (roving tabindex).
    for (const cell of lists.host.querySelectorAll('[role="gridcell"]')) {
      expect(cell.closest('[role="row"]')).not.toBeNull();
    }
    expect(lists.host.querySelectorAll('[role="row"][tabindex="0"]')).toHaveLength(1);
    const names = [...(rows[1]?.querySelectorAll('button') ?? [])].map((b) => b.textContent);
    expect(names).toContain('Status: Todo, change');
    expect(names.some((name) => /^Priority: .+, change$/.test(name))).toBe(true);
  });
});

describe('the properties panel (§7.4)', () => {
  const ID = '0192f0c1-7e5a-7b3c-9d4e-0000000000b1';
  const AT = '2026-11-12T10:00:00.000Z';
  const output: IssueOutput = {
    id: ID,
    identifier: 'ENG-42',
    teamKey: 'ENG',
    title: 'T',
    status: { id: ID, name: 'In Progress', category: 'started' },
    priority: 0,
    assignee: null,
    labels: [],
    estimate: null,
    dueDate: null,
    createdAt: AT,
    updatedAt: AT,
    completedAt: null,
    archivedAt: null,
    deletedAt: null,
    deletedBy: null,
    url: 'x',
    creator: { id: ID, name: 'Ada' },
    startedAt: null,
    canceledAt: null,
    reactions: [],
    attachments: [],
    description: { markdown: '', json: { type: 'doc', content: [{ type: 'paragraph' }] } },
    version: 1,
  };
  const view = issueViewFromOutput(output);
  const now = new Date('2026-11-13T10:00:00.000Z');

  it('names an editable pill "Status: In Progress, change"', () => {
    const html = renderToString(<PropertiesPanel view={view} now={now} onPick={() => undefined} />);
    expect(html).toContain('Status: In Progress, change');
    expect(html).toContain('aria-label="Properties"');
  });

  it('reads a read-only pill as text with the property name first, never as a button', () => {
    const html = renderToString(<PropertiesPanel view={view} now={now} />);
    expect(html).toContain('Status: In Progress');
    expect(html).not.toContain('Status: In Progress, change');
  });

  it('keeps every value a term and a definition, so it reads as text and not colour alone', () => {
    const html = renderToString(<PropertiesPanel view={view} now={now} />);
    expect(html.match(/<dt>/g)?.length).toBe(html.match(/<dd>/g)?.length);
  });
});

describe('the live region (AC-18, §7.4)', () => {
  it('is one polite status region, and the same text announced twice is announced twice', () => {
    const html = renderToString(<AnnouncerHost />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    const before = announcer.snapshot().serial;
    announce('ENG-42 deleted');
    announce('ENG-42 deleted');
    expect(announcer.snapshot().text).toBe('ENG-42 deleted');
    expect(announcer.snapshot().serial).toBe(before + 2);
  });
});

describe('the composer (§7.4)', () => {
  async function open(): Promise<{ trigger: HTMLButtonElement; dialog: HTMLElement }> {
    const trigger = document.createElement('button');
    trigger.textContent = 'Trigger';
    document.body.append(trigger);
    composer = await mountComposer(new ComposerApp(), '/team/ENG/issues');
    trigger.focus();
    const m = composer;
    await inAct(() => {
      m.commands().run('issue:create');
    });
    const dialog = dialogNamed('New issue');
    if (dialog === undefined) throw new Error('composer did not open');
    return { trigger, dialog };
  }

  it('traps focus: Tab from the last control goes to the first, Shift+Tab from the first to the last', async () => {
    const { dialog } = await open();
    const tabbables = [
      ...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input, [tabindex="0"], [href]',
      ),
    ].filter((element) => element.tabIndex >= 0);
    const first = tabbables[0];
    const last = tabbables[tabbables.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    const press = (shiftKey: boolean) => {
      act(() => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }),
        );
      });
    };
    act(() => last?.focus());
    press(false);
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(first);
    press(true);
    expect(document.activeElement).toBe(last);
  });

  it('returns focus to the trigger on close', async () => {
    const { trigger, dialog } = await open();
    const close = dialog.querySelector<HTMLElement>('button[aria-label="Close"]');
    expect(close).not.toBeNull();
    await inAct(() => close?.click());
    expect(dialogNamed('New issue')).toBeUndefined();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(document.activeElement).toBe(trigger);
  });
});
