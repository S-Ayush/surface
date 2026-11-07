// The command menu's keyboard table (command-menu.md §4) and nested pages (§3.2), including the
// unit part of SPEC-005 AC-4: "Change team color…" opens the palette page, Backspace returns,
// Enter applies and closes. Also what running an option does (§3.4) and E4 on an open page.
import { describe, expect, it, vi } from 'vitest';
import type { Command } from '../src/command-menu/model.js';
import { colorPage } from '../src/command-menu/pages.js';
import { rankCommands, rankPageItems } from '../src/command-menu/ranking.js';
import {
  activeIndex,
  execute,
  initialState,
  keyToAction,
  optionHandlers,
  optionsOf,
  reduce,
  revokedDepth,
  toRows,
  type KeyLike,
  type MenuState,
  type Row,
} from '../src/command-menu/state.js';
import { context, noBoost } from './command-fixtures.js';

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...mods,
});

const commands: Command[] = [
  { id: 'n1', title: 'Go to My issues', section: 'navigation' },
  { id: 'n2', title: 'Go to settings', section: 'navigation' },
  { id: 's1', title: 'Toggle theme', section: 'settings' },
  { id: 'h1', title: 'Keyboard shortcuts', section: 'help' },
];
const rows = toRows(rankCommands(commands, '', context(), noBoost));

function press(state: MenuState, event: KeyLike, mod: 'meta' | 'ctrl' = 'meta') {
  const result = keyToAction(event, state, rows, mod);
  return result.kind === 'action' ? reduce(state, result.action) : state;
}

describe('keyboard', () => {
  const start = initialState({ chip: false });

  it('moves with arrows and Ctrl+N / Ctrl+P, wrapping', () => {
    expect(optionsOf(rows)).toHaveLength(4);
    expect(press(start, key('ArrowDown')).active).toBe(1);
    expect(press(start, key('n', { ctrlKey: true })).active).toBe(1);
    expect(press(start, key('ArrowUp')).active).toBe(3);
    expect(press(start, key('p', { ctrlKey: true })).active).toBe(3);
  });

  it('Tab jumps to the next section, Shift+Tab to the previous, wrapping', () => {
    const second = press(start, key('Tab'));
    expect(second.active).toBe(2);
    expect(press(second, key('Tab')).active).toBe(3);
    expect(press(press(second, key('Tab')), key('Tab')).active).toBe(0);
    expect(press(start, key('Tab', { shiftKey: true })).active).toBe(3);
  });

  it('Enter runs and closes; Mod+Enter runs and keeps the menu open', () => {
    expect(keyToAction(key('Enter'), start, rows, 'meta')).toEqual({
      kind: 'run',
      keepOpen: false,
    });
    expect(keyToAction(key('Enter', { metaKey: true }), start, rows, 'meta')).toEqual({
      kind: 'run',
      keepOpen: true,
    });
    expect(keyToAction(key('Enter', { ctrlKey: true }), start, rows, 'ctrl')).toEqual({
      kind: 'run',
      keepOpen: true,
    });
  });

  it('Backspace on an empty query removes the context chip; with text it edits', () => {
    const withChip = initialState({ chip: true });
    expect(press(withChip, key('Backspace')).chip).toBe(false);
    expect(keyToAction(key('Backspace'), { ...withChip, query: 'x' }, rows, 'meta').kind).toBe(
      'none',
    );
  });

  it('Ctrl+N / Ctrl+P move only on macOS: elsewhere the browser keeps them', () => {
    expect(keyToAction(key('n', { ctrlKey: true }), start, rows, 'ctrl').kind).toBe('none');
    expect(keyToAction(key('p', { ctrlKey: true }), start, rows, 'ctrl').kind).toBe('none');
    expect(press(start, key('ArrowDown'), 'ctrl').active).toBe(1);
  });

  it('leaves keys to an IME while it composes: Enter confirms text, arrows pick a candidate', () => {
    for (const k of ['Enter', 'ArrowDown', 'ArrowUp', 'Tab', 'Backspace']) {
      expect(keyToAction(key(k, { isComposing: true }), start, rows, 'meta').kind).toBe('none');
    }
    // Safari ends a composition with isComposing false and keyCode 229.
    expect(keyToAction(key('Enter', { keyCode: 229 }), start, rows, 'meta').kind).toBe('none');
  });

  it('a held Backspace clears the query but never closes a page or removes the chip', () => {
    const withChip = initialState({ chip: true });
    expect(keyToAction(key('Backspace', { repeat: true }), withChip, rows, 'meta').kind).toBe(
      'none',
    );
  });

  it('keeps the option the user pointed at selected when rows above it go (E4)', () => {
    const pointed = press(press(start, key('ArrowDown')), key('ArrowDown'));
    expect(optionsOf(rows)[activeIndex(pointed, optionsOf(rows))]?.id).toBe('s1');
    // A role change removes "Go to My issues" above it: still "Toggle theme", now second.
    const fewer = toRows(rankCommands(commands.slice(1), '', context(), noBoost));
    expect(optionsOf(fewer)[activeIndex(pointed, optionsOf(fewer))]?.id).toBe('s1');
    // Moving from there continues from "Toggle theme".
    const next = reduce(pointed, { type: 'move', by: 1, rows: fewer });
    expect(next.activeId).toBe('h1');
    // If the pointed-at row itself goes, the position is kept (clamped).
    const gone = toRows(rankCommands(commands.slice(0, 2), '', context(), noBoost));
    expect(activeIndex(pointed, optionsOf(gone))).toBe(1);
  });

  it('typing restarts from the best match and clears an inline error', () => {
    const moved = { ...press(start, key('ArrowDown')), error: 'failed' };
    expect(reduce(moved, { type: 'query', query: 'set' })).toMatchObject({
      active: 0,
      activeId: null,
      error: null,
    });
  });
});

