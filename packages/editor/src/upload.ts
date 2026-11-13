/**
 * Inline file upload glue (SPEC-013 §3.5, SPEC-014 §3.3). The editor never uploads by itself: the
 * host injects `onUploadFile` (PLAN-014 S5 supplies the real one). This module turns a finished
 * upload into an `image` or `file` node, and opens the file chooser.
 */
import type { Editor } from '@tiptap/core';
import { fileIdOfSrc } from './schema/links.js';

export interface UploadedFile {
  /** `/files/<uuid>`, as SPEC-014 returns it. */
  readonly src: string;
  readonly name: string;
  readonly kind: 'image' | 'file';
}

export type UploadFile = (file: File) => Promise<UploadedFile>;

/** The default until PLAN-014 S5: it refuses, and the host shows the message. */
export const uploadNotAvailable: UploadFile = () =>
  Promise.reject(
    new Error("Uploading files isn't available yet. Try again after the next update."),
  );

/** Inserts an uploaded file at the cursor: an image block, or a file chip inline. */
export function insertUploaded(editor: Editor, uploaded: UploadedFile): boolean {
  if (fileIdOfSrc(uploaded.src) === null) return false;
  const content =
    uploaded.kind === 'image'
      ? { type: 'image', attrs: { src: uploaded.src, alt: uploaded.name } }
      : { type: 'file', attrs: { src: uploaded.src, name: uploaded.name } };
  return editor.chain().focus().insertContent(content).run();
}

/** Uploads `file` and inserts the result; failures go to `onError` with a sentence to show. */
export async function uploadAndInsert(
  editor: Editor,
  file: File,
  upload: UploadFile,
  onError: (message: string) => void,
): Promise<void> {
  try {
    const uploaded = await upload(file);
    if (editor.isDestroyed) return;
    if (!insertUploaded(editor, uploaded)) {
      onError("That file couldn't be added. Try uploading it again.");
    }
  } catch (error) {
    onError(
      error instanceof Error && error.message !== ''
        ? error.message
        : "That file couldn't be uploaded. Try again.",
    );
  }
}

/** Opens the browser's file chooser; each chosen file is uploaded and inserted in order. */
export function openFileChooser(
  editor: Editor,
  kind: 'image' | 'file' | 'any',
  upload: UploadFile,
  onError: (message: string) => void,
): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  if (kind === 'image') input.accept = 'image/*';
  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? []);
    void files.reduce(
      (previous, file) => previous.then(() => uploadAndInsert(editor, file, upload, onError)),
      Promise.resolve(),
    );
  });
  input.click();
}
