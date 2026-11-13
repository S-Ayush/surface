/**
 * The editor's keys (SPEC-013 §3.5 "Keys", "Enter"). Two layers:
 *
 * - `FormattingKeys`: one `handleKeyDown` that matches letters on `event.key` and digits and
 *   punctuation on `event.code` (`Digit7`, `Period`, `Backslash`), so macOS Option and other
 *   layouts still work.
 * - `BlockKeys`: Enter, Shift+Enter, Tab and Backspace in lists, and `Mod+Enter`. TipTap's core
 *   keymap binds `Mod+Enter` to `exitCode`, and its handler would call `preventDefault`, hiding
 *   the shortcut from the engine (`apps/web/src/shortcuts/engine.ts` skips handled events). So the
 *   core `Keymap` is replaced by a copy without that binding (`CoreKeymap`).
 */
import { extensions, type Editor, type KeyboardShortcutCommand } from '@tiptap/core';
import { TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';

export type EditorMode = 'comment' | 'description';

export interface KeyHandlers {
  readonly mode: EditorMode;
  /** Comment mode `Enter` (outside blocks) and the host's send. */
  readonly onSubmit: () => void;
  /** `Mod+K` with a selection: the bubble menu opens its link field. */
  readonly openLink: () => void;
}

/** Core keymap without `Mod-Enter`. */
export const CoreKeymap = extensions.Keymap.extend({
  addKeyboardShortcuts() {
    const shortcuts: Record<string, KeyboardShortcutCommand> = { ...this.parent?.() };
    delete shortcuts['Mod-Enter'];
    return shortcuts;
  },
});

const isMac = (): boolean =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function hasMod(event: KeyboardEvent): boolean {
  return isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export interface Binding {
  readonly mod?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
  /** Matched on `event.key`, lower case. */
  readonly key?: string;
  /** Matched on `event.code`. */
  readonly code?: string;
  readonly run: (editor: Editor) => boolean;
}

export function inside(state: EditorState, names: readonly string[]): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if (names.includes($from.node(depth).type.name)) return true;
  }
  return false;
}

/** Moves the block (or list item) around the cursor past its neighbour. */
export function moveBlock(state: EditorState, direction: -1 | 1): Transaction | null {
  const { $from } = state.selection;
  let depth = $from.depth;
  for (let level = $from.depth; level > 0; level -= 1) {
    const name = $from.node(level).type.name;
    if (name === 'listItem' || name === 'taskItem') {
      depth = level;
      break;
    }
    if (level === 1) depth = 1;
  }
  if (depth < 1) return null;
  const parent = $from.node(depth - 1);
  const index = $from.index(depth - 1);
  const siblingIndex = index + direction;
  if (siblingIndex < 0 || siblingIndex >= parent.childCount) return null;
  const node = parent.child(index);
  const sibling = parent.child(siblingIndex);
  const start = $from.before(depth);
  const end = start + node.nodeSize;
  const tr = state.tr;
  const delta = direction === -1 ? -sibling.nodeSize : sibling.nodeSize;
  tr.delete(start, end);
  tr.insert(direction === -1 ? start - sibling.nodeSize : start + sibling.nodeSize, node);
  const target = Math.min(Math.max(state.selection.from + delta, 1), tr.doc.content.size - 1);
  tr.setSelection(TextSelection.near(tr.doc.resolve(target)));
  return tr.scrollIntoView();
}

export const BINDINGS: readonly Binding[] = [
  { mod: true, key: 'b', run: (e) => e.commands.toggleMark('bold') },
  { mod: true, key: 'i', run: (e) => e.commands.toggleMark('italic') },
  { mod: true, key: 'u', run: (e) => e.commands.toggleMark('underline') },
  { mod: true, shift: true, key: 'x', run: (e) => e.commands.toggleMark('strike') },
  { mod: true, key: 'e', run: (e) => e.commands.toggleMark('code') },
  { alt: true, shift: true, code: 'Period', run: (e) => e.commands.toggleWrap('blockquote') },
  { mod: true, alt: true, code: 'Digit0', run: (e) => e.commands.setNode('paragraph') },
  ...[1, 2, 3, 4].map((level): Binding => ({
    mod: true,
    alt: true,
    code: `Digit${String(level)}`,
    run: (e) => e.commands.toggleNode('heading', 'paragraph', { level }),
  })),
  {
    mod: true,
    shift: true,
    code: 'Digit7',
    run: (e) => e.commands.toggleList('taskList', 'taskItem'),
  },
  {
    mod: true,
    shift: true,
    code: 'Digit8',
    run: (e) => e.commands.toggleList('bulletList', 'listItem'),
  },
  {
    mod: true,
    shift: true,
    code: 'Digit9',
    run: (e) => e.commands.toggleList('orderedList', 'listItem'),
  },
  {
    mod: true,
    shift: true,
    code: 'Backslash',
    run: (e) => e.commands.toggleNode('codeBlock', 'paragraph'),
  },
  {
    alt: true,
    code: 'ArrowUp',
    run: (e) =>
      e.commands.command(({ state, dispatch }) => {
        const tr = moveBlock(state, -1);
        if (tr === null) return false;
        dispatch?.(tr);
        return true;
      }),
  },
  {
    alt: true,
    code: 'ArrowDown',
    run: (e) =>
      e.commands.command(({ state, dispatch }) => {
        const tr = moveBlock(state, 1);
        if (tr === null) return false;
        dispatch?.(tr);
        return true;
      }),
  },
];

export function matches(binding: Binding, event: KeyboardEvent): boolean {
  if ((binding.mod ?? false) !== hasMod(event)) return false;
  if ((binding.shift ?? false) !== event.shiftKey) return false;
  if ((binding.alt ?? false) !== event.altKey) return false;
  if (binding.code !== undefined) return event.code === binding.code;
  return binding.key !== undefined && event.key.toLowerCase() === binding.key;
}