describe('AC-4: nested pages', () => {
  const choose = vi.fn();
  const color: Command = {
    id: 'op:team.updateColor',
    title: 'Change team color…',
    section: 'settings',
    page: () => colorPage('Change team color', choose),
  };

  it('"Change team color…" opens the palette page; Backspace returns; Enter applies', () => {
    let state = reduce(initialState({ chip: true }), { type: 'query', query: 'color' });
    const page = color.page?.(context());
    if (page === undefined) throw new Error('no page');
    state = reduce(state, { type: 'push', frame: { command: color, page } });
    expect(state).toMatchObject({ query: '', active: 0 });
    expect(state.pages.map((frame) => frame.page.title)).toEqual(['Change team color']);

    const items = toRows(rankPageItems(page, ''));
    expect(items).toHaveLength(12);
    state = reduce(state, { type: 'query', query: 'vio' });
    const filtered = toRows(rankPageItems(page, state.query));
    expect(filtered.map((row) => row.kind === 'item' && row.entry.item.title)).toEqual(['Violet']);
    expect(keyToAction(key('Enter'), state, filtered, 'meta')).toEqual({
      kind: 'run',
      keepOpen: false,
    });
    // Enter applies the colour once the menu has closed.
    const applied = execute(optionsOf(filtered)[0], false, context());
    expect(applied).toMatchObject({ kind: 'run', keepOpen: false, record: null });
    if (applied.kind === 'run') void applied.effect();
    expect(choose).toHaveBeenCalledWith('violet');

    // Backspace with text edits the query; on an empty query it goes back and restores "color".
    state = reduce(state, { type: 'query', query: '' });
    const back = keyToAction(key('Backspace'), state, filtered, 'meta');
    expect(back).toEqual({ kind: 'action', action: { type: 'back' } });
    if (back.kind === 'action') state = reduce(state, back.action);
    expect(state).toMatchObject({ pages: [], query: 'color', chip: true });
  });
});

