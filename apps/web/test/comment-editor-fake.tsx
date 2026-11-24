// A stand-in for `features/comments/editor-host.tsx` in the comment flow and composer tests: a textarea where the
// real one lazy-loads TipTap. Typing in a textarea is deterministic in jsdom; the editor's own keys
// (`Enter` sends, `Mod+Enter` reaches the engine, AC-19, AC-24) are `editor-keys.test.tsx`. This
// fake keeps that contract: `Enter` calls `onSubmit`, `Mod+Enter` is left to the shortcut engine.
import { EMPTY_DOC, type DocNodeJSON } from '@surface/domain';
import type { DocViewProps, RichTextEditorProps } from '@surface/editor';
import type { PickerEmoji } from '@surface/ui';
import { useEffect, useImperativeHandle, useRef } from 'react';

export const textOf = (doc: DocNodeJSON): string =>
  (doc.content ?? [])
    .map((block) => (block.content ?? []).map((node) => node.text ?? '').join(''))
    .join('\n');

export const docOfText = (text: string): DocNodeJSON =>
  text === ''
    ? EMPTY_DOC
    : {
        type: 'doc',
        content: text
          .split('\n')
          .map((line) =>
            line === ''
              ? { type: 'paragraph' }
              : { type: 'paragraph', content: [{ type: 'text', text: line }] },
          ),
      };

/**
 * What the fake saw of the editor's upload contract (PLAN-014 S5): each `openFileChooser` call, by
 * the editor's label, and the latest `onUploadFile` it was given.
 */
export const editorUploads: {
  chooserOpened: string[];
  uploadFile: RichTextEditorProps['onUploadFile'];
} = { chooserOpened: [], uploadFile: undefined };

export function CommentEditor({
  value,
  onChange,
  onSubmit,
  onBlur,
  ariaLabel,
  placeholder,
  autofocus,
  onUploadFile,
  ref,
}: RichTextEditorProps) {
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    editorUploads.uploadFile = onUploadFile;
  });
  useImperativeHandle(ref, () => ({
    focus: () => field.current?.focus(),
    openFileChooser: () => {
      editorUploads.chooserOpened.push(ariaLabel ?? '');
    },
  }));
  return (
    <textarea
      ref={field}
      aria-label={ariaLabel}
      placeholder={placeholder}
      autoFocus={autofocus !== undefined && autofocus !== false}
      value={textOf(value)}
      onChange={(event) => onChange?.(docOfText(event.currentTarget.value))}
      onBlur={() => onBlur?.()}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey) {
          event.preventDefault();
          onSubmit?.();
        }
      }}
    />
  );
}

/** The checklist items of a document with their paths, as `DocView` reports them to `onToggle`. */
function taskItems(doc: DocNodeJSON): { path: number[]; checked: boolean }[] {
  const found: { path: number[]; checked: boolean }[] = [];
  const walk = (node: DocNodeJSON, path: number[]) => {
    if (node.type === 'taskItem') found.push({ path, checked: node.attrs?.['checked'] === true });
    (node.content ?? []).forEach((child, index) => {
      walk(child, [...path, index]);
    });
  };
  walk(doc, []);
  return found;
}

export function CommentDoc({ doc, onToggle }: DocViewProps) {
  return (
    <div data-testid="doc">
      {textOf(doc)}
      {taskItems(doc).map(({ path, checked }) => (
        <input
          key={path.join('.')}
          type="checkbox"
          aria-label={`Checklist item ${path.join('.')}`}
          checked={checked}
          disabled={onToggle === undefined}
          onChange={(event) => onToggle?.(path, event.currentTarget.checked)}
        />
      ))}
    </div>
  );
}

export const EMOJI: readonly PickerEmoji[] = [
  {
    unicode: '👍',
    label: 'thumbs up',
    shortcodes: ['+1'],
    tags: [],
    group: 1,
  },
  {
    unicode: '🎉',
    label: 'party popper',
    shortcodes: ['tada'],
    tags: [],
    group: 9,
  },
];

export const loadEmojiLazy = () => Promise.resolve(EMOJI);

export function useEmojiNames(): ReadonlyMap<string, string> {
  return NAMES;
}
const NAMES = new Map(EMOJI.map((emoji) => [emoji.unicode, emoji.label]));
