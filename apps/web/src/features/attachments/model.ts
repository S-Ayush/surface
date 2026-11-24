// What the Attachments section shows (SPEC-014 §7; PLAN-014 S5), as plain data. A live issue's
// attachments are the replica's `Attachment` rows; a read-only view's come from `issue.get`
// (SPEC-012 §3.4 item 8). Both become one `AttachmentItem`, so the section has one code path.
//
// A link is never fetched (D10): nothing here requests a URL, it only parses the typed text.
import {
  attachmentTitleProblem,
  bindPredicates,
  normalizeAttachmentTitle,
  parseAttachmentUrl,
  type Actor,
} from '@surface/domain';
import { Attachment } from '@surface/domain/model';
import { attachmentDelete, type AttachmentSummarySchema } from '@surface/operations';
import type { z } from 'zod';

export type AttachmentSummary = z.output<typeof AttachmentSummarySchema>;

/** One row of the section. */
export interface AttachmentItem {
  readonly id: string;
  readonly kind: 'file' | 'link';
  readonly title: string;
  /** `link` only. */
  readonly url: string | null;
  /** `file` only: the file's id, served at `/files/<id>`. */
  readonly fileId: string | null;
  readonly fileName: string | null;
  readonly mimeType: string | null;
  readonly size: number | null;
  readonly imageWidth: number | null;
  readonly imageHeight: number | null;
  /** The preview's address once the preview job made one (§4.4); the type icon until then. */
  readonly previewUrl: string | null;
  readonly creatorId: string | null;
  readonly creatorName: string | null;
  readonly createdAt: string;
}

/** The only types that render inline (SPEC-014 D17): everything else downloads. */
export const INLINE_IMAGE_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

export const isInlineImage = (mimeType: string | null | undefined): boolean =>
  mimeType !== null && mimeType !== undefined && INLINE_IMAGE_TYPES.includes(mimeType);

/** Opens in the image viewer: a file attachment of one of the four raster types. */
export const isViewable = (item: AttachmentItem): boolean =>
  item.kind === 'file' && item.fileId !== null && isInlineImage(item.mimeType);

/** The file's bytes (`GET /files/:id`, visibility checked on every request). */
export const fileHref = (fileId: string): string => `/files/${fileId}`;

/** The same, always as a download with the original name (§4.8 `?download=1`). */
export const downloadHref = (fileId: string): string => `/files/${fileId}?download=1`;

/** Oldest first, then by id, as `issue.get` lists them. */
function byCreation(a: AttachmentItem, b: AttachmentItem): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The replica's rows (a live issue); a row that doesn't parse is skipped. */
export function itemsFromRows(
  rows: readonly unknown[],
  userName: (id: string) => string | undefined,
): AttachmentItem[] {
  const items: AttachmentItem[] = [];
  for (const raw of rows) {
    const parsed = Attachment.rowSchema.safeParse(raw);
    if (!parsed.success) continue;
    const row = parsed.data;
    items.push({
      id: row.id,
      kind: row.kind,
      title: row.title,
      url: row.url,
      fileId: row.fileId,
      fileName: row.fileName,
      mimeType: row.mimeType,
      size: row.size,
      imageWidth: row.imageWidth,
      imageHeight: row.imageHeight,
      previewUrl: row.previewFileId === null ? null : fileHref(row.previewFileId),
      creatorId: row.creatorId,
      creatorName: userName(row.creatorId) ?? null,
      createdAt: String(row.createdAt),
    });
  }
  return items.sort(byCreation);
}

