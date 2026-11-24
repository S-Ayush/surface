/**
 * Attachment rules (SPEC-014 §4.1, §6.4; PLAN-014 S4a), shared by the client's optimistic code
 * and the server's handlers, so both decide the same title and the same URL (AC-17).
 *
 * A link is never fetched (D10, architecture rule 5): these functions only parse the text the
 * person typed. A private or internal address is allowed (E12); only the scheme and credentials
 * are refused (E11).
 */
import { z } from 'zod';
import { normalizeTitle } from './issue.js';

const NORMALIZED_URL = z.url({ normalize: true });

/** At most this many attachments per issue (D20), counted under the issue row lock. */
export const MAX_ATTACHMENTS_PER_ISSUE = 100;

/** A title's length, in code points, after trimming (§4.1). */
export const ATTACHMENT_TITLE_MAX_LENGTH = 255;

/** A link's length, in characters, as typed and as stored (§4.1). */
export const ATTACHMENT_URL_MAX_LENGTH = 2048;

export const ATTACHMENT_KINDS = ['file', 'link'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** SPEC-014 §6.4 wording. */
export const ATTACHMENT_MESSAGES = {
  limit: `An issue can have at most ${MAX_ATTACHMENTS_PER_ISSUE} attachments. Remove one first.`,
  badScheme: 'Use a web address that starts with https:// or http://.',
  credentials: "Web addresses can't include a user name or password.",
  urlTooLong: `Web addresses must be ${ATTACHMENT_URL_MAX_LENGTH} characters or fewer.`,
  titleRequired: 'Title is required.',
  titleTooLong: `Title must be ${ATTACHMENT_TITLE_MAX_LENGTH} characters or fewer.`,
  /** `NOT_FOUND` on `file` (§6.4): the same words for every file `createFile` can't take. */
  fileNotFound: "That upload has expired or isn't yours. Upload the file again.",
} as const;

/** A title as stored: line breaks become spaces, surrounding spaces trimmed (as issue titles). */
export function normalizeAttachmentTitle(title: string): string {
  return normalizeTitle(title);
}

/** Why `title` can't be an attachment title, or undefined if it can (§4.1: 1–255 characters). */
export function attachmentTitleProblem(title: string): string | undefined {
  const normalized = normalizeAttachmentTitle(title);
  if (normalized.length === 0) return ATTACHMENT_MESSAGES.titleRequired;
  if ([...normalized].length > ATTACHMENT_TITLE_MAX_LENGTH) return ATTACHMENT_MESSAGES.titleTooLong;
  return undefined;
}

/** The first `max` code points of `text`: never cuts a character in half. */
function cut(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : points.slice(0, max).join('');
}

/** The result of parsing a typed link (§4.1). */
export type ParsedAttachmentUrl =
  { readonly ok: true; readonly url: string } | { readonly ok: false; readonly problem: string };

/**
 * A typed link as stored, or why it is refused (§4.1, E11): an absolute `http:` or `https:` URL
 * of at most 2,048 characters, without a user name or password. Stored as the URL parser writes
 * it (`href`), so client and server store the same text. Never fetched.
 */
export function parseAttachmentUrl(input: string): ParsedAttachmentUrl {
  const typed = input.trim();
  if (typed.length > ATTACHMENT_URL_MAX_LENGTH) {
    return { ok: false, problem: ATTACHMENT_MESSAGES.urlTooLong };
  }
  // The platform's URL parser, through Zod (this package has no DOM or Node types): `href`.
  const parsed = NORMALIZED_URL.safeParse(typed);
  if (!parsed.success) return { ok: false, problem: ATTACHMENT_MESSAGES.badScheme };
  const href = parsed.data;
  if (!/^https?:\/\//.test(href)) return { ok: false, problem: ATTACHMENT_MESSAGES.badScheme };
  // A serialised http(s) URL has `@` before its host only when it carries a user name or password.
  if (/^https?:\/\/[^/?#]*@/.test(href)) {
    return { ok: false, problem: ATTACHMENT_MESSAGES.credentials };
  }
  // Parsing can lengthen the text (percent-encoding): the stored form must fit too.
  if (href.length > ATTACHMENT_URL_MAX_LENGTH) {
    return { ok: false, problem: ATTACHMENT_MESSAGES.urlTooLong };
  }
  return { ok: true, url: href };
}

/**
 * A link's title when the person typed none (§4.1): the stored URL without its scheme, cut to
 * 255 characters. The page is never fetched for its title (D10).
 */
export function defaultLinkTitle(url: string): string {
  const bare = url.replace(/^https?:\/\//i, '');
  return cut(bare === '' ? url : bare, ATTACHMENT_TITLE_MAX_LENGTH);
}

/**
 * The title an attachment gets: the one typed, normalised, or the default (the file name, or the
 * link without its scheme), cut to 255 characters. A blank typed title counts as none.
 */
export function attachmentTitle(typed: string | undefined, fallback: string): string {
  const normalized = typed === undefined ? '' : normalizeAttachmentTitle(typed);
  if (normalized !== '') return normalized;
  return cut(normalizeAttachmentTitle(fallback), ATTACHMENT_TITLE_MAX_LENGTH) || 'file';
}

/** An attachment as a history entry names it (§6.3): its id, kind and title at the time. */
export interface HistoryAttachment {
  readonly id: string;
  readonly kind: AttachmentKind;
  readonly title: string;
}
