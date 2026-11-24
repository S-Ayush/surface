// The editor's `onUploadFile` (SPEC-013 §3.5, E11; SPEC-014 §3.3, §3.6; PLAN-014 S5): a file pasted,
// dropped or chosen in the description or a comment is uploaded with `purpose=inline` and inserted
// as `/files/<id>`: an image node for the four raster types, a file chip for anything else. It is
// not an Attachment (D16): the save claims it (§4.3). Offline the editor inserts nothing and says
// why.
import type { UploadFile } from '@surface/editor';
import { useCallback } from 'react';
import { useApp } from '../../app/context.js';
import { fileHref, isInlineImage } from './model.js';
import { OFFLINE_UPLOAD_MESSAGE, useUploader, type Uploader } from './transport.js';

/** An `UploadFile` over `uploader`; `online` is asked before each upload. */
export function editorUpload(uploader: Uploader, online: () => boolean): UploadFile {
  return async (file) => {
    if (!online()) throw new Error(OFFLINE_UPLOAD_MESSAGE);
    const result = await uploader({ file, purpose: 'inline' });
    if (!result.ok) throw new Error(result.message);
    const { id, name, mimeType } = result.answer;
    return { src: fileHref(id), name, kind: isInlineImage(mimeType) ? 'image' : 'file' };
  };
}

/** The editor hook for the page's editors: the app's uploader, refusing while offline. */
export function useEditorUpload(): UploadFile {
  const app = useApp();
  const uploader = useUploader();
  return useCallback(
    (file: File) => editorUpload(uploader, () => app.readyStore?.connection === 'online')(file),
    [app, uploader],
  );
}
