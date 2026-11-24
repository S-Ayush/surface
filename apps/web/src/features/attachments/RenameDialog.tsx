// "Rename attachment…" (SPEC-014 §3.5; PLAN-014 S5): the title, 1–255 characters after trimming,
// checked with the server's rule (`attachmentTitleProblem`) before `attachment.update` is sent.
import { attachmentTitleProblem, normalizeAttachmentTitle } from '@surface/domain';
import { Button, Dialog, DialogClose, Input } from '@surface/ui';
import { useState } from 'react';
import styles from './attachments.module.css';

const FORM_ID = 'attachment-rename-form';

export interface RenameDialogProps {
  /** The title to start from; undefined while closed. */
  readonly title: string | undefined;
  readonly onClose: () => void;
  /** A checked title that differs from the current one; the dialog closes after. */
  readonly onRename: (title: string) => void;
}

export function RenameDialog({ title, onClose, onRename }: RenameDialogProps) {
  return (
    <Dialog
      open={title !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Rename attachment"
      size="sm"
      footer={
        <>
          <DialogClose>
            <Button variant="secondary">Cancel</Button>
          </DialogClose>
          <Button variant="primary" type="submit" form={FORM_ID}>
            Rename
          </Button>
        </>
      }
    >
      {title !== undefined && <TitleField initial={title} onClose={onClose} onRename={onRename} />}
    </Dialog>
  );
}

function TitleField({
  initial,
  onClose,
  onRename,
}: {
  initial: string;
  onClose: () => void;
  onRename: (title: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<string | undefined>(undefined);
  return (
    <form
      id={FORM_ID}
      className={styles.form}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const problem = attachmentTitleProblem(value);
        if (problem !== undefined) {
          setError(problem);
          return;
        }
        const next = normalizeAttachmentTitle(value);
        if (next === initial) onClose();
        else onRename(next);
      }}
    >
      <Input
        label="Title"
        autoComplete="off"
        value={value}
        autoFocus
        onFocus={(event) => {
          event.currentTarget.select();
        }}
        onChange={(event) => {
          setValue(event.currentTarget.value);
          setError(undefined);
        }}
        {...(error === undefined ? {} : { error })}
      />
    </form>
  );
}