describe('running an option (command-menu.md §3.4)', () => {
  const ctx = context();
  const commandRow = (command: Command): Row => ({
    kind: 'command',
    id: command.id,
    entry: { command, section: command.section, score: 1, indices: [] },
  });

  it('runs a command with the context and records it for frecency', () => {
    const run = vi.fn();
    const execution = execute(
      commandRow({ id: 'x', title: 'X', section: 'settings', run }),
      false,
      ctx,
    );
    expect(execution).toMatchObject({ kind: 'run', keepOpen: false, record: 'x' });
    if (execution.kind === 'run') void execution.effect();
    expect(run).toHaveBeenCalledWith(ctx);
  });

  it('Mod+Enter runs in place: the menu stays open', () => {
    const execution = execute(
      commandRow({ id: 'x', title: 'X', section: 'settings', run: vi.fn() }),
      true,
      ctx,
    );
    expect(execution).toMatchObject({ kind: 'run', keepOpen: true });
  });

  it('opens a command’s page instead of running it, and records it', () => {
    const page = colorPage('Change team color', vi.fn());
    const command: Command = { id: 'c', title: 'Color…', section: 'settings', page: () => page };
    expect(execute(commandRow(command), false, ctx)).toEqual({
      kind: 'push',
      frame: { command, page },
      record: 'c',
    });
  });

  it('reports a page that cannot be built, and does nothing for no option', () => {
    const broken: Command = {
      id: 'b',
      title: 'Broken…',
      section: 'settings',
      page: () => {
        throw new Error('no data');
      },
    };
    expect(execute(commandRow(broken), false, ctx)).toEqual({ kind: 'failed' });
    expect(execute(undefined, false, ctx)).toEqual({ kind: 'none' });
  });

  it('a click runs the clicked option, not the selected one', () => {
    const [selectedRow, clickedRow] = optionsOf(rows);
    if (selectedRow === undefined || clickedRow === undefined) throw new Error('no rows');
    const dispatch = vi.fn();
    const perform = vi.fn();
    optionHandlers(clickedRow, 1, false, { dispatch, perform }).onClick();
    expect(perform).toHaveBeenCalledExactlyOnceWith(clickedRow, false);
    expect(dispatch).toHaveBeenCalledWith({ type: 'activate', index: 1, id: clickedRow.id });
  });

  it('hovering selects an option once', () => {
    const [row] = optionsOf(rows);
    if (row === undefined) throw new Error('no rows');
    const dispatch = vi.fn();
    optionHandlers(row, 0, false, { dispatch, perform: vi.fn() }).onMouseMove();
    optionHandlers(row, 0, true, { dispatch, perform: vi.fn() }).onMouseMove();
    expect(dispatch).toHaveBeenCalledOnce();
  });
});

describe('E4 on an open page', () => {
  it('closes a page whose command is no longer offered, and says why', () => {
    let allowed = true;
    const color: Command = {
      id: 'op:team.updateColor',
      title: 'Change team color…',
      section: 'settings',
      when: () => allowed,
      page: () => colorPage('Change team color', vi.fn()),
    };
    const page = colorPage('Change team color', vi.fn());
    let state = reduce(initialState({ chip: false }), { type: 'query', query: 'col' });
    state = reduce(state, { type: 'push', frame: { command: color, page } });
    expect(revokedDepth(state.pages, context())).toBe(-1);
    allowed = false; // the role change arrives
    const depth = revokedDepth(state.pages, context());
    expect(depth).toBe(0);
    state = reduce(state, { type: 'revoke', depth, message: 'Gone.' });
    expect(state).toMatchObject({ pages: [], query: 'col', error: 'Gone.' });
  });
});

describe('virtualisation (command-menu.md §5)', () => {
  it('renders the rows in view plus an overscan of 8', async () => {
    const { visibleRange, VIRTUALIZE_ABOVE } = await import('../src/command-menu/CommandMenu.js');
    expect(VIRTUALIZE_ABOVE).toBe(50);
    expect(visibleRange({ scrollTop: 0, viewport: 320, rowHeight: 32, count: 300 })).toEqual({
      first: 0,
      last: 18,
    });
    expect(visibleRange({ scrollTop: 3200, viewport: 320, rowHeight: 32, count: 300 })).toEqual({
      first: 92,
      last: 118,
    });
    expect(visibleRange({ scrollTop: 9500, viewport: 320, rowHeight: 32, count: 300 })).toEqual({
      first: 288,
      last: 300,
    });
  });
});
