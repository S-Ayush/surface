/**
 * Formatting keys (a `handleKeyDown` plugin) and block keys (Enter, Shift+Enter, Mod+Enter, Tab,
 * Backspace) of the editor (SPEC-013 §3.5). Bindings live in `keymap.ts`.
 */
import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type EditorState } from '@tiptap/pm/state';
import { BINDINGS, hasMod, inside, letterOf, matches, type KeyHandlers } from './keymap.js';
import { isSuggestionOpen } from './suggestion.js';

/** A mutable holder: the host's callbacks change between renders, the extensions don't. */
export interface HandlerRef {
  current: KeyHandlers;
}

/** Formatting, block, move and link keys. */
export function formattingKeys(ref: HandlerRef): Extension {
  return Extension.create({
    name: 'surfaceFormattingKeys',
    priority: 900,
    addProseMirrorPlugins() {
      const { editor } = this;
      return [
        new Plugin({
          key: new PluginKey('surfaceFormattingKeys'),
          props: {
            handleKeyDown: (view, event) => {
              if (!view.editable || event.isComposing) return false;
              if (hasMod(event) && !event.shiftKey && !event.altKey && letterOf(event) === 'k') {
                // Without a text selection the key is not consumed, so the command menu opens
                // (shortcuts §3.7, SPEC-005 E1).
                const { selection } = view.state;
                if (
                  selection.empty ||
                  !(selection instanceof TextSelection) ||
                  inside(view.state, ['codeBlock'])
                ) {
                  return false;
                }
                ref.current.openLink();
                return true;
              }
              const binding = BINDINGS.find((candidate) => matches(candidate, event));
              return binding !== undefined && binding.run(editor);
            },
          },
        }),
      ];
    },
  });
}

const SENDING_BLOCKS = ['bulletList', 'orderedList', 'taskList', 'blockquote', 'codeBlock'];

function listItemName(state: EditorState): 'listItem' | 'taskItem' | null {
  if (inside(state, ['taskItem'])) return 'taskItem';
  if (inside(state, ['listItem'])) return 'listItem';
  return null;
}

/** Enter, Shift+Enter, Mod+Enter, Tab and Backspace (SPEC-013 §3.5 "Enter"). */
export function blockKeys(ref: HandlerRef): Extension {
  return Extension.create({
    name: 'surfaceBlockKeys',
    priority: 900,
    addKeyboardShortcuts() {
      const { editor } = this;
      return {
        Enter: () => {
          const { state } = editor;
          if (editor.view.composing || isSuggestionOpen(editor)) return false;
          if (ref.current.mode === 'comment' && !inside(state, SENDING_BLOCKS)) {
            ref.current.onSubmit();
            return true;
          }
          const item = listItemName(state);
          if (item !== null) return editor.commands.splitListItem(item);
          const { $from, empty } = state.selection;
          const parent = $from.parent;
          if (
            empty &&
            parent.type.name === 'codeBlock' &&
            $from.parentOffset === parent.content.size &&
            parent.textContent.endsWith('\n')
          ) {
            // The second Enter on an empty last line leaves the block.
            return editor
              .chain()
              .command(({ tr }) => {
                tr.delete($from.pos - 1, $from.pos);
                return true;
              })
              .exitCode()
              .run();
          }
          return false;
        },
        'Shift-Enter': () => {
          const { state } = editor;
          if (inside(state, ['codeBlock'])) return editor.commands.newlineInCode();
          const hardBreak = state.schema.nodes['hardBreak'];
          if (hardBreak === undefined) return false;
          return editor.commands.command(({ tr }) => {
            tr.replaceSelectionWith(hardBreak.create()).scrollIntoView();
            return true;
          });
        },
        // Only a checklist item takes Mod+Enter; elsewhere the shortcut engine gets it.
        'Mod-Enter': () => {
          const { $from } = editor.state.selection;
          for (let depth = $from.depth; depth > 0; depth -= 1) {
            const node: PMNode = $from.node(depth);
            if (node.type.name !== 'taskItem') continue;
            const pos = $from.before(depth);
            return editor.commands.command(({ tr }) => {
              tr.setNodeMarkup(pos, undefined, {
                ...node.attrs,
                checked: node.attrs['checked'] !== true,
              });
              return true;
            });
          }
          return false;
        },
        Tab: () => {
          const item = listItemName(editor.state);
          return item !== null && editor.commands.sinkListItem(item);
        },
        'Shift-Tab': () => {
          const item = listItemName(editor.state);
          return item !== null && editor.commands.liftListItem(item);
        },
        Backspace: () => {
          const { $from, empty } = editor.state.selection;
          if (!empty || $from.parentOffset !== 0 || $from.depth < 2) return false;
          if ($from.index($from.depth - 1) !== 0) return false;
          const holder = $from.node($from.depth - 1).type.name;
          if (holder !== 'listItem' && holder !== 'taskItem') return false;
          return editor.commands.liftListItem(holder);
        },
      };
    },
  });
}
