import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { cx } from '../../internal/cx.js';
import { VisuallyHidden } from '../../visually-hidden.js';
import styles from './EditableTitle.module.css';

export const TITLE_MAX_LENGTH = 255;

export type EditableTitleProps = {
  value: string;
  /** Controlled, so a command (`Shift+R`) can start the edit. */
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  /** Called with the trimmed text when it is not empty and differs from `value`. */
  onSave: (title: string) => void;
  /** Heading level of the display form. */
  level?: 1 | 2;
  /** A title nobody can edit (archived and deleted issues). */
  readOnly?: boolean;
  className?: string;
};

/**
 * The issue title (SPEC-012 §3.4): a heading you click to edit in place. `Enter` or leaving the
 * field saves, `Esc` cancels. An empty or unchanged title just closes. A remote change to `value`
 * doesn't touch the text being typed (E4); the draft starts from `value` when editing begins.
 */
export function EditableTitle({
  value,
  editing,
  onEditingChange,
  onSave,
  level = 1,
  readOnly = false,
  className,
}: EditableTitleProps) {
  const hintId = useId();
  const input = useRef<HTMLInputElement>(null);
  const display = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState(value);
  // Set by Esc and Enter so the blur that follows doesn't save a second time (or at all).
  const finished = useRef(false);
  const wasEditing = useRef(false);

  useEffect(() => {
    if (editing && !wasEditing.current) {
      finished.current = false;
      setDraft(value);
      const field = input.current;
      field?.focus();
      field?.setSelectionRange(field.value.length, field.value.length);
    }
    if (!editing && wasEditing.current) display.current?.focus();
    wasEditing.current = editing;
    // `value` is read only when editing starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  function finish(save: boolean) {
    if (finished.current) return;
    finished.current = true;
    const next = draft.replace(/\s+/g, ' ').trim();
    if (save && next !== '' && next !== value) onSave(next);
    onEditingChange(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      finish(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
  }

  const Heading = level === 1 ? 'h1' : 'h2';
  if (editing && !readOnly) {
    return (
      <Heading className={cx(styles.root, className)}>
        <input
          ref={input}
          className={cx(styles.text, styles.input)}
          value={draft}
          maxLength={TITLE_MAX_LENGTH}
          aria-label="Issue title"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => finish(true)}
        />
      </Heading>
    );
  }
  return (
    <Heading className={cx(styles.root, className)}>
      {readOnly ? (
        <span className={styles.text}>{value}</span>
      ) : (
        <>
          <button
            ref={display}
            type="button"
            className={cx(styles.text, styles.display)}
            aria-describedby={hintId}
            onClick={() => onEditingChange(true)}
          >
            {value}
          </button>
          <VisuallyHidden id={hintId}>Edit title</VisuallyHidden>
        </>
      )}
    </Heading>
  );
}
