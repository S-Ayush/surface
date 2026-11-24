// The image viewer (SPEC-014 §3.4, §7; PLAN-014 S5): an overlay over the page showing one image
// attachment at full size from `GET /files/:id`. `Esc` closes it, `←` and `→` step through the
// issue's image attachments (the `modal` scope bindings `viewer.previous` and `viewer.next`), and
// focus is trapped inside and returns where it was (the design system's `Dialog`).
import { Dialog, IconButton } from '@surface/ui';
import { ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { useCommand } from '../../shortcuts/ShortcutProvider.js';
import { downloadHref, fileHref, type AttachmentItem } from './model.js';
import styles from './attachments.module.css';

export interface ImageViewerProps {
  /** The issue's image attachments, in the section's order. */
  readonly images: readonly AttachmentItem[];
  /** The one shown; undefined while closed. */
  readonly openId: string | undefined;
  readonly onOpenIdChange: (id: string | undefined) => void;
}

export function ImageViewer({ images, openId, onOpenIdChange }: ImageViewerProps) {
  const index = images.findIndex((image) => image.id === openId);
  const image = images[index];
  const open = image !== undefined;
  const step = (by: number) => {
    const next = images[index + by];
    if (next !== undefined) onOpenIdChange(next.id);
  };
  useCommand(
    'viewer:previous',
    () => {
      step(-1);
    },
    { level: 'overlay', when: () => open && index > 0 },
  );
  useCommand(
    'viewer:next',
    () => {
      step(1);
    },
    { level: 'overlay', when: () => open && index < images.length - 1 },
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onOpenIdChange(undefined);
      }}
      title={image?.title ?? 'Image'}
      size="lg"
      footer={
        image !== undefined && (
          <>
            {images.length > 1 && (
              <span className={styles.viewerCount} aria-live="polite">
                {`${String(index + 1)} of ${String(images.length)}`}
              </span>
            )}
            <IconButton
              aria-label="Previous image"
              icon={<ChevronLeft />}
              disabled={index <= 0}
              onClick={() => {
                step(-1);
              }}
            />
            <IconButton
              aria-label="Next image"
              icon={<ChevronRight />}
              disabled={index >= images.length - 1}
              onClick={() => {
                step(1);
              }}
            />
            {image.fileId !== null && (
              <a className={styles.textAction} href={downloadHref(image.fileId)} download>
                <Download aria-hidden="true" />
                Download
              </a>
            )}
          </>
        )
      }
    >
      {image !== undefined && image.fileId !== null && (
        <div className={styles.viewerFrame}>
          <img
            className={styles.viewerImage}
            src={fileHref(image.fileId)}
            alt={image.title}
            {...(image.imageWidth === null ? {} : { width: image.imageWidth })}
            {...(image.imageHeight === null ? {} : { height: image.imageHeight })}
          />
        </div>
      )}
    </Dialog>
  );
}
