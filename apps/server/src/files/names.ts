/**
 * Uploaded file names and the `Content-Disposition` that carries them back (SPEC-014 §4.8).
 *
 * The name comes from the `X-File-Name` header, percent-encoded UTF-8. It is only ever shown and
 * offered as a download name: it never reaches a path on disk (keys are content hashes,
 * `blob-store.ts`) or a log line (ids only).
 */

/** What a name that can't be used becomes. */
export const DEFAULT_FILE_NAME = 'file';

/** A stored name is at most this many UTF-8 bytes. */
export const MAX_NAME_BYTES = 255;

/** An "extension" longer than this is part of the name, not something to keep when cutting. */
const MAX_EXTENSION_BYTES = 32;

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

const TRIMMED = /^[\s.]$/u;

/**
 * `text` without spaces and dots at either end (a trailing dot or space can hide the real
 * extension). A loop, not a regex: `[\s.]+$` backtracks from every start, quadratic in a long run
 * of spaces (review m3). Every `\s` character is one UTF-16 unit, so units can be tested alone.
 */
function trimEnds(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && TRIMMED.test(text.charAt(start))) start += 1;
  while (end > start && TRIMMED.test(text.charAt(end - 1))) end -= 1;
  return text.slice(start, end);
}

/**
 * The six steps of SPEC-014 §4.8: decode (or `file`), NFC, the last path part, no control (Cc)
 * or format (Cf) characters, trimmed and cut to 255 bytes keeping the extension, `file` if
 * nothing is left.
 */
export function cleanFileName(header: string | readonly string[] | undefined): string {
  // Node joins a repeated `X-File-Name` into one value ("a, b"), cleaned like any other; an
  // array only comes from a caller passing raw headers, and is ambiguous: use neither.
  if (typeof header !== 'string') return DEFAULT_FILE_NAME;
  // 1. Percent-encoded UTF-8 is printable ASCII on the wire; raw bytes are some other encoding.
  if (!/^[\x20-\x7e]*$/.test(header)) return DEFAULT_FILE_NAME;
  let name: string;
  try {
    name = decodeURIComponent(header);
  } catch {
    return DEFAULT_FILE_NAME;
  }
  // 2–4. Bidi overrides (U+202E) and zero-width characters are Cf: "invoice‮fdp.exe" would
  // otherwise show as "invoiceexe.pdf".
  name = name.normalize('NFC');
  name = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  name = name.replace(/[\p{Cc}\p{Cf}]/gu, '');
  // 5.
  name = cutToBytes(trimEnds(name), MAX_NAME_BYTES);
  // 6.
  return name === '' ? DEFAULT_FILE_NAME : name;
}

/** `name` cut to `max` UTF-8 bytes at a character boundary, keeping a short extension. */
function cutToBytes(name: string, max: number): string {
  if (bytes(name) <= max) return name;
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot) : '';
  const keep = bytes(extension) <= MAX_EXTENSION_BYTES ? extension : '';
  const base = keep === '' ? name : name.slice(0, dot);
  let cut = '';
  let size = bytes(keep);
  // By code point, so a character is never split.
  for (const char of base) {
    const charBytes = bytes(char);
    if (size + charBytes > max) break;
    cut += char;
    size += charBytes;
  }
  return trimEnds(cut) + keep;
}

/** `attr-char` of RFC 8187: everything else in `filename*` is percent-encoded. */
const ATTR_CHAR = /[A-Za-z0-9!#$&+\-.^_`|~]/;

function encodeExtValue(name: string): string {
  let out = '';
  for (const byte of encoder.encode(name)) {
    const char = String.fromCharCode(byte);
    out +=
      byte < 0x80 && ATTR_CHAR.test(char)
        ? char
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/**
 * The plain `filename` for clients that don't read `filename*` (RFC 6266): `"`, `\`, `/`, `;`,
 * `%`, and everything that isn't printable ASCII become `_`, so it can't end the quoted string,
 * name a path or be decoded into something else.
 */
export function asciiFallback(name: string): string {
  let out = '';
  for (const char of name) out += /^[\x20-\x7e]$/.test(char) && !/["\\/;%]/.test(char) ? char : '_';
  return out;
}

/** `attachment; filename="<fallback>"; filename*=UTF-8''<name>` (SPEC-014 §4.8). */
export function attachmentDisposition(name: string): string {
  return `attachment; filename="${asciiFallback(name)}"; filename*=UTF-8''${encodeExtValue(name)}`;
}
