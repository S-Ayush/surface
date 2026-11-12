/**
 * The rules every path into a stored document shares (SPEC-013 §4.4): links, file sources, code
 * block languages and well-formed text. `validateDoc`, Markdown import, paste and `DocView` all
 * use these, so a stored document, a pasted one and a rendered one follow one rule.
 */

/** A code block language: a short name like `typescript`, `c++` or `objective-c`. */
const CODE_LANGUAGE = /^[A-Za-z0-9_+#.-]{1,40}$/;

export function isCodeLanguage(name: string): boolean {
  return CODE_LANGUAGE.test(name);
}

/** NUL, or a UTF-16 surrogate without its pair: Postgres refuses both in `text` and `jsonb`. */
const BROKEN_TEXT_SOURCE =
  '\\0|[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]';
const BROKEN_TEXT = new RegExp(BROKEN_TEXT_SOURCE);
const BROKEN_TEXT_ALL = new RegExp(BROKEN_TEXT_SOURCE, 'g');

/** True when `text` has no NUL and no lone surrogate (SPEC-013 §4.4). */
export function isWellFormedText(text: string): boolean {
  return !BROKEN_TEXT.test(text);
}

/** `text` with each NUL and lone surrogate replaced by U+FFFD, as markdown-it does for NUL. */
export function wellFormedText(text: string): string {
  return text.replace(BROKEN_TEXT_ALL, '�');
}

/** C0 and C1 control characters, DEL, and ASCII whitespace: never allowed in a link. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const FORBIDDEN_IN_HREF = /[\u0000- \u007f-\u009f]/;

/** Only absolute http(s) and mailto links. `https:foo` and `https:\\x` resolve relatively. */
const ALLOWED_PREFIX = /^(?:https?:\/\/|mailto:)/i;
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * True when `href` may be stored as a link: parsed by `new URL` with no base (so relative and
 * protocol-relative links fail), with protocol `http:`, `https:` or `mailto:` in any case, and
 * no control characters or whitespace.
 */
export function isAllowedHref(href: string): boolean {
  if (href.length === 0 || href.length > 2048) return false;
  if (FORBIDDEN_IN_HREF.test(href) || !ALLOWED_PREFIX.test(href)) return false;
  try {
    return ALLOWED_PROTOCOLS.has(new URL(href).protocol);
  } catch {
    return false;
  }
}

/** `/files/<uuid>`, lowercase, as the server writes file URLs (SPEC-014 §4.3). */
const FILE_SRC = /^\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** The file id of an image or file `src`, or null when the `src` isn't exactly `/files/<uuid>`. */
export function fileIdOfSrc(src: string): string | null {
  return FILE_SRC.exec(src)?.[1] ?? null;
}

/** The `src` that refers to an uploaded file. */
export function fileSrc(fileId: string): string {
  return `/files/${fileId}`;
}
