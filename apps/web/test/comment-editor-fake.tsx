// A stand-in for `features/comments/editor-host.tsx` in the comment flow tests: a textarea where the
// real one lazy-loads TipTap. Typing in a textarea is deterministic in jsdom; the editor's own keys
// (`Enter` sends, `Mod+Enter` reaches the engine, AC-19, AC-24) are `editor-keys.test.tsx`. This
// fake keeps that contract: `Enter` calls `onSubmit`, `Mod+Enter` is left to the shortcut engine.
import { EMPTY_DOC, type DocNodeJSON } from '@surface/domain';
import type { DocViewProps, RichTextEditorProps } from '@surface/editor';
import type { PickerEmoji } from '@surface/ui';
import { useImperativeHandle } from 'react';

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

export function CommentEditor({
  value,
  onChange,
  onSubmit,
  onBlur,
  ariaLabel,
  placeholder,
  autofocus,
  ref,
}: RichTextEditorProps) {
  useImperativeHandle(ref, () => ({ focus: () => undefined, openFileChooser: () => undefined }));
  return (
    <textarea
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

export function CommentDoc({ doc }: DocViewProps) {
  return <div data-testid="doc">{textOf(doc)}</div>;
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
