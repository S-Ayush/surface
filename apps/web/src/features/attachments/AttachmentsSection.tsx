// The issue page's Attachments section (SPEC-014 §3, §7; SPEC-012 §3.4 item 4; PLAN-014 S5), in the
// page's `attachments` slot under the reactions.
//
// - Rows: thumbnail (the preview, once made) or a type icon, title, size or host, creator, time; a
//   row menu with Open, Download, Copy link, Rename and Remove. A focused row is the command target
//   (`attachment`, chip "Attachment: design.pdf").
// - Adding: "Attach file" (`Mod+Shift+U` outside the editors), paste and drop upload with progress
//   rows; "Link any URL to issue…" (`Ctrl+L` on macOS) opens the link form, as does a lone URL
//   pasted outside a text field. Offline, uploads refuse with a toast; links queue.
// - Remove runs at once with an Undo toast (D8).
// - Read-only (an archived or deleted issue, or one the replica doesn't hold): the page provides the
//   server's answer (`useIssueContentView`, `server: true`) with `issue.get`'s attachments; the
//   rows open and download, nothing changes them.
//
// A link is never fetched or unfurled (D10): it opens in a new tab with `rel="noopener noreferrer"`.
import { Attachment, User } from '@surface/domain/model';
import { IconButton, Menu, ProgressBar, Tooltip, toast, type MenuEntry } from '@surface/ui';
import {
  Copy,
  Download,
  ExternalLink,
  File as FileIcon,
  FileText,
  Image as ImageIcon,
  Link as LinkIcon,
  MoreHorizontal,
  Paperclip,
  Pencil,
  RotateCw,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent } from 'react';
import { useCommandContext } from '../../command-menu/context.js';
import { useApp, useObserved } from '../../app/context.js';
import { useCommand } from '../../shortcuts/ShortcutProvider.js';
import { copyText } from '../members/reset-link.js';
import { useNow } from '../comments/useComments.js';
import { agoText, issueViewFromPool } from '../issues/issue-view.js';
import { useIssueContentView } from '../issues/server-issue.js';
import { attachmentActionsFor } from './actions.js';
import { DropZone } from './DropZone.js';
import { ImageViewer } from './ImageViewer.js';
import { LinkForm } from './LinkForm.js';
import {
  detailOf,
  downloadHref,
  isViewable,
  itemsFromRows,
  itemsFromSummaries,
  linkOf,
  targetLabel,
  type AttachmentItem,
} from './model.js';
import { listenForPaste } from './paste.js';
import { RenameDialog } from './RenameDialog.js';
import { OFFLINE_UPLOAD_MESSAGE, useUploader } from './transport.js';
import { useUpload, type UploadRow } from './useUpload.js';
import styles from './attachments.module.css';

/** What the issue page passes a slot (`issues/slots.ts`; not imported, which would be circular). */
type SlotProps = { readonly issueId: string };

/** Opens `href` in a new tab without giving it this page (`noopener noreferrer`, E12). */
function openInNewTab(href: string): void {
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  anchor.click();
}

/** Downloads a file with its original name (`?download=1`, §3.4). */
function download(fileId: string): void {
  const anchor = document.createElement('a');
  anchor.href = downloadHref(fileId);
  anchor.download = '';
  anchor.click();
}

/** The replica's view of the issue: its attachments, and whether it can be changed here. */
function useLiveAttachments(issueId: string, enabled: boolean) {
  const app = useApp();
  return useObserved(
    useCallback(() => {
      const store = app.readyStore;
      if (!enabled || store === null) return { items: [], editable: false, subject: '' };
      const view = issueViewFromPool(store.pool, issueId);
      const name = (id: string) => store.pool.get(User, id)?.displayName;
      return {
        items: itemsFromRows(store.pool.findBy(Attachment, 'issueId', issueId), name),
        editable: view !== undefined && view.lifecycle === 'live',
        subject: view?.identifier ?? 'this issue',
      };
    }, [app, issueId, enabled]),
  );
}

