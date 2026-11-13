// PLAN-010 S3 (SPEC-010 §7.1, shortcuts.md §3.4c): the keys of a label row go through the shortcut
// engine in the `settings-row` scope and nowhere else. The handlers are the labels page's real
// ones (`rowKeys.ts`); the engine is the real engine over the registry's M1 bindings, with fake
// elements for the focus, like `settings-row-keys.test.tsx` does for statuses.
import { describe, expect, it, vi } from 'vitest';
import { SHORTCUTS, inBuild } from '../src/shortcuts/registry.js';
import { labelIdOf, labelRowHandlers } from '../src/features/labels/rowKeys.js';
import { element, setup } from './shortcut-fakes.js';

const ROW = 'label-1';

const row = element('div', {
  attrs: { 'data-shortcut-scope': 'settings-row', 'data-label-id': ROW, role: 'option' },
});
const field = element('input', { type: 'text' });
const fieldInRow = element('input', { type: 'text', parent: row });

function mount({
  canEdit = true,
  focused = ROW,
}: { canEdit?: boolean; focused?: string | null } = {}) {
  const actions = { edit: vi.fn(), editName: vi.fn(), remove: vi.fn() };
  const harness = setup({ bindings: inBuild(SHORTCUTS, 'M1'), platform: 'mac' });
  const handlers = labelRowHandlers(
    () => focused ?? undefined,
    () => canEdit,
    actions,
  );
  for (const id of [
    'settings-row:edit',
    'settings-row:edit-name',
    'settings-row:delete',
  ] as const) {
    const handler = handlers[id];
    if (handler !== undefined) harness.commands.register(id, handler);
  }
  return { ...harness, actions };
}

const key = {
  enter: { key: 'Enter', code: 'Enter' },
  e: { key: 'e', code: 'KeyE' },
  modBackspace: { key: 'Backspace', code: 'Backspace', metaKey: true },
};

describe('the keys of a label row', () => {
  it('Enter edits the focused row, once', () => {
    const { press, actions } = mount();
    expect(press(key.enter, row).taken).toBe(true);
    expect(actions.edit.mock.calls).toEqual([[ROW]]);
    expect(actions.editName).not.toHaveBeenCalled();
    expect(actions.remove).not.toHaveBeenCalled();
  });

  it('E edits the name of the focused row, once', () => {
    const { press, actions } = mount();
    press(key.e, row);
    expect(actions.editName.mock.calls).toEqual([[ROW]]);
    expect(actions.edit).not.toHaveBeenCalled();
  });

  it('Mod+Backspace asks to delete the focused row, once', () => {
    const { press, actions } = mount();
    press(key.modBackspace, row);
    expect(actions.remove.mock.calls).toEqual([[ROW]]);
  });

  it('E and Mod+Backspace are text editing, not commands, inside a text field', () => {
    const { press, actions } = mount();
    press(key.e, fieldInRow);
    press(key.modBackspace, fieldInRow);
    press(key.e, field);
    press(key.modBackspace, field);
    expect(actions.editName).not.toHaveBeenCalled();
    expect(actions.remove).not.toHaveBeenCalled();
  });

  it('does nothing for a reader of a public team, and says it is not available', () => {
    const { press, actions, hints } = mount({ canEdit: false });
    press(key.enter, row);
    press(key.e, row);
    press(key.modBackspace, row);
    expect(actions.edit).not.toHaveBeenCalled();
    expect(actions.editName).not.toHaveBeenCalled();
    expect(actions.remove).not.toHaveBeenCalled();
    expect(hints.unavailable).toHaveBeenCalled();
  });

  it('does nothing when no row has focus, or outside the settings-row scope', () => {
    const none = mount({ focused: null });
    none.press(key.enter, row);
    expect(none.actions.edit).not.toHaveBeenCalled();
    const outside = mount();
    outside.press(key.enter);
    outside.press(key.e);
    expect(outside.actions.edit).not.toHaveBeenCalled();
    expect(outside.actions.editName).not.toHaveBeenCalled();
  });
});

describe('labelIdOf', () => {
  it('finds the label id of the row that holds the focused element', () => {
    expect(labelIdOf(row as unknown as Element)).toBe(ROW);
    expect(labelIdOf(fieldInRow as unknown as Element)).toBe(ROW);
    expect(labelIdOf(field as unknown as Element)).toBeUndefined();
    expect(labelIdOf(null)).toBeUndefined();
  });
});
