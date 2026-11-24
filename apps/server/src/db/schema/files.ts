import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { issues } from './issues.js';
import { instant, users } from './workspace.js';

/**
 * What an upload is for: avatars and the workspace logo (PLAN-001 S6), and issue files
 * (SPEC-014 §4.2): `attachment`, `inline` (an image or file in a document) and `preview`
 * (the server's WebP of an attached image).
 */
export const FILE_PURPOSES = ['avatar', 'logo', 'attachment', 'inline', 'preview'] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];

/**
 * Uploaded files (ADR-0014, ADR-0021; SPEC-014 §4.2). Server-only, never synced: avatars and the
 * logo are named by `users.avatar_file_id` and `workspace.logo_file_id` (foreign keys added by the
 * custom migration `0012`, since declaring them here would make this module and `workspace.ts`
 * import each other), issue files by Attachment rows and document `src`. Clients load the bytes
 * from `GET /files/:id`. The bytes live in the BlobStore under `storage_key` (content addressed,
 * so equal uploads share them; SPEC-014 §4.5). `mime_type` is the type the server detected or
 * produced, never the one the browser claimed.
 */
export const files = pgTable(
  'files',
  {
    id: uuid().primaryKey(),
    /** `sha256/ab/cd…`: never derived from anything the uploader named. */
    storageKey: text().notNull(),
    purpose: text().$type<FilePurpose>().notNull(),
    /**
     * Ours for avatars and logos (`avatar.webp`); the uploader's cleaned name for `attachment`
     * and `inline` (SPEC-014 §4.8). Never logged.
     */
    name: text().notNull(),
    mimeType: text().notNull(),
    /** Bytes. `bigint`: `UPLOAD_MAX_MB` allows files over 2 GB (SPEC-014 §4.2). */
    size: bigint({ mode: 'number' }).notNull(),
    uploaderId: uuid()
      .notNull()
      .references(() => users.id),
    /**
     * The owner: the issue an `attachment` or `inline` file belongs to, null while unclaimed and
     * for previews (they follow `preview_of`). Never changes once set. RESTRICT, never cascade:
     * purge deletes an issue's files under the byte protocol (SPEC-014 §4.7; PLAN-014 S4a).
     */
    issueId: uuid().references(() => issues.id, { onDelete: 'restrict' }),
    /** `attachment` only: set when its Attachment is deleted; readable by nobody (§4.2). */
    detachedAt: instant(),
    /** Raster images only. */
    width: integer(),
    height: integer(),
    /**
     * For a preview, the file it shows. RESTRICT, never cascade: every deleter removes previews
     * first under the byte protocol, so their keys reach `blob_release` (SPEC-014 §4.5).
     */
    previewOf: uuid().references((): AnyPgColumn => files.id, { onDelete: 'restrict' }),
    createdAt: instant().notNull().defaultNow(),
  },
  (t) => [
    check(
      'files_purpose_check',
      sql`${t.purpose} in ('avatar', 'logo', 'attachment', 'inline', 'preview')`,
    ),
    // SPEC-014 §4.2: a preview always names its source and nothing else does, and only an
    // attachment can be detached.
    check('files_preview_of_check', sql`(${t.purpose} = 'preview') = (${t.previewOf} IS NOT NULL)`),
    check('files_detached_at_check', sql`${t.detachedAt} IS NULL OR ${t.purpose} = 'attachment'`),
    index('files_uploader_id_idx').on(t.uploaderId),
    // SPEC-014 §4.2: the byte protocol finds a key's rows (§4.5), purge an issue's files,
    // deleters a file's previews, and the upload route a user's unclaimed uploads (§4.6 caps).
    index('files_storage_key_idx').on(t.storageKey),
    index('files_issue_id_idx').on(t.issueId),
    index('files_preview_of_idx').on(t.previewOf),
    index('files_unclaimed_uploader_idx')
      .on(t.uploaderId)
      .where(sql`${t.issueId} IS NULL AND ${t.purpose} IN ('attachment', 'inline')`),
  ],
);

/**
 * Storage keys whose last row may be gone (SPEC-014 §4.5 step 4). Server-only. A transaction
 * that deletes `files` rows inserts their keys here; `files-cleanup` unlinks the bytes after
 * commit, under the key lock, only when no row names the key any more.
 */
export const blobRelease = pgTable('blob_release', {
  storageKey: text().primaryKey(),
  releasedAt: instant().notNull().defaultNow(),
});