export function AttachmentsSection({ issueId }: SlotProps) {
  const app = useApp();
  const content = useIssueContentView(issueId);
  const live = useLiveAttachments(issueId, !content.server);
  const items = useMemo(
    () => (content.server ? itemsFromSummaries(content.attachments ?? []) : live.items),
    [content.server, content.attachments, live.items],
  );
  const editable = !content.server && live.editable;
  const store = useObserved(
    useCallback(() => app.readyStore, [app]),
    Object.is,
  );
  const actions = useMemo(
    () => (store === null ? null : attachmentActionsFor(store, (options) => toast(options))),
    [store],
  );
  const online = useCallback(() => app.readyStore?.connection === 'online', [app]);
  const uploader = useUploader();
  const { queue, rows } = useUpload({
    uploader,
    online,
    attach: (answer) => {
      void actions?.attachFile(issueId, answer);
    },
    toast: (message) => {
      toast({ message });
    },
  });
  const now = useNow();

  const picker = useRef<HTMLInputElement>(null);
  const [link, setLink] = useState<{ open: boolean; url: string }>({ open: false, url: '' });
  const [renaming, setRenaming] = useState<AttachmentItem | undefined>(undefined);
  const [viewing, setViewing] = useState<string | undefined>(undefined);
  const images = useMemo(() => items.filter(isViewable), [items]);

  // §3.6: offline, "Attach file" shows the toast and does nothing (the picker stays closed).
  const pickFiles = useCallback(() => {
    if (!online()) {
      toast({ message: OFFLINE_UPLOAD_MESSAGE });
      return;
    }
    picker.current?.click();
  }, [online]);
  const openLink = useCallback((url: string) => {
    setLink({ open: true, url });
  }, []);
  const attachFiles = useCallback(
    (files: readonly File[]) => {
      queue.add(files);
    },
    [queue],
  );

  // Paste outside text fields (§3.2, E23): only while the issue can be changed.
  const paste = useRef({ openLink, attachFiles });
  useEffect(() => {
    paste.current = { openLink, attachFiles };
  });
  useEffect(() => {
    if (!editable) return;
    return listenForPaste(document, () => paste.current);
  }, [editable]);

  // The focused row is the command target (the `attachment` context, SPEC-014 §7).
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const focused = items.find((item) => item.id === focusedId);
  const onFocus = (event: FocusEvent<HTMLElement>) => {
    const row = event.target.closest('[data-attachment-id]');
    const id = row?.getAttribute('data-attachment-id');
    if (id !== null && id !== undefined) setFocusedId(id);
  };
  const onBlur = (event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Element) {
      if (event.currentTarget.contains(next)) return;
      // Into the command menu, the row's menu or a dialog it opened: the row stays the target.
      if (next.closest('[role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]')) {
        return;
      }
    }
    setFocusedId(null);
  };

  const open = useCallback((item: AttachmentItem) => {
    if (item.kind === 'link') {
      if (item.url !== null) openInNewTab(item.url);
    } else if (isViewable(item)) {
      setViewing(item.id);
    } else if (item.fileId !== null) {
      download(item.fileId);
    }
  }, []);
  const copyLink = useCallback((item: AttachmentItem) => {
    const text = linkOf(item, window.location.origin);
    if (text === undefined) return;
    void copyText(text, navigator.clipboard).then((ok) => {
      toast(
        ok
          ? { message: 'Link copied' }
          : { tone: 'danger', message: "Couldn't copy the link. Try again." },
      );
    });
  }, []);
  const remove = useCallback(
    (item: AttachmentItem) => {
      void actions?.remove(issueId, item);
    },
    [actions, issueId],
  );

  // `Mod+Shift+U` and `Ctrl+L` here; an editor with focus answers `Mod+Shift+U` itself (inline).
  useCommand('issue-page:attach-file', pickFiles, { level: 'page', when: () => editable });
  useCommand(
    'issue-page:link-url',
    () => {
      openLink('');
    },
    { level: 'page', when: () => editable },
  );
  useCommand(
    'attachment:open',
    () => {
      if (focused !== undefined) open(focused);
    },
    { when: () => focused !== undefined },
  );
  useCommand(
    'attachment:download',
    () => {
      const fileId = focused?.kind === 'file' ? focused.fileId : null;
      if (fileId !== null) download(fileId);
    },
    { when: () => focused?.kind === 'file' && focused.fileId !== null },
  );
  useCommand(
    'attachment:copy-link',
    () => {
      if (focused !== undefined) copyLink(focused);
    },
    { when: () => focused !== undefined },
  );
  useCommand(
    'attachment:rename',
    () => {
      setRenaming(focused);
    },
    { when: () => editable && focused !== undefined },
  );
  useCommand(
    'attachment:remove',
    () => {
      if (focused !== undefined) remove(focused);
    },
    { when: () => editable && focused !== undefined },
  );

  // Read-only with nothing attached: nothing to show (SPEC-012 §3.4 item 8).
  if (!editable && items.length === 0) return null;

  return (
    <section aria-label="Attachments" className={styles.section}>
      <div className={styles.header}>
        <h2 className={styles.heading}>Attachments</h2>
        {editable && (
          <>
            <Tooltip content="Attach file" shortcut="Mod+Shift+U">
              <IconButton
                aria-label="Attach file"
                icon={<Paperclip />}
                size="sm"
                onClick={pickFiles}
              />
            </Tooltip>
            <Tooltip content="Link any URL to issue">
              <IconButton
                aria-label="Link any URL to issue"
                icon={<LinkIcon />}
                size="sm"
                onClick={() => {
                  openLink('');
                }}
              />
            </Tooltip>
            <input
              ref={picker}
              className={styles.hiddenInput}
              type="file"
              multiple
              tabIndex={-1}
              aria-hidden="true"
              data-testid="attachment-file-input"
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = '';
                attachFiles(files);
              }}
            />
          </>
        )}
      </div>
      {(items.length > 0 || rows.length > 0) && (
        <ul className={styles.list} onFocus={onFocus} onBlur={onBlur}>
          {items.map((item) => (
            <AttachmentRowView
              key={item.id}
              item={item}
              now={now}
              editable={editable}
              onOpen={open}
              onCopyLink={copyLink}
              onRename={setRenaming}
              onRemove={remove}
            />
          ))}
          {rows.map((row) => (
            <ProgressRow
              key={row.key}
              row={row}
              onCancel={() => {
                queue.cancel(row.key);
              }}
              onRetry={() => {
                queue.retry(row.key);
              }}
            />
          ))}
        </ul>
      )}
      {focused !== undefined && <AttachmentTarget id={focused.id} label={targetLabel(focused)} />}
      {editable && (
        <>
          <DropZone subject={live.subject} onFiles={attachFiles} />
          <LinkForm
            open={link.open}
            initialUrl={link.url}
            onOpenChange={(next) => {
              setLink((current) => ({ ...current, open: next }));
            }}
            onSubmit={(url, title) => {
              setLink({ open: false, url: '' });
              void actions?.attachLink(issueId, url, title);
            }}
          />
          <RenameDialog
            title={renaming?.title}
            onClose={() => {
              setRenaming(undefined);
            }}
            onRename={(title) => {
              const target = renaming;
              setRenaming(undefined);
              if (target !== undefined) void actions?.rename(target.id, title);
            }}
          />
        </>
      )}
      <ImageViewer images={images} openId={viewing} onOpenIdChange={setViewing} />
    </section>
  );
}

