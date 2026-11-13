/**
 * @vitest-environment jsdom
 */
// PLAN-012 S3 (SPEC-012 §3.3, §3.9, §7.2, §7.4; AC-4, AC-5, AC-19, E1, E2): the team list and My
// issues rendered from the replica, with the keys the `list` scope runs and focus following the
// issue. The non-member team load (AC-27, E28) waits for PLAN-011 S4c.
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { announcer } from '../src/features/issues/announcer.js';
import { focusMemory } from '../src/features/issues/focus-model.js';
import { ENG, ENG_DOING, ENG_DONE, ENG_TODO, ME, OTHER } from './issue-list-fixtures.js';
import { IssueApp, issue, mountLists, type Mounted } from './issue-list-harness.js';

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
});

const rows = (host: HTMLElement) =>
  [...host.querySelectorAll<HTMLElement>('[role="row"]')].map((row) => ({
    row,
    name: row.getAttribute('aria-label') ?? row.textContent,
  }));

async function inAct(change: () => void): Promise<void> {
  await act(async () => {
    change();
    await Promise.resolve();
  });
}

describe('team issue list', () => {
  const todo = issue({ title: 'Fix login', number: 42, statusId: ENG_TODO, priority: 2 });
  const doing = issue({ title: 'Ship it', number: 43, statusId: ENG_DOING });
  const done = issue({ title: 'Old thing', number: 44, statusId: ENG_DONE });

  it('renders a treegrid of groups and rows with aria-rowcount and rowindex (AC-19)', async () => {
    mounted = await mountLists(new IssueApp([todo, doing, done]), '/team/ENG/issues');
    const grid = mounted.host.querySelector('[role="treegrid"]');
    expect(grid?.getAttribute('aria-label')).toBe('Issues in ENG');
    // Done is collapsed by default: three headers and two rows.
    expect(grid?.getAttribute('aria-rowcount')).toBe('5');
    const items = rows(mounted.host);
    expect(items.map((item) => item.row.getAttribute('aria-rowindex'))).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
    ]);
    expect(items[0]?.name).toBe('Todo, 1 issue, expanded');
    expect(items[4]?.name).toBe('Done, 1 issue, collapsed');
    expect(mounted.host.textContent).toContain('ENG-42');
    expect(mounted.host.textContent).toContain('Fix login');
    expect(mounted.host.textContent).not.toContain('Old thing');
  });

  it('carries the list scope on the grid so the list keys apply', async () => {
    mounted = await mountLists(new IssueApp([todo]), '/team/ENG/issues');
    expect(
      mounted.host.querySelector('[data-shortcut-scope="list"] [role="treegrid"]'),
    ).not.toBeNull();
  });

  it('shows ENG-… for a pending issue', async () => {
    mounted = await mountLists(
      new IssueApp([issue({ title: 'Just created', number: null })]),
      '/team/ENG/issues',
    );
    expect(mounted.host.textContent).toContain('ENG-…');
  });

  it('shows pills read-only until the pickers arrive (S6)', async () => {
    mounted = await mountLists(new IssueApp([todo]), '/team/ENG/issues');
    const priority = mounted.host.querySelector(
      '[role="gridcell"] [aria-label],[role="gridcell"] span',
    );
    expect(priority).not.toBeNull();
    expect(mounted.host.querySelectorAll('[role="gridcell"] button').length).toBe(0);
  });

  it('states an empty team and offers no Create button before the composer exists', async () => {
    mounted = await mountLists(new IssueApp([]), '/team/ENG/issues');
    expect(mounted.host.textContent).toContain('No issues in ENG yet');
    expect(mounted.host.textContent).toContain('Create one with C.');
    expect(mounted.host.querySelector('button')).toBeNull();
  });

  it('shows the Create issue button once issue:create has a handler', async () => {
    mounted = await mountLists(new IssueApp([]), '/team/ENG/issues');
    const registry = mounted.commands();
    let ran = 0;
    await inAct(() => {
      registry.register('issue:create', {
        run: () => {
          ran += 1;
        },
      });
    });
    const button = [...mounted.host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Create issue',
    );
    expect(button).toBeDefined();
    await inAct(() => button?.click());
    expect(ran).toBe(1);
  });

  it('is not found for a team that is not in the replica', async () => {
    mounted = await mountLists(new IssueApp([todo]), '/team/NOPE/issues');
    expect(mounted.host.textContent).toContain("This page doesn't exist");
  });

  it('shows "Available when online" for a team never loaded while offline, and Loading… online', async () => {
    const app = new IssueApp([], [ENG]);
    // DES is a team the user is not a member of, with no issues in the replica.
    mounted = await mountLists(app, '/team/DES/issues');
    expect(mounted.host.textContent).toContain('Loading…');
    app.setOnline(false);
    await inAct(() => undefined);
    expect(mounted.host.textContent).toContain('Available when online');
  });
});

