/**
 * The selection toolbar (SPEC-013 §3.5): bold, italic, underline, strikethrough, code and link
 * for a text selection. The link field validates with the same rule as `validateDoc`, so a link
 * the field accepts is one the server accepts. Positioned with `coordsAtPos`, no popper library.
 */
import type { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type FormEvent } from 'react';
import { DOC_MESSAGES } from './schema/validate.js';
import { isAllowedHref } from './schema/links.js';

interface BubbleMenuProps {
  readonly editor: Editor;
  /** The link field is open (set by `Mod+K` or the Link button). */
  readonly linking: boolean;
  readonly onLinking: (open: boolean) => void;
}

/** `example.com` becomes `https://example.com`; anything with a scheme is left to the link rule. */
export function toHref(input: string): string {
  const value = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  return /^[^\s/:@]+\.[a-z]{2,}(?:[/?#]\S*)?$/i.test(value) ? `https://${value}` : value;
}

const MARKS = [
  { name: 'bold', label: 'Bold', text: 'B' },
  { name: 'italic', label: 'Italic', text: 'I' },
  { name: 'underline', label: 'Underline', text: 'U' },
  { name: 'strike', label: 'Strikethrough', text: 'S' },
  { name: 'code', label: 'Inline code', text: '<>' },
] as const;

export function BubbleMenu({ editor, linking, onLinking }: BubbleMenuProps) {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const ref = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    editor.on('transaction', rerender);
    editor.on('focus', rerender);
    editor.on('blur', rerender);
    return () => {
      editor.off('transaction', rerender);
      editor.off('focus', rerender);
      editor.off('blur', rerender);
    };
  }, [editor]);

  const { selection } = editor.state;
  const inCode = selection.$from.parent.type.spec.code === true;
  const visible =
    editor.isEditable &&
    selection instanceof TextSelection &&
    !selection.empty &&
    !inCode &&
    (editor.isFocused || linking);

  const { from, to } = selection;
  useLayoutEffect(() => {
    const element = ref.current;
    const parent = element?.offsetParent;
    if (!visible || !element || !parent) return;
    const place = () => {
      const start = editor.view.coordsAtPos(from);
      const end = editor.view.coordsAtPos(to);
      const box = parent.getBoundingClientRect();
      element.style.left = `${String((start.left + end.left) / 2 - box.left)}px`;
      element.style.top = `${String(start.top - box.top)}px`;
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [editor, visible, from, to, linking]);

  if (!visible) return null;

  const apply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const raw = data.get('href');
    const href = toHref(typeof raw === 'string' ? raw : '');
    if (href === '') {
      editor.chain().focus().extendMarkRange('link').unsetMark('link').run();
    } else if (isAllowedHref(href)) {
      editor.chain().focus().extendMarkRange('link').setMark('link', { href }).run();
    } else {
      setError(DOC_MESSAGES.badLink);
      return;
    }
    setError(null);
    onLinking(false);
  };

  if (linking) {
    const current: unknown = editor.getAttributes('link')['href'];
    return (
      <div ref={ref} className="surface-editor-bubble">
        <form className="surface-editor-link-form" onSubmit={apply}>
          <input
            name="href"
            type="text"
            inputMode="url"
            aria-label="Link address"
            aria-invalid={error !== null}
            aria-describedby={error === null ? undefined : 'surface-editor-link-error'}
            defaultValue={typeof current === 'string' ? current : ''}
            autoFocus
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              event.stopPropagation();
              setError(null);
              onLinking(false);
              editor.commands.focus();
            }}
          />
          <button type="submit">Apply</button>
          {error !== null && (
            <span id="surface-editor-link-error" role="alert" className="surface-editor-error">
              {error}
            </span>
          )}
        </form>
      </div>
    );
  }

  return (
    <div ref={ref} className="surface-editor-bubble" role="toolbar" aria-label="Text formatting">
      {MARKS.map((mark) => (
        <button
          key={mark.name}
          type="button"
          aria-label={mark.label}
          aria-pressed={editor.isActive(mark.name)}
          // Keep the selection and focus in the text.
          onMouseDown={(event) => {
            event.preventDefault();
            editor.chain().focus().toggleMark(mark.name).run();
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            editor.chain().focus().toggleMark(mark.name).run();
          }}
        >
          {mark.text}
        </button>
      ))}
      <button
        type="button"
        aria-label="Link"
        aria-pressed={editor.isActive('link')}
        onMouseDown={(event) => {
          event.preventDefault();
          onLinking(true);
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          onLinking(true);
        }}
      >
        Link
      </button>
    </div>
  );
}