/** Makes the focused row the command target while it is mounted (like `CommentTarget`). */
function AttachmentTarget({ id, label }: { id: string; label: string }) {
  useCommandContext({ kind: 'attachment', ids: [id], label }, 'focus');
  return null;
}

function TypeIcon({ item }: { item: AttachmentItem }) {
  if (item.kind === 'link') return <LinkIcon />;
  if (item.mimeType?.startsWith('image/') === true) return <ImageIcon />;
  if (item.mimeType?.startsWith('text/') === true || item.mimeType === 'application/pdf') {
    return <FileText />;
  }
  return <FileIcon />;
}

function AttachmentRowView({
  item,
  now,
  editable,
  onOpen,
  onCopyLink,
  onRename,
  onRemove,
}: {
  item: AttachmentItem;
  now: Date;
  editable: boolean;
  onOpen: (item: AttachmentItem) => void;
  onCopyLink: (item: AttachmentItem) => void;
  onRename: (item: AttachmentItem) => void;
  onRemove: (item: AttachmentItem) => void;
}) {
  const meta = [detailOf(item), item.creatorName ?? '', agoText(item.createdAt, now)]
    .filter((part) => part !== '')
    .join(' · ');
  const menu: MenuEntry[] = [
    { type: 'item', label: 'Open', icon: <ExternalLink />, onSelect: () => onOpen(item) },
    ...(item.kind === 'file' && item.fileId !== null
      ? [
          {
            type: 'item' as const,
            label: 'Download',
            icon: <Download />,
            onSelect: () => {
              if (item.fileId !== null) download(item.fileId);
            },
          },
        ]
      : []),
    { type: 'item', label: 'Copy link', icon: <Copy />, onSelect: () => onCopyLink(item) },
    ...(editable
      ? ([
          { type: 'separator' },
          { type: 'item', label: 'Rename…', icon: <Pencil />, onSelect: () => onRename(item) },
          { type: 'item', label: 'Remove', icon: <Trash2 />, onSelect: () => onRemove(item) },
        ] satisfies MenuEntry[])
      : []),
  ];
  return (
    <li className={styles.row} data-attachment-id={item.id}>
      <span className={styles.thumb} aria-hidden="true">
        {item.previewUrl !== null ? (
          <img className={styles.thumbImage} src={item.previewUrl} alt="" loading="lazy" />
        ) : (
          <TypeIcon item={item} />
        )}
      </span>
      <div className={styles.main}>
        <AttachmentTitle item={item} onOpen={onOpen} />
        {meta !== '' && <span className={styles.meta}>{meta}</span>}
      </div>
      <div className={styles.rowActions}>
        <Menu
          align="end"
          trigger={
            <IconButton
              aria-label={`Actions for ${item.title}`}
              icon={<MoreHorizontal />}
              size="sm"
            />
          }
          items={menu}
        />
      </div>
    </li>
  );
}

