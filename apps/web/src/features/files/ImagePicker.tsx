// The avatar on Profile and the logo on Workspace (PLAN-001 S6): the image as it shows, with
// Upload and Remove. The picked file goes to the caller, which uploads it and saves the change.
import { Avatar, Button } from '@surface/ui';
import { useRef } from 'react';
import styles from './image-picker.module.css';
import { IMAGE_ACCEPT } from './upload.js';

export function ImagePicker({
  label,
  alt,
  name,
  src,
  square = false,
  busy,
  error,
  onPick,
  onRemove,
}: {
  /** "avatar" or "logo", for the buttons' accessible names. */
  readonly label: string;
  /** The image's alt text: "Your avatar", "The workspace logo". */
  readonly alt: string;
  /** Whose image: initials when there is none. */
  readonly name: string;
  readonly src: string | undefined;
  readonly square?: boolean;
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly onPick: (file: File) => void;
  readonly onRemove: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className={styles.section}>
      <div className={styles.image}>
        {src === undefined ? (
          <span
            className={`${styles.preview} ${square ? styles.previewSquare : ''} ${styles.placeholder}`}
          >
            <Avatar name={name} size={32} />
          </span>
        ) : (
          <img
            className={`${styles.preview} ${square ? styles.previewSquare : ''}`}
            src={src}
            alt={alt}
          />
        )}
        <div className={styles.imageActions}>
          <Button
            variant="secondary"
            loading={busy}
            aria-label={`Upload a new ${label}`}
            onClick={() => input.current?.click()}
          >
            Upload image…
          </Button>
          {src !== undefined && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={onRemove}
              aria-label={`Remove the ${label}`}
            >
              Remove
            </Button>
          )}
        </div>
        <input
          ref={input}
          className={styles.fileInput}
          type="file"
          accept={IMAGE_ACCEPT}
          tabIndex={-1}
          aria-hidden="true"
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Cleared, so picking the same file again still changes it.
            event.target.value = '';
            if (file !== undefined) onPick(file);
          }}
        />
      </div>
      <p className={styles.note}>PNG, JPEG, GIF or WebP, up to 2 MB. It is cropped to a square.</p>
      {error !== undefined && (
        <p role="alert" className={styles.formError}>
          {error}
        </p>
      )}
    </div>
  );
}
