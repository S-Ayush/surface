// Settings → Members → ⋯ → Generate reset link (SPEC-001 §3.3, §3.6; AC-3): the way back in for
// someone locked out when the server sends no email. Asks first, then shows the link once with a
// Copy button; closing the modal forgets it. The copy is confirmed in the modal: a toast raised
// over an open dialog waits until it closes (overlay manager), too late to help. While a link is
// being generated the modal stays open (every way of closing goes through `onOpenChange`).
import { Button, DialogClose, Dialog, Input } from '@surface/ui';
import { useState } from 'react';
import { useMembersApi } from './api.js';
import styles from './members.module.css';
import {
  ASK,
  copyText,
  mayClose,
  ResetLinkFlow,
  resetLinkIntro,
  resetLinkShownNote,
  type ResetLinkView,
} from './reset-link.js';

export const COPIED = 'Link copied.';
export const COPY_FAILED = 'Couldn’t copy. Select the link and copy it.';

export type ResetLinkTarget = {
  readonly id: string;
  readonly name: string;
  readonly self: boolean;
};

export function ResetLinkDialog({
  target,
  open,
  onOpenChange,
}: {
  readonly target: ResetLinkTarget | undefined;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const [closable, setClosable] = useState(true);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next || closable) onOpenChange(next);
      }}
      title={`Reset link for ${target?.name ?? ''}`}
      size="md"
    >
      {/* A new flow per person and per opening: a link is never shown twice. */}
      {open && target !== undefined && (
        <ResetLinkBody
          key={target.id}
          target={target}
          onView={(view) => setClosable(mayClose(view))}
        />
      )}
    </Dialog>
  );
}

function ResetLinkBody({
  target,
  onView,
}: {
  readonly target: ResetLinkTarget;
  readonly onView: (view: ResetLinkView) => void;
}) {
  const api = useMembersApi();
  const [view, setView] = useState<ResetLinkView>(ASK);
  const [flow] = useState(
    () =>
      new ResetLinkFlow(api, (next) => {
        setView(next);
        onView(next);
      }),
  );
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');

  if (view.phase === 'shown') {
    const copy = () => {
      void copyText(view.url, navigator.clipboard).then((ok) => setCopied(ok ? 'yes' : 'failed'));
    };
    return (
      <div className={styles.dialogBody}>
        <Input
          label="Reset link"
          value={view.url}
          readOnly
          autoFocus
          onFocus={(event) => event.target.select()}
          hint={resetLinkShownNote(target.name, target.self)}
        />
        <p role="status" className={copied === 'failed' ? styles.formError : styles.note}>
          {copied === 'yes' ? COPIED : copied === 'failed' ? COPY_FAILED : ''}
        </p>
        <div className={styles.dialogActions}>
          <DialogClose>
            <Button variant="ghost">Done</Button>
          </DialogClose>
          <Button variant="primary" onClick={copy}>
            {copied === 'yes' ? 'Copied' : 'Copy link'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.dialogBody}>
      <p className={styles.note}>{resetLinkIntro(target.name, target.self)}</p>
      {view.error !== null && (
        <p role="alert" className={styles.formError}>
          {view.error}
        </p>
      )}
      <div className={styles.dialogActions}>
        <DialogClose>
          <Button variant="ghost" disabled={view.busy}>
            Cancel
          </Button>
        </DialogClose>
        <Button variant="primary" loading={view.busy} onClick={() => void flow.generate(target.id)}>
          Generate link
        </Button>
      </div>
    </div>
  );
}
