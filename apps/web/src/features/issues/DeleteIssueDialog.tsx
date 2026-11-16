// The delete confirmation (SPEC-012 §3.11, SPEC-015 §3.1): `Delete "ENG-42 – Fix login redirect"?`
// with the 30-day text, **Cancel** and **Delete**. Focus starts on **Delete**, so `Mod+Backspace`
// then `Enter` deletes by keyboard; `Mod+Enter` submits like any dialog (the form's default
// button). There is no Undo toast (D8).
import { Button, Dialog, DialogClose } from '@surface/ui';
import { useEffect, useId, useRef } from 'react';

export const DELETE_BODY =
  'Deleted issues are available in the "Recently deleted" view for 30 days, before they are permanently deleted.';

export const deleteTitle = (identifier: string, title: string) =>
  `Delete "${identifier} – ${title}"?`;

export interface DeleteIssueDialogProps {
  readonly open: boolean;
  readonly identifier: string;
  readonly title: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  /** After the dialog has closed and focus is restored. */
  readonly onClosed?: () => void;
}

export function DeleteIssueDialog({
  open,
  identifier,
  title,
  onConfirm,
  onCancel,
  onClosed,
}: DeleteIssueDialogProps) {
  const formId = useId();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title={deleteTitle(identifier, title)}
      size="sm"
      {...(onClosed === undefined ? {} : { onClosed })}
      footer={<DeleteButtons formId={formId} />}
    >
      {open && (
        <form
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            onConfirm();
          }}
        >
          <p>{DELETE_BODY}</p>
        </form>
      )}
    </Dialog>
  );
}

function DeleteButtons({ formId }: { formId: string }) {
  const confirm = useRef<HTMLButtonElement>(null);
  // Focus starts on Delete (§3.11). Runs before the dialog's focus scope, which then leaves focus
  // where it is (the composer relies on the same order for its title).
  useEffect(() => {
    confirm.current?.focus();
  }, []);
  return (
    <>
      <DialogClose>
        <Button variant="secondary">Cancel</Button>
      </DialogClose>
      <Button ref={confirm} type="submit" form={formId} variant="danger" shortcut="Mod+Enter">
        Delete
      </Button>
    </>
  );
}
