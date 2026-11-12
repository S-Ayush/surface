/**
 * The type of an attachment or inline upload, from its first bytes, never from the browser
 * (SPEC-014 §4.8, D17). Only PNG, JPEG, GIF and WebP are images. SVG, HTML and XML are text, and
 * text is only ever served as `text/plain`, so none of them renders. Office files are ZIPs and
 * are reported as ZIP. Anything else is `application/octet-stream`.
 *
 * Avatars and logos keep `sniffImage` (`image.ts`), which refuses everything but the four images.
 */
import { IMAGE_TYPES, sniffImage, type ImageType } from './image.js';

export const SNIFFED_TYPES = [
  ...IMAGE_TYPES,
  'application/pdf',
  'application/zip',
  'application/gzip',
  'text/plain',
  'application/octet-stream',
] as const;
export type SniffedType = (typeof SNIFFED_TYPES)[number];

/** How much of the body the sniffer looks at; the text test reads exactly this much. */
export const SNIFF_BYTES = 8 * 1024;

const startsWith = (bytes: Uint8Array, prefix: readonly number[]) =>
  bytes.length >= prefix.length && prefix.every((byte, i) => bytes[i] === byte);

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

export function isImageType(type: string): type is ImageType {
  return (IMAGE_TYPES as readonly string[]).includes(type);
}

/**
 * The type of a body from `head`, its first `SNIFF_BYTES` bytes (or all of it, if shorter).
 * `complete` says `head` is the whole body: then a multi-byte character cut at the end is
 * invalid UTF-8; otherwise the cut is the sniffer's, not the file's, and is allowed.
 */
export function sniffType(head: Uint8Array, complete = head.length < SNIFF_BYTES): SniffedType {
  const image = sniffImage(head);
  if (image !== undefined) return image;
  if (startsWith(head, ascii('%PDF-'))) return 'application/pdf';
  // A local file header, an empty archive's end record, or a spanned archive's marker.
  if (
    startsWith(head, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(head, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(head, [0x50, 0x4b, 0x07, 0x08])
  ) {
    return 'application/zip';
  }
  if (startsWith(head, [0x1f, 0x8b])) return 'application/gzip';
  return isText(head.subarray(0, SNIFF_BYTES), complete)
    ? 'text/plain'
    : 'application/octet-stream';
}

function isText(bytes: Uint8Array, complete: boolean): boolean {
  if (bytes.length === 0 || bytes.includes(0)) return false;
  try {
    // `stream: true` keeps a trailing partial character for later instead of failing on it.
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: !complete });
    return true;
  } catch {
    return false;
  }
}