describe('list keys', () => {
  const a = issue({ title: 'Alpha', number: 1, statusId: ENG_TODO, priority: 1 });
  const b = issue({ title: 'Bravo', number: 2, statusId: ENG_TODO, priority: 2 });
  const c = issue({ title: 'Charlie', number: 3, statusId: ENG_TODO, priority: 3 });

  const focused = () => document.activeElement?.closest('[role="row"]');

  it('moves focus with list:next and list:previous through headers and rows', async () => {
    mounted = await mountLists(new IssueApp([a, b, c]), '/team/ENG/issues');
    expect(focused()?.getAttribute('aria-label')).toContain('Todo');
    await inAct(() => mounted?.commands().run('list:next'));
    expect(focused()?.textContent).toContain('Alpha');
    await inAct(() => mounted?.commands().run('list:next'));
    expect(focused()?.textContent).toContain('Bravo');
    await inAct(() => mounted?.commands().run('list:previous'));
    expect(focused()?.textContent).toContain('Alpha');
  });

  it('stops at the ends of the list', async () => {
    mounted = await mountLists(new IssueApp([a]), '/team/ENG/issues');
    await inAct(() => mounted?.commands().run('list:previous'));
    expect(focused()?.getAttribute('aria-label')).toContain('Todo');
    await inAct(() => mounted?.commands().run('list:next'));
    await inAct(() => mounted?.commands().run('list:next'));
    expect(focused()?.textContent).toContain('Alpha');
  });

  it('T collapses and expands the focused group header, and remembers it per device', async () => {
    mounted = await mountLists(new IssueApp([a, b]), '/team/ENG/issues');
    await inAct(() => mounted?.commands().run('list:toggle-group'));
    expect(mounted.host.textContent).not.toContain('Alpha');
    expect(focused()?.getAttribute('aria-label')).toBe('Todo, 2 issues, collapsed');
    expect(localStorage.getItem(`surface:list-collapse:team:ENG`)).toContain(`"${ENG_TODO}":true`);
    await inAct(() => mounted?.commands().run('list:toggle-group'));
    expect(mounted.host.textContent).toContain('Alpha');
  });

  it('does nothing for T on a row (the key belongs to group headers)', async () => {
    mounted = await mountLists(new IssueApp([a]), '/team/ENG/issues');
    await inAct(() => mounted?.commands().run('list:next'));
    await inAct(() => mounted?.commands().run('list:toggle-group'));
    expect(mounted.host.textContent).toContain('Alpha');
  });

  it('Alt+T collapses every group, then expands them all', async () => {
    mounted = await mountLists(
      new IssueApp([a, issue({ statusId: ENG_DOING, title: 'Delta' })]),
      '/team/ENG/issues',
    );
    await inAct(() => mounted?.commands().run('list:toggle-all-groups'));
    expect(mounted.host.textContent).not.toContain('Alpha');
    expect(mounted.host.textContent).not.toContain('Delta');
    await inAct(() => mounted?.commands().run('list:toggle-all-groups'));
    expect(mounted.host.textContent).toContain('Alpha');
    expect(mounted.host.textContent).toContain('Delta');
  });

  it('Enter opens the focused issue and passes the ordered ids of the list in router state', async () => {
    mounted = await mountLists(new IssueApp([a, b, c]), '/team/ENG/issues');
    await inAct(() => mounted?.commands().run('list:next'));
    await inAct(() => mounted?.commands().run('list:next'));
    await inAct(() => mounted?.commands().run('list:open'));
    expect(document.querySelector('[data-testid="issue-path"]')?.textContent).toBe(
      '/issue/ENG-2/bravo',
    );
    const source = JSON.parse(
      document.querySelector('[data-testid="issue-source"]')?.textContent ?? 'null',
    ) as { href: string; routeKey: string; issueIds: string[] };
    expect(source).toEqual({
      href: '/team/ENG/issues',
      routeKey: 'team:ENG',
      issueIds: [a.id, b.id, c.id].sort(
        (x, y) => [a, b, c].findIndex((i) => i.id === x) - [a, b, c].findIndex((i) => i.id === y),
      ),
    });
  });

  it('Enter on a group header does nothing', async () => {
    mounted = await mountLists(new IssueApp([a]), '/team/ENG/issues');
    await inAct(() => mounted?.commands().run('list:open'));
    expect(document.querySelector('[data-testid="issue-route"]')).toBeNull();
  });
});

