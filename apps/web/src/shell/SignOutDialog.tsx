// Log out with unsent changes (SPEC-012 §3.12 item 2, E30): signing out deletes the replica, and
// the unsent changes with it. **Cancel** keeps the session and the queue.
import { Button, Dialog, DialogClose } from '@surface/ui';

export const unsentChangesMessage = (count: number): string =>
  count === 1
    ? "1 change hasn't been sent yet. Signing out discards it."
    : `${String(count)} changes haven't been sent yet. Signing out discards them.`;

export interface SignOutDialogProps {
  readonly open: boolean;
  readonly count: number;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function SignOutDialog({ open, count, onCancel, onConfirm }: SignOutDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title="Log out?"
      size="sm"
      footer={
        <>
          <DialogClose>
            <Button variant="secondary">Cancel</Button>
          </DialogClose>
          <Button variant="danger" onClick={onConfirm}>
            Log out
          </Button>
        </>
      }
    >
      <p>{unsentChangesMessage(count)}</p>
    </Dialog>
  );
}
