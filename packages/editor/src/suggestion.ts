/**
 * A small suggestion engine for the slash menu and the emoji autocomplete (SPEC-013 §3.5). It
 * watches the text before the cursor, asks for items, and drives a list that the React layer
 * renders. It owns `ArrowUp`/`ArrowDown`/`Enter`/`Tab`/`Esc` while the list is open, so `Enter`
 * picks the entry instead of sending a comment (§3.5 "Enter"). Written here instead of using
 * `@tiptap/suggestion` to keep one dependency fewer; the logic is about 100 lines.
 */
import { Extension, type Editor } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

export interface SuggestionMatch {
  /** Document positions of the text to replace, trigger character included. */
  readonly from: number;
  readonly to: number;
  readonly query: string;
}

export interface SuggestionState<T> {
  readonly items: readonly T[];
  readonly index: number;
  readonly match: SuggestionMatch;
  /** Where the trigger sits on screen (viewport coordinates), for placing the list. */
  readonly anchor: { readonly left: number; readonly bottom: number };
}

export interface SuggestionConfig<T> {
  readonly name: string;
  readonly match: (state: EditorState) => SuggestionMatch | null;
  /** Items for a query. May be async (the emoji data loads lazily). */
  readonly items: (query: string) => readonly T[] | Promise<readonly T[]>;
  readonly select: (editor: Editor, match: SuggestionMatch, item: T) => void;
  readonly onChange: (state: SuggestionState<T> | null) => void;
}

export interface SuggestionStorage {
  /** True while the list is showing at least one entry. */
  open: boolean;
}

/** Whether any suggestion list of this editor is open. */
export function isSuggestionOpen(editor: Editor): boolean {
  for (const name of ['slashSuggestion', 'emojiSuggestion']) {
    const storage: unknown = Reflect.get(editor.storage, name);
    if (
      typeof storage === 'object' &&
      storage !== null &&
      'open' in storage &&
      storage.open === true
    ) {
      return true;
    }
  }
  return false;
}

/** Where the trigger is on screen. Layout can fail (a detached or hidden editor): then 0, 0. */
function anchorOf(view: EditorView, pos: number): { left: number; bottom: number } {
  try {
    const { left, bottom } = view.coordsAtPos(pos);
    return { left, bottom };
  } catch {
    return { left: 0, bottom: 0 };
  }
}

export function suggestionExtension<T>(
  config: SuggestionConfig<T>,
): Extension<unknown, SuggestionStorage> {
  return Extension.create<unknown, SuggestionStorage>({
    name: config.name,
    // Above the keymap extensions, so the open list sees the keys first.
    priority: 1100,
    addStorage: () => ({ open: false }),
    addProseMirrorPlugins() {
      const { editor, storage } = this;
      let current: SuggestionState<T> | null = null;
      let dismissedFrom: number | null = null;
      let requestId = 0;
      let lastKey = '';

      const publish = (next: SuggestionState<T> | null) => {
        current = next;
        storage.open = next !== null && next.items.length > 0;
        config.onChange(next);
      };

      const refresh = (view: EditorView) => {
        const match = view.editable ? config.match(view.state) : null;
        if (match === null || match.from === dismissedFrom) {
          if (match === null) dismissedFrom = null;
          lastKey = '';
          requestId += 1;
          if (current !== null) publish(null);
          return;
        }
        const key = `${String(match.from)}:${match.query}`;
        if (key === lastKey && current !== null) return;
        lastKey = key;
        const id = (requestId += 1);
        const show = (items: readonly T[]) => {
          if (id !== requestId) return; // a newer query replaced this one
          const coords = anchorOf(view, match.from);
          const keepIndex =
            current !== null && current.match.from === match.from ? current.index : 0;
          publish({
            items,
            index: Math.min(keepIndex, Math.max(items.length - 1, 0)),
            match,
            anchor: coords,
          });
        };
        const items = config.items(match.query);
        if (Array.isArray(items)) show(items);
        else void Promise.resolve(items).then(show, () => show([]));
      };

      const key = new PluginKey(`surface-${config.name}`);
      return [
        new Plugin({
          key,
          view: (view) => {
            queueMicrotask(() => {
              refresh(view);
            });
            return {
              update: (updated) => {
                refresh(updated);
              },
              destroy: () => {
                requestId += 1;
                storage.open = false;
                config.onChange(null);
              },
            };
          },
          props: {
            handleKeyDown: (view, event) => {
              if (current === null || current.items.length === 0 || event.isComposing) return false;
              const count = current.items.length;
              switch (event.key) {
                case 'ArrowDown':
                  publish({ ...current, index: (current.index + 1) % count });
                  return true;
                case 'ArrowUp':
                  publish({ ...current, index: (current.index + count - 1) % count });
                  return true;
                case 'Enter':
                case 'Tab': {
                  const item = current.items[current.index];
                  if (item === undefined) return false;
                  const { match } = current;
                  publish(null);
                  config.select(editor, match, item);
                  return true;
                }
                case 'Escape':
                  dismissedFrom = current.match.from;
                  publish(null);
                  return true;
                default:
                  return false;
              }
            },
          },
        }),
      ];
    },
  });
}