describe('arrival focus (§3.3 item 8)', () => {
  const a = issue({ title: 'Alpha', number: 1, statusId: ENG_TODO, priority: 1 });
  const b = issue({ title: 'Bravo', number: 2, statusId: ENG_TODO, priority: 2 });

  it('focuses the first row on arrival, without a manual focus', async () => {
    mounted = await mountLists(new IssueApp([a, b]), '/team/ENG/issues');
    const active = document.activeElement?.closest('[role="row"]');
    expect(active?.getAttribute('aria-label')).toBe('Todo, 2 issues, expanded');
    expect(active?.getAttribute('tabindex')).toBe('0');
  });

  it('focuses the remembered row on a revisit, as document.activeElement', async () => {
    const app = new IssueApp([a, b]);
    mounted = await mountLists(app, '/team/ENG/issues');
    await inAct(() => mounted?.commands().run('list:next'));
    await inAct(() => mounted?.commands().run('list:next'));
    expect(document.activeElement?.textContent).toContain('Bravo');
    await mounted.unmount();
    mounted = await mountLists(app, '/team/ENG/issues');
    expect(document.activeElement?.closest('[role="row"]')?.textContent).toContain('Bravo');
  });

  it('comes back to the list from an issue and focuses the row by itself', async () => {
    mounted = await mountLists(new IssueApp([a, b]), '/team/ENG/issues');
    await inAct(() => mounted?.commands().run('list:next'));
    await inAct(() => mounted?.commands().run('list:next'));
    await inAct(() => mounted?.commands().run('list:open'));
    expect(document.querySelector('[data-testid="issue-route"]')).not.toBeNull();
    await mounted.navigate('/team/ENG/issues');
    expect(document.activeElement?.closest('[role="row"]')?.textContent).toContain('Bravo');
  });

  it('does not take focus from a text field the user is typing in', async () => {
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    mounted = await mountLists(new IssueApp([a]), '/team/ENG/issues');
    expect(document.activeElement).toBe(input);
    input.remove();
  });
});

