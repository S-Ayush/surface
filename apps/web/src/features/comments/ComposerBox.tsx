// The one text box under the comment composer, the reply box and the edit mode (SPEC-013 §3.1–§3.3,
// §7): the editor in comment mode, an attach button and a send (or save) button. It is the `comment`
// scope's box: `Mod+Enter` reaches the shortcut engine as `comment:send` (AC-19), `Enter` is the
// editor's own send (§3.5), and `Esc` leaves the box (or cancels, for an edit). The handlers apply
// only while focus is inside this box, so several boxes on the page never answer for each other.
// The attach button and `Mod+Shift+U` with focus in the box insert a file inline (SPEC-012 §3.6,
// SPEC-014 §3.3; PLAN-014 S5's `onUploadFile`).
import type { DocNodeJSON } from '@surface/domain';
import type { RichTextEditorHandle } from '@surface/editor';
import { Button, IconButton, toast } from '@surface/ui';
import { Paperclip } from 'lucide-react';
import { useImperativeHandle, useRef, type Ref } from 'react';
import { useEditorUpload } from '../attachments/editor-upload.js';
import { useCommand } from '../../shortcuts/ShortcutProvider.js';
import { CommentEditor } from './editor-host.js';
import styles from './comments.module.css';

export interface ComposerBoxProps {
  readonly value: DocNodeJSON;
  readonly onChange: (doc: DocNodeJSON) => void;
  /** `Enter`, `Mod+Enter` and the button. Called only when `canSubmit`. */
  readonly onSubmit: () => void;
  /** `Esc`. Without it, `Esc` only leaves the box. */
  readonly onCancel?: () => void;
  readonly cancelLabel?: string;
  readonly onBlur?: () => void;
  readonly placeholder: string;
  readonly ariaLabel: string;
  readonly submitLabel: string;
  readonly canSubmit: boolean;
  readonly autofocus?: boolean | 'start' | 'end';
  readonly editorRef?: Ref<RichTextEditorHandle>;
  readonly className?: string;
}

export function ComposerBox({
  value,
  onChange,
  onSubmit,
  onCancel,
  cancelLabel = 'Cancel',
  onBlur,
  placeholder,
  ariaLabel,
  submitLabel,
  canSubmit,
  autofocus = false,
  editorRef,
  className,
}: ComposerBoxProps) {
  const box = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLDivElement>(null);
  const handle = useRef<RichTextEditorHandle | null>(null);
  const uploadFile = useEditorUpload();
  // The caller's handle (`editorRef`) reaches the editor through the box's own.
  useImperativeHandle(
    editorRef,
    () => ({
      focus: () => {
        handle.current?.focus();
      },
      openFileChooser: () => {
        handle.current?.openFileChooser();
      },
    }),
    [],
  );
  const chooseFile = () => {
    handle.current?.openFileChooser();
  };
  const inside = () => box.current?.contains(document.activeElement) === true;
  // Only the text field answers `Enter` and `Mod+Enter` as a send: on the box's buttons, `Enter`
  // keeps its native action (**Cancel** must not send).
  const inField = () => field.current?.contains(document.activeElement) === true;
  const submit = () => {
    if (canSubmit) onSubmit();
  };

  useCommand('comment:send', submit, { when: inField });
  // §4.2: `Esc` leaves a text field first. An edit cancels instead (with its own guard).
  useCommand(
    'ui:escape',
    () => {
      if (onCancel !== undefined) onCancel();
      else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    },
    { level: 'overlay', when: inside },
  );
  // SPEC-012 §3.6: with focus in this box, `Mod+Shift+U` inserts inline; it beats the page's
  // attachment handler (level `overlay`), which answers everywhere else.
  useCommand('issue-page:attach-file', chooseFile, { level: 'overlay', when: inside });

  return (
    <div ref={box} className={className ?? styles.box} data-testid="composer-box">
      <div ref={field} data-shortcut-scope="comment">
        <CommentEditor
          mode="comment"
          value={value}
          onChange={onChange}
          onSubmit={submit}
          {...(onBlur === undefined ? {} : { onBlur })}
          placeholder={placeholder}
          ariaLabel={ariaLabel}
          autofocus={autofocus}
          onUploadFile={uploadFile}
          onError={(message) => {
            toast({ tone: 'danger', message });
          }}
          ref={handle}
        />
      </div>
      <div className={styles.boxFooter}>
        <IconButton aria-label="Attach file" icon={<Paperclip />} size="sm" onClick={chooseFile} />
        {onCancel !== undefined && (
          <Button variant="secondary" size="sm" onClick={onCancel}>
            {cancelLabel}
          </Button>
        )}
        <Button variant="primary" size="sm" disabled={!canSubmit} onClick={submit}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
