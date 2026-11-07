// The command target (SPEC-005 §6): what the context chip shows and Suggested acts on. Precedence
// is by level, not by mount order, which differs between a reload and in-app navigation.
import { describe, expect, it, vi } from 'vitest';
import { TargetStore } from '../src/command-menu/context.js';
import type { CommandTarget } from '../src/command-menu/model.js';

const team: CommandTarget = { kind: 'team', ids: ['t1'], label: 'ENG' };
const issue: CommandTarget = { kind: 'issue', ids: ['i1'], label: 'ENG-1' };
const selection = (n: number): CommandTarget => ({
  kind: 'issues',
  ids: Array.from({ length: n }, (_, i) => `i${i}`),
  label: `${n} selected issues`,
});

describe('command target', () => {
  it('is global with nothing set', () => {
    expect(new TargetStore().current()).toEqual({ kind: 'global' });
  });

  it('the more specific level wins whichever registers first (reload vs navigation)', () => {
    // Reload: React registers the child (the focused issue) before its parent (the team page).
    const reload = new TargetStore();
    reload.push(issue, 'focus');
    reload.push(team, 'page');
    expect(reload.current()).toBe(issue);
    // In-app navigation: the team page was already there.
    const navigated = new TargetStore();
    navigated.push(team, 'page');
    navigated.push(issue, 'focus');
    expect(navigated.current()).toBe(issue);
  });

  it('a relabel keeps its place: the page updating does not cover the selection', () => {
    const store = new TargetStore();
    const page = store.push(team, 'page');
    const selected = store.push(selection(2), 'selection');
    page.update({ ...team, label: 'Engineering' });
    expect(store.current()).toMatchObject({ label: '2 selected issues' });
    selected.update(selection(3));
    expect(store.current()).toMatchObject({ label: '3 selected issues' });
  });

  it('a relabel within a level does not move the entry ahead of a newer one', () => {
    const store = new TargetStore();
    const layout = store.push(team, 'page');
    store.push({ kind: 'project', ids: ['p1'], label: 'Launch' }, 'page');
    layout.update({ ...team, label: 'Engineering' }); // a rename arrives by delta
    expect(store.current()).toMatchObject({ label: 'Launch' });
  });

  it('within a level the newest wins, and removing it restores the previous one', () => {
    const store = new TargetStore();
    store.push(team, 'page');
    const other = store.push({ ...team, ids: ['t2'], label: 'DES' }, 'page');
    expect(store.current()).toMatchObject({ label: 'DES' });
    other.remove();
    expect(store.current()).toBe(team);
  });

  it('notifies subscribers on every change', () => {
    const store = new TargetStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const entry = store.push(team);
    entry.update(issue);
    entry.remove();
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
