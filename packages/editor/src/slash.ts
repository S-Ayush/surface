/**
 * The slash menu (SPEC-013 §3.5): `/` on an empty line lists the blocks, plus Image and File,
 * which open the file chooser and upload through the host's `onUploadFile`.
 */
import type { Editor } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import type { SuggestionMatch } from './suggestion.js';

export type SlashItem =
  | {
      readonly kind: 'block';
      readonly id: string;
      readonly label: string;
      readonly keywords: string;
      readonly run: (editor: Editor) => void;
    }
  | {
      readonly kind: 'upload';
      readonly id: string;
      readonly label: string;
      readonly keywords: string;
      readonly upload: 'image' | 'file';
    };

const block = (
  id: string,
  label: string,
  keywords: string,
  run: (editor: Editor) => void,
): SlashItem => ({ kind: 'block', id, label, keywords, run });

const ITEMS: readonly SlashItem[] = [
  block(
    'text',
    'Text',
    'paragraph plain',
    (e) => void e.chain().focus().setNode('paragraph').run(),
  ),
  ...[1, 2, 3, 4].map((level) =>
    block(
      `heading-${String(level)}`,
      `Heading ${String(level)}`,
      `h${String(level)} title`,
      (e) => void e.chain().focus().setNode('heading', { level }).run(),
    ),
  ),
  block(
    'bullets',
    'Bulleted list',
    'ul unordered',
    (e) => void e.chain().focus().toggleList('bulletList', 'listItem').run(),
  ),
  block(
    'numbers',
    'Numbered list',
    'ol ordered',
    (e) => void e.chain().focus().toggleList('orderedList', 'listItem').run(),
  ),
  block(
    'checklist',
    'Checklist',
    'todo task',
    (e) => void e.chain().focus().toggleList('taskList', 'taskItem').run(),
  ),
  block(
    'quote',
    'Block quote',
    'blockquote',
    (e) => void e.chain().focus().toggleWrap('blockquote').run(),
  ),
  block(
    'code',
    'Code block',
    'fence pre',
    (e) => void e.chain().focus().setNode('codeBlock').run(),
  ),
  block(
    'divider',
    'Divider',
    'rule hr line',
    (e) => void e.chain().focus().insertContent({ type: 'horizontalRule' }).run(),
  ),
  { kind: 'upload', id: 'image', label: 'Image', keywords: 'picture photo', upload: 'image' },
  { kind: 'upload', id: 'file', label: 'File', keywords: 'attachment upload', upload: 'file' },
];

export function slashItems(query: string): readonly SlashItem[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return ITEMS;
  return ITEMS.filter(
    (item) => item.label.toLowerCase().includes(needle) || item.keywords.includes(needle),
  );
}

/** `/` and a short query alone in a paragraph. */
export function matchSlashTrigger(state: EditorState): SuggestionMatch | null {
  const { $from, empty } = state.selection;
  const parent = $from.parent;
  if (!empty || parent.type.name !== 'paragraph') return null;
  const found = /^\/([A-Za-z0-9 ]{0,20})$/.exec(parent.textContent);
  const query = found?.[1];
  if (query === undefined || $from.parentOffset !== parent.content.size) return null;
  return { from: $from.start(), to: $from.pos, query };
}

/** Removes the `/query` and runs the chosen entry. */
export function applySlash(
  editor: Editor,
  match: SuggestionMatch,
  item: SlashItem,
  chooseFile: (kind: 'image' | 'file') => void,
): void {
  editor.chain().focus().deleteRange({ from: match.from, to: match.to }).run();
  if (item.kind === 'upload') chooseFile(item.upload);
  else item.run(editor);
}
