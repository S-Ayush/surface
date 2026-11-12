// PLAN-012 S1's handoff to PLAN-010 S2: the keys of a settings row go through the shortcut engine
// in the `settings-row` scope and nowhere else, so one key press runs one action (SPEC-010 §7.1,
// shortcuts.md §3.4c). The row's handlers are the workflow page's real ones (`rowKeys.ts`); the
// engine is the real engine over the registry's M1 bindings, with fake elements for the focus.
import { describe, expect, it, vi } from 'vitest';
import { SHORTCUTS, inBuild } from '../src/shortcuts/registry.js';
import {
  rowFocusTarget,
  statusIdOf,
  statusRowHandlers,
  type RowFocusKey,
} from '../src/features/statuses/rowKeys.js';
import { element, setup } from './shortcut-fakes.js';

const ROW = 'status-1';

/** A focused status row, as the page renders it: scope and id on the element that has focus. */
const row = element('div', {
  attrs: { 'data-shortcut-scope': 'settings-row', 'data-status-id': ROW, role: 'option' },
});
/** A text field of the inline form: outside any row, so `Mod+Backspace` is text editing. */
const field = element('input', { type: 'text' });
/** A text field inside a row's scope, as a row that holds an input would have. */
const fieldInRow = element('input', { type: 'text', parent: row });

function mount({
  canEdit = true,
  focused = ROW,
}: { canEdit?: boolean; focused?: string | null } = {}) {
  const actions = { edit: vi.fn(), move: vi.fn(), remove: vi.fn() };
  const harness = setup({ bindings: inBuild(SHORTCUTS, 'M1'), platform: 'mac' });
  const handlers = statusRowHandlers(
    () => focused ?? undefined,
    () => canEdit,
    actions,
  );
  for (const id of [
    'settings-row:edit',
    'settings-row:move-up',
    'settings-row:move-down',
    'settings-row:delete',
  ] as const) {
    const handler = handlers[id];
    if (handler !== undefined) harness.commands.register(id, handler);
  }
  return { ...harness, actions };
}

const key = {
  enter: { key: 'Enter', code: 'Enter' },
  altUp: { key: 'ArrowUp', code: 'ArrowUp', altKey: true },
  altDown: { key: 'ArrowDown', code: 'ArrowDown', altKey: true },
  modBackspace: { key: 'Backspace', code: 'Backspace', metaKey: true },
};

describe('the keys of a status row', () => {
  it('Enter edits the focused row, once', () => {
    const { press, actions } = mount();
    expect(press(key.enter, row).taken).toBe(true);
    expect(actions.edit).toHaveBeenCalledTimes(1);
    expect(actions.edit).toHaveBeenCalledWith(ROW);
    expect(actions.move).not.toHaveBeenCalled();
    expect(actions.remove).not.toHaveBeenCalled();
  });

  it('Alt+↑ and Alt+↓ move the focused row one position, once each', () => {
    const { press, actions } = mount();
    press(key.altUp, row);
    expect(actions.move.mock.calls).toEqual([[ROW, 'up']]);
    press(key.altDown, row);
    expect(actions.move.mock.calls).toEqual([
      [ROW, 'up'],
      [ROW, 'down'],
    ]);
    expect(actions.edit).not.toHaveBeenCalled();
  });

  it('Mod+Backspace asks to delete the focused row, once', () => {
    const { press, actions } = mount();
    press(key.modBackspace, row);
    expect(actions.remove.mock.calls).toEqual([[ROW]]);
  });

  it('Mod+Backspace is text editing, not a delete, inside a text field', () => {
    const { press, actions } = mount();
    press(key.modBackspace, fieldInRow);
    press(key.modBackspace, field);
    expect(actions.remove).not.toHaveBeenCalled();
  });

  it('does nothing for a reader of a public team, and says it is not available', () => {
    const { press, actions, hints } = mount({ canEdit: false });
    press(key.enter, row);
    press(key.altUp, row);
    press(key.modBackspace, row);
    expect(actions.edit).not.toHaveBeenCalled();
    expect(actions.move).not.toHaveBeenCalled();
    expect(actions.remove).not.toHaveBeenCalled();
    expect(hints.unavailable).toHaveBeenCalled();
  });

  it('does nothing when no row has focus', () => {
    const { press, actions } = mount({ focused: null });
    press(key.enter, row);
    expect(actions.edit).not.toHaveBeenCalled();
  });

  it('runs nothing outside the settings-row scope', () => {
    const { press, actions } = mount();
    press(key.enter);
    press(key.altUp);
    expect(actions.edit).not.toHaveBeenCalled();
    expect(actions.move).not.toHaveBeenCalled();
  });
});

describe('statusIdOf', () => {
  it('finds the status id of the row that holds the focused element', () => {
    expect(statusIdOf(row as unknown as Element)).toBe(ROW);
    expect(statusIdOf(fieldInRow as unknown as Element)).toBe(ROW);
    expect(statusIdOf(field as unknown as Element)).toBeUndefined();
    expect(statusIdOf(null)).toBeUndefined();
  });
});

describe('rowFocusTarget (plain ↑/↓/Home/End between rows)', () => {
  const press = (key: string, extra: Partial<RowFocusKey> = {}): RowFocusKey => ({
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    onRow: true,
    ...extra,
  });

  it('moves between rows, and to the first and last', () => {
    expect(rowFocusTarget(press('ArrowDown'), 1, 4)).toBe(2);
    expect(rowFocusTarget(press('ArrowUp'), 1, 4)).toBe(0);
    expect(rowFocusTarget(press('Home'), 2, 4)).toBe(0);
    expect(rowFocusTarget(press('End'), 1, 4)).toBe(3);
    expect(rowFocusTarget(press('ArrowUp'), 0, 4)).toBeUndefined();
    expect(rowFocusTarget(press('ArrowDown'), 3, 4)).toBeUndefined();
  });

  it('leaves the keys of a text field in a form inside the list alone', () => {
    for (const key of ['ArrowUp', 'ArrowDown', 'Home', 'End']) {
      expect(rowFocusTarget(press(key, { onRow: false }), 1, 4)).toBeUndefined();
    }
  });

  it('leaves modified keys to the engine, so Alt+↑/↓ never runs twice', () => {
    for (const extra of [
      { altKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
    ]) {
      expect(rowFocusTarget(press('ArrowUp', extra), 2, 4)).toBeUndefined();
    }
  });
});