describe('focus follows the issue (E1, E2, AC-5)', () => {
  const a = issue({ title: 'Alpha', number: 1, statusId: ENG_TODO, priority: 1 });
  const b = issue({ title: 'Bravo', number: 2, statusId: ENG_TODO, priority: 2 });
  const c = issue({ title: 'Charlie', number: 3, statusId: ENG_TODO, priority: 3 });

  async function focusRow(m: Mounted, title: string) {
    const row = rows(m.host).find((r) => r.row.textContent.includes(title));
    await inAct(() => row?.row.focus());
  }

  it('keeps focus on the same issue when a live change re-sorts it (E1)', async () => {
    const app = new IssueApp([a, b, c]);
    mounted = await mountLists(app, '/team/ENG/issues');
    await focusRow(mounted, 'Bravo');
    // Bravo becomes the most urgent: it moves to the top of its group.
    await inAct(() => {
      app.setIssues([a, { ...b, priority: 1, updatedAt: '2026-11-13T09:00:00.000Z' }, c]);
    });
    expect(document.activeElement?.closest('[role="row"]')?.textContent).toContain('Bravo');
    const order = rows(mounted.host).map((r) => r.row.textContent);
    expect(order[1]).toContain('Bravo');
  });

  it('moves focus to the neighbour and announces when the focused issue leaves (E2)', async () => {
    const app = new IssueApp([a, b, c]);
    mounted = await mountLists(app, '/team/ENG/issues');
    await focusRow(mounted, 'Bravo');
    const before = announcer.snapshot().serial;
    await inAct(() => {
      app.setIssues([a, c]);
    });
    expect(document.activeElement?.closest('[role="row"]')?.textContent).toContain('Charlie');
    expect(announcer.snapshot().text).toBe('ENG-2 was removed');
    expect(announcer.snapshot().serial).toBeGreaterThan(before);
  });

  it('does not call a collapsed group a removal', async () => {
    const app = new IssueApp([a, b]);
    mounted = await mountLists(app, '/team/ENG/issues');
    const before = announcer.snapshot().serial;
    await inAct(() => mounted?.commands().run('list:toggle-all-groups'));
    expect(announcer.snapshot().serial).toBe(before);
  });

  it('restores the focused issue when the route is revisited', async () => {
    const app = new IssueApp([a, b, c]);
    mounted = await mountLists(app, '/team/ENG/issues');
    await focusRow(mounted, 'Charlie');
    await mounted.unmount();
    mounted = await mountLists(app, '/team/ENG/issues');
    const row = mounted.host.querySelector('[role="row"][tabindex="0"]');
    expect(row?.textContent).toContain('Charlie');
  });
});

describe('My issues', () => {
  const mineTodo = issue({ title: 'Mine', number: 7, assigneeId: ME, statusId: ENG_TODO });
  const mineDone = issue({ title: 'Mine done', number: 8, assigneeId: ME, statusId: ENG_DONE });
  const made = issue({
    title: 'I made it',
    number: 9,
    creatorId: ME,
    assigneeId: OTHER,
    statusId: ENG_TODO,
  });

  it('renders Assigned from the replica, offline too, with the team key in the identifier', async () => {
    const app = new IssueApp([mineTodo, mineDone, made]);
    app.setOnline(false);
    mounted = await mountLists(app, '/my-issues');
    expect(mounted.host.textContent).toContain('ENG-7');
    expect(mounted.host.textContent).toContain('Mine');
    expect(mounted.host.textContent).not.toContain('Mine done');
    expect(mounted.host.textContent).not.toContain('I made it');
    expect(mounted.host.querySelector('[role="treegrid"]')?.getAttribute('aria-label')).toBe(
      'Issues assigned to you',
    );
  });

  it('renders Created with closed issues included and hides tabs that are not built', async () => {
    mounted = await mountLists(
      new IssueApp([mineTodo, made, { ...mineDone, creatorId: ME }]),
      '/my-issues/created',
    );
    const text = mounted.host.textContent;
    expect(text).toContain('I made it');
    expect(text).not.toContain('Mine done'); // Done is collapsed
    expect(text).toContain('Done');
    const tabs = [...mounted.host.querySelectorAll('nav[aria-label="My issues views"] a')].map(
      (a) => a.textContent,
    );
    expect(tabs).toEqual(['Assigned', 'Created']);
    expect(
      mounted.host.querySelector('nav[aria-label="My issues views"] [aria-current="page"]')
        ?.textContent,
    ).toBe('Created');
  });

  it('states the empty Assigned and Created tabs', async () => {
    mounted = await mountLists(new IssueApp([]), '/my-issues');
    expect(mounted.host.textContent).toContain('Nothing is assigned to you');
    expect(mounted.host.textContent).toContain('Issues assigned to you show up here.');
    await mounted.navigate('/my-issues/created');
    expect(mounted.host.textContent).toContain("You haven't created any issues yet");
  });

  it('opens an issue with the My issues list as its source', async () => {
    mounted = await mountLists(new IssueApp([mineTodo]), '/my-issues');
    const row = mounted.host.querySelectorAll<HTMLElement>('[role="row"]')[1];
    await inAct(() => row?.click());
    const source = JSON.parse(
      document.querySelector('[data-testid="issue-source"]')?.textContent ?? 'null',
    ) as { href: string; routeKey: string };
    expect(source.href).toBe('/my-issues');
    expect(source.routeKey).toBe('my-issues:assigned');
  });
});