/** The id at the end of a `/files/<id>` address (`issue.get` answers absolute URLs). */
function fileIdOfUrl(url: string | null): string | null {
  if (url === null) return null;
  const match = /\/files\/([0-9a-f-]{36})(?:[?#].*)?$/i.exec(url);
  return match?.[1] ?? null;
}

/** `issue.get`'s attachments (the read-only view). */
export function itemsFromSummaries(summaries: readonly AttachmentSummary[]): AttachmentItem[] {
  return summaries
    .map((summary) => {
      const previewId = fileIdOfUrl(summary.previewUrl);
      return {
        id: summary.id,
        kind: summary.kind,
        title: summary.title,
        url: summary.url,
        fileId: fileIdOfUrl(summary.downloadUrl),
        fileName: summary.fileName,
        mimeType: summary.mimeType,
        size: summary.size,
        imageWidth: summary.imageWidth,
        imageHeight: summary.imageHeight,
        previewUrl: previewId === null ? null : fileHref(previewId),
        creatorId: summary.creator.id,
        creatorName: summary.creator.name,
        createdAt: summary.createdAt,
      };
    })
    .sort(byCreation);
}

const UNITS = ['KB', 'MB', 'GB'] as const;

/** "512 bytes", "1.2 KB", "25 MB" (1 KB = 1,024 bytes, as file managers show it). */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes === 1 ? '1 byte' : `${String(bytes)} bytes`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${String(shown)} ${UNITS[unit] ?? 'GB'}`;
}

/** A link's host, for the row ("figma.com"); the text itself when it doesn't parse. */
export function hostOf(url: string): string {
  const parsed = parseAttachmentUrl(url);
  if (!parsed.ok) return url;
  const match = /^https?:\/\/([^/?#:]+)/.exec(parsed.url);
  const host = match?.[1] ?? url;
  return host.startsWith('www.') ? host.slice(4) : host;
}

/** The row's second line: size (files) or host (links). */
export function detailOf(item: AttachmentItem): string {
  if (item.kind === 'link') return item.url === null ? '' : hostOf(item.url);
  return item.size === null ? '' : formatSize(item.size);
}

/**
 * What **Copy link** copies: a link's own address, or the file's address on this Surface (only
 * readers of the issue can open it, §4.2).
 */
export function linkOf(item: AttachmentItem, origin: string): string | undefined {
  if (item.kind === 'link') return item.url ?? undefined;
  return item.fileId === null ? undefined : `${origin}${fileHref(item.fileId)}`;
}

/** The command target's chip text (command-menu.md §3.3): "Attachment: design.pdf". */
export const targetLabel = (item: Pick<AttachmentItem, 'title'>): string =>
  `Attachment: ${item.title}`;

/** The link form's answer: what to send, or which field is wrong and why (§6.4 wording). */
export type LinkFormResult =
  | { readonly ok: true; readonly url: string; readonly title?: string }
  | { readonly ok: false; readonly field: 'url' | 'title'; readonly message: string };

/** Checks the link form as the server would (AC-17's shared rules), before dispatching. */
export function checkLinkForm(url: string, title: string): LinkFormResult {
  if (url.trim() === '') return { ok: false, field: 'url', message: 'Enter a web address.' };
  const parsed = parseAttachmentUrl(url);
  if (!parsed.ok) return { ok: false, field: 'url', message: parsed.problem };
  if (normalizeAttachmentTitle(title) === '') return { ok: true, url: parsed.url };
  const problem = attachmentTitleProblem(title);
  if (problem !== undefined) return { ok: false, field: 'title', message: problem };
  return { ok: true, url: parsed.url, title: normalizeAttachmentTitle(title) };
}

/**
 * The URL when pasted text is one web address and nothing else (§3.2): spaces around it are
 * fine, anything else around it is not. Undefined for other text.
 */
export function loneUrl(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === '' || /\s/.test(trimmed)) return undefined;
  const parsed = parseAttachmentUrl(trimmed);
  return parsed.ok ? parsed.url : undefined;
}

/** What the row's Rename and Remove act on. */
export interface AttachmentChange {
  readonly id: string;
  /** The issue's team. */
  readonly teamId: string;
  readonly creatorId: string | null;
}

/**
 * Whether `actor` may rename and remove the attachment (SPEC-014 §5, AC-9: its creator, members of
 * its issue's team, or Admins). It asks `attachment.delete`'s own permission, as the command
 * menu's pre-check does, so the row menu and the menu agree; `attachment.update` has the same one.
 */
export function mayChangeAttachment(actor: Actor | null, attachment: AttachmentChange): boolean {
  if (actor === null) return false;
  const refs = {
    attachment: { id: attachment.id, teamId: attachment.teamId, creatorId: attachment.creatorId },
  };
  return attachmentDelete.permission(bindPredicates(actor).p, refs, { attachment: attachment.id });
}
