// "Link any URL to issue…" (SPEC-014 §3.2; PLAN-014 S5): a small dialog with the web address and an
// optional title, checked with the same rules the server applies (`parseAttachmentUrl`, AC-17)
// before `attachment.createLink` is dispatched. It also opens filled in when a lone URL is pasted
// on the page. The page is never fetched (D10): the title is what the person typed, or the address.
import { Button, Dialog, DialogClose, Input } from '@surface/ui';
import { useState } from 'react';
import { checkLinkForm } from './model.js';
import styles from './attachments.module.css';

const FORM_ID = 'attachment-link-form';

export interface LinkFormProps {
  readonly open: boolean;
  /** The address to start with (a pasted URL), or ''. Read when the dialog opens. */
  readonly initialUrl: string;
  readonly onOpenChange: (open: boolean) => void;
  /** A checked address and title; the dialog closes after. */
  readonly onSubmit: (url: string, title: string | undefined) => void;
}

export function LinkForm({ open, initialUrl, onOpenChange, onSubmit }: LinkFormProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Link any URL to issue"
      size="sm"
      footer={
        <>
          <DialogClose>
            <Button variant="secondary">Cancel</Button>
          </DialogClose>
          <Button variant="primary" type="submit" form={FORM_ID}>
            Add link
          </Button>
        </>
      }
    >
      {open && <LinkFields initialUrl={initialUrl} onSubmit={onSubmit} />}
    </Dialog>
  );
}

/** The fields, mounted per opening so each starts from `initialUrl`. */
function LinkFields({
  initialUrl,
  onSubmit,
}: {
  initialUrl: string;
  onSubmit: LinkFormProps['onSubmit'];
}) {
  const [url, setUrl] = useState(initialUrl);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<{ field: 'url' | 'title'; message: string } | undefined>(
    undefined,
  );
  return (
    <form
      id={FORM_ID}
      className={styles.form}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const checked = checkLinkForm(url, title);
        if (!checked.ok) {
          setError({ field: checked.field, message: checked.message });
          return;
        }
        onSubmit(checked.url, checked.title);
      }}
    >
      <Input
        label="Web address"
        type="url"
        inputMode="url"
        autoComplete="off"
        placeholder="https://"
        value={url}
        autoFocus={initialUrl === ''}
        onChange={(event) => {
          setUrl(event.currentTarget.value);
          setError(undefined);
        }}
        {...(error?.field === 'url' ? { error: error.message } : {})}
      />
      <Input
        label="Title"
        hint="Optional. Without one, the address is shown."
        autoComplete="off"
        value={title}
        autoFocus={initialUrl !== ''}
        onChange={(event) => {
          setTitle(event.currentTarget.value);
          setError(undefined);
        }}
        {...(error?.field === 'title' ? { error: error.message } : {})}
      />
    </form>
  );
}
