// The keys of a status row (SPEC-010 §7.1, shortcuts.md §3.4c): `Enter` edit, `Alt+↑/↓` move one
// position, `Mod+Backspace` delete. They are bindings of the `settings-row` scope in the shortcut
// registry (PLAN-012 S1), so this file has no key handling of its own: it only says what each
// command does to the row that has focus. A row carries `data-shortcut-scope="settings-row"` and
// `data-status-id`; `Esc` is the page's `ui:escape` step (WorkflowScreen).
import type { CommandId } from '../../commands/catalog.js';
import type { CommandHandler } from '../../commands/registry.js';

export type StatusRowActions = {
  edit(statusId: string): void;
  move(statusId: string, direction: 'up' | 'down'): void;
  remove(statusId: string): void;
};

export const STATUS_ROW_ATTRIBUTE = 'data-status-id';

/** The status id of the row that holds `element`, if any. */
export function statusIdOf(element: Element | null): string | undefined {
  const id = element?.closest(`[${STATUS_ROW_ATTRIBUTE}]`)?.getAttribute(STATUS_ROW_ATTRIBUTE);
  return id ?? undefined;
}

export type RowFocusKey = {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  /** The event's target is a row itself, not a field of a form inside the list. */
  readonly onRow: boolean;
};

/**
 * Where plain ↑/↓/Home/End move focus among `count` rows from row `at`, or undefined when the key
 * is not ours: a text field inside the list keeps its own cursor keys, and a modified key
 * (`Alt+↑/↓` is a `settings-row` binding) belongs to the engine.
 */
export function rowFocusTarget(event: RowFocusKey, at: number, count: number): number | undefined {
  if (!event.onRow || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return undefined;
  }
  const target =
    event.key === 'ArrowDown'
      ? at + 1
      : event.key === 'ArrowUp'
        ? at - 1
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? count - 1
            : undefined;
  return target !== undefined && target >= 0 && target < count ? target : undefined;
}

type RowCommandId = Extract<CommandId, `settings-row:${string}`>;

/**
 * The handlers for the focused status row. `focusedId` reads the row with focus when a key is
 * pressed; `canEdit` is false for a reader of a public team (§3.1), who still sees the rows.
 * A command applies only while a row has focus and the user may edit.
 */
export function statusRowHandlers(
  focusedId: () => string | undefined,
  canEdit: () => boolean,
  actions: StatusRowActions,
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
    'settings-row:move-up': handler((id) => actions.move(id, 'up')),
    'settings-row:move-down': handler((id) => actions.move(id, 'down')),
    'settings-row:delete': handler((id) => actions.remove(id)),
  };
}
