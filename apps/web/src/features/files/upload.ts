// Uploading an avatar or the workspace logo (ADR-0014; PLAN-001 S6): `POST /files/upload?purpose=…`
// with the image as the body. The server decides the type from the bytes and crops it square;
// the checks here only spare a pointless upload, and say what to do in the server's words.
import { errorOf, type FetchLike } from '../../app/http.js';
import { UNREACHABLE } from './operation.js';

export type ImagePurpose = 'avatar' | 'logo';

/** SPEC-001 §3.5. */
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';
export const IMAGE_TOO_LARGE = 'Images must be 2 MB or smaller. Choose a smaller image.';
export const IMAGE_TYPE = 'Use a PNG, JPEG, GIF or WebP image.';

export type UploadAnswer =
  { readonly ok: true; readonly id: string } | { readonly ok: false; readonly message: string };

/** Why `file` can't be uploaded, before sending it; null if it may be. */
export function imageProblem(file: {
  readonly size: number;
  readonly type: string;
}): string | null {
  if (file.size > IMAGE_MAX_BYTES) return IMAGE_TOO_LARGE;
  // An empty type (some systems) is left to the server, which reads the bytes.
  if (file.type !== '' && !IMAGE_ACCEPT.split(',').includes(file.type)) return IMAGE_TYPE;
  return null;
}

export async function uploadImage(
  send: FetchLike,
  file: Blob,
  purpose: ImagePurpose,
): Promise<UploadAnswer> {
  const problem = imageProblem(file);
  if (problem !== null) return { ok: false, message: problem };
  let response: Response;
  try {
    response = await send(`/files/upload?purpose=${purpose}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': file.type === '' ? 'application/octet-stream' : file.type,
      },
      body: file,
    });
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
  if (!response.ok) {
    const error = response.status < 500 ? await errorOf(response) : undefined;
    return { ok: false, message: error?.message ?? UNREACHABLE };
  }
  try {
    const body: unknown = await response.json();
    const result: unknown =
      typeof body === 'object' && body !== null ? Reflect.get(body, 'result') : undefined;
    const id: unknown =
      typeof result === 'object' && result !== null ? Reflect.get(result, 'id') : undefined;
    return typeof id === 'string' ? { ok: true, id } : { ok: false, message: UNREACHABLE };
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
}
