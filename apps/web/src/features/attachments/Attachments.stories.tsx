// Stories for the attachments UI (PLAN-014 S5; design-system §5.4 checklist): rows, upload rows,
// the drop layer, the link form, the rename dialog and the image viewer. Plain CSF without
// Storybook imports, like `CommentCard.stories.tsx`, so `apps/web` needs no Storybook dependency;
// `packages/ui`'s `.storybook/main.ts` lists this folder, and axe runs each in light and dark.
import type { ReactNode } from 'react';
import { ShortcutProvider } from '../../shortcuts/ShortcutProvider.js';
import { AttachmentRowView, ProgressRow } from './AttachmentsSection.js';
import { DropZoneLayer } from './DropZone.js';
import { ImageViewer } from './ImageViewer.js';
import { LinkForm } from './LinkForm.js';
import type { AttachmentItem } from './model.js';
import { RenameDialog } from './RenameDialog.js';
import styles from './attachments.module.css';

export default { title: 'Domain/Attachments' };

const NOW = new Date('2026-11-24T12:00:00.000Z');
const noop = () => undefined;

const base: AttachmentItem = {
  id: '0192f0c1-7e5a-7b3c-9d4e-000000000901',
  kind: 'file',
  title: 'design.pdf',
  url: null,
  fileId: '0192f0c1-7e5a-7b3c-9d4e-000000000951',
  fileName: 'design.pdf',
  mimeType: 'application/pdf',
  size: 1_258_291,
  imageWidth: null,
  imageHeight: null,
  previewUrl: null,
  creatorId: 'u-iris',
  creatorName: 'Iris',
  createdAt: '2026-11-24T09:00:00.000Z',
};

const ITEMS: AttachmentItem[] = [
  base,
  {
    ...base,
    id: '0192f0c1-7e5a-7b3c-9d4e-000000000902',
    kind: 'link',
    title: 'Login flow',
    url: 'https://www.figma.com/file/abc123/Login-flow',
    fileId: null,
    fileName: null,
    mimeType: null,
    size: null,
  },
  {
    ...base,
    id: '0192f0c1-7e5a-7b3c-9d4e-000000000903',
    title: 'screenshot.png',
    fileName: 'screenshot.png',
    mimeType: 'image/png',
    size: 20_480,
    imageWidth: 800,
    imageHeight: 600,
  },
];

function List({ children }: { children: ReactNode }) {
  return (
    <section aria-label="Attachments" className={styles.section}>
      <div className={styles.header}>
        <h2 className={styles.heading}>Attachments</h2>
      </div>
      <ul className={styles.list}>{children}</ul>
    </section>
  );
}

export const Rows = {
  render: () => (
    <List>
      {ITEMS.map((item, index) => (
        <AttachmentRowView
          key={item.id}
          item={item}
          now={NOW}
          mayChange={index !== 1}
          onOpen={noop}
          onCopyLink={noop}
          onRename={noop}
          onRemove={noop}
        />
      ))}
    </List>
  ),
};

export const Uploads = {
  render: () => (
    <List>
      <ProgressRow
        row={{ key: 'a', name: 'spec.pdf', progress: 0.4, state: 'uploading' }}
        onCancel={noop}
        onRetry={noop}
      />
      <ProgressRow
        row={{ key: 'b', name: 'notes.txt', progress: 0, state: 'waiting' }}
        onCancel={noop}
        onRetry={noop}
      />
      <ProgressRow
        row={{
          key: 'c',
          name: 'video.mov',
          progress: 0,
          state: 'failed',
          message: 'Files must be 25 MB or smaller.',
        }}
        onCancel={noop}
        onRetry={noop}
      />
    </List>
  ),
};

export const DropLayer = {
  render: () => <DropZoneLayer subject="ENG-42" />,
};

export const LinkFormOpen = {
  render: () => (
    <LinkForm open initialUrl="https://example.com/spec" onOpenChange={noop} onSubmit={noop} />
  ),
};

export const Rename = {
  render: () => <RenameDialog title="design.pdf" onClose={noop} onRename={noop} />,
};

export const Viewer = {
  render: () => (
    // The viewer's ←/→ are registry commands, so it needs the shortcut provider.
    <ShortcutProvider>
      <ImageViewer
        images={[
          ITEMS[2] ?? base,
          { ...base, id: 'second', title: 'second.png', mimeType: 'image/png' },
        ]}
        openId={ITEMS[2]?.id}
        onOpenIdChange={noop}
      />
    </ShortcutProvider>
  ),
};
