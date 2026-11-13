// The keys of a label row (SPEC-010 §7.1, shortcuts.md §3.4c): `Enter` edits the row, `E` edits its
// name, `Mod+Backspace` deletes. They are bindings of the `settings-row` scope in the shortcut
// registry (PLAN-012 S1), so this file has no key handling of its own: it only says what each
// command does to the row that has focus. A row carries `data-shortcut-scope="settings-row"` and
// `data-label-id`. Labels have no manual order, so `Alt+↑/↓` is not handled here.
import type { CommandId } from '../../commands/catalog.js';
import type { CommandHandler } from '../../commands/registry.js';

export type LabelRowActions = {
  edit(labelId: string): void;
  editName(labelId: string): void;
  remove(labelId: string): void;
};

export const LABEL_ROW_ATTRIBUTE = 'data-label-id';

/** The label id of the row that holds `element`, if any. */
export function labelIdOf(element: Element | null): string | undefined {
  const id = element?.closest(`[${LABEL_ROW_ATTRIBUTE}]`)?.getAttribute(LABEL_ROW_ATTRIBUTE);
  return id ?? undefined;
}

type RowCommandId = Extract<CommandId, `settings-row:${string}`>;

/**
 * The handlers for the focused label row. `focusedId` reads the row with focus when a key is
 * pressed; `canEdit` is false for a reader of a public team (§7.1), who still sees the rows.
 */
export function labelRowHandlers(
  focusedId: () => string | undefined,
  canEdit: () => boolean,
  actions: LabelRowActions,
): Readonly<Partial<Record<RowCommandId, CommandHandler>>> {
  const handler = (run: (id: string) => void): CommandHandler => ({
    when: () => canEdit() && focusedId() !== undefined,
    run: () => {
      const id = focusedId();
      if (id !== undefined) run(id);
    },
  });
  return {
    'settings-row:edit': handler((id) => actions.edit(id)),
    'settings-row:edit-name': handler((id) => actions.editName(id)),
    'settings-row:delete': handler((id) => actions.remove(id)),
  };
}