/**
 * The title opens the attachment: a link in a new tab (never fetched by Surface, D10), an image in
 * the viewer, any other file as a download with its name (§3.4).
 */
function AttachmentTitle({
  item,
  onOpen,
}: {
  item: AttachmentItem;
  onOpen: (item: AttachmentItem) => void;
}) {
  if (item.kind === 'link' && item.url !== null) {
    return (
      <a className={styles.title} href={item.url} target="_blank" rel="noopener noreferrer">
        {item.title}
      </a>
    );
  }
  if (isViewable(item)) {
    return (
      <button type="button" className={styles.title} onClick={() => onOpen(item)}>
        {item.title}
      </button>
    );
  }
  if (item.fileId !== null) {
    return (
      <a className={styles.title} href={downloadHref(item.fileId)} download>
        {item.title}
      </a>
    );
  }
  return <span className={styles.title}>{item.title}</span>;
}

function ProgressRow({
  row,
  onCancel,
  onRetry,
}: {
  row: UploadRow;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const percent = Math.round(row.progress * 100);
  return (
    <li className={styles.row} data-state={row.state} data-testid="upload-row">
      <span className={styles.thumb} aria-hidden="true">
        <Paperclip />
      </span>
      <div className={styles.main}>
        <span className={styles.title}>{row.name}</span>
        {row.state === 'failed' ? (
          <span className={styles.error} role="alert">
            {row.message}
          </span>
        ) : (
          <>
            <ProgressBar
              className={styles.progress}
              aria-label={`Uploading ${row.name}`}
              value={row.state === 'waiting' ? 0 : percent}
            />
            <span className={styles.meta}>
              {row.state === 'waiting' ? 'Waiting…' : `${String(percent)}%`}
            </span>
          </>
        )}
      </div>
      <div className={styles.rowActions}>
        {row.state === 'failed' && (
          <IconButton
            aria-label={`Retry ${row.name}`}
            icon={<RotateCw />}
            size="sm"
            onClick={onRetry}
          />
        )}
        <IconButton
          aria-label={row.state === 'failed' ? `Dismiss ${row.name}` : `Cancel ${row.name}`}
          icon={<X />}
          size="sm"
          onClick={onCancel}
        />
      </div>
    </li>
  );
}
