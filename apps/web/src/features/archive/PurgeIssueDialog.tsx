// The Permanently delete confirmation (SPEC-015 §3.4, D14, AC-15): `Permanently delete "ENG-42 –
// <title>"?` with "This can't be undone.", **Cancel** and **Permanently delete**. A plain confirm,
// not a typed one, and nothing opens it by key. Focus starts on **Cancel**: unlike Delete, this
// can't be taken back, so `Enter` right after opening it does nothing harmful.
import { Button, Dialog, DialogClose } from '@surface/ui';
import { useEffect, useId, useRef } from 'react';

export const PURGE_BODY = "This can't be undone.";

export const purgeTitle = (identifier: string, title: string) =>
  `Permanently delete "${identifier} – ${title}"?`;

export interface PurgeIssueDialogProps {
  readonly open: boolean;
  readonly identifier: string;
  readonly title: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly onClosed?: () => void;
}

export function PurgeIssueDialog({
  open,
  identifier,
  title,
  onConfirm,
  onCancel,
  onClosed,
}: PurgeIssueDialogProps) {
  const formId = useId();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title={purgeTitle(identifier, title)}
      size="sm"
      {...(onClosed === undefined ? {} : { onClosed })}
      footer={<PurgeButtons formId={formId} />}
    >
      {open && (
        <form
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            onConfirm();
          }}
        >
          <p>{PURGE_BODY}</p>
        </form>
      )}
    </Dialog>
  );
}

function PurgeButtons({ formId }: { formId: string }) {
  const cancel = useRef<HTMLButtonElement>(null);
  // Focus starts on Cancel. Runs before the dialog's focus scope, which then leaves it there.
  useEffect(() => {
    cancel.current?.focus();
  }, []);
  return (
    <>
      <DialogClose>
        <Button ref={cancel} variant="secondary">
          Cancel
        </Button>
      </DialogClose>
      <Button type="submit" form={formId} variant="danger">
        Permanently delete
      </Button>
    </>
  );
}
