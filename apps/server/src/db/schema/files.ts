import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './workspace.js';

/** What an upload is for (PLAN-001 S6: avatars and the workspace logo; attachments come in M1). */
export const FILE_PURPOSES = ['avatar', 'logo'] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];

/**
 * Uploaded files (ADR-0014; domain-model §4.9). Server-only in M0: avatars and the logo are
 * named by `users.avatar_file_id` and `workspace.logo_file_id`, which sync, and clients load the
 * bytes from `GET /files/:id`. The bytes live in the BlobStore under `storage_key` (content
 * addressed, so equal uploads share them). `mime_type` is the type the server detected or
 * produced, never the one the browser claimed.
 */
export const files = pgTable(
  'files',
  {
    id: uuid().primaryKey(),
    /** `sha256/ab/cd…`: never derived from anything the uploader named. */
    storageKey: text().notNull(),
    purpose: text().$type<FilePurpose>().notNull(),
    /** Ours (`avatar.webp`), not the uploader's file name, which is never stored or logged. */
    name: text().notNull(),
    mimeType: text().notNull(),
    size: integer().notNull(),
    uploaderId: uuid()
      .notNull()
      .references(() => users.id),
    createdAt: timestamp({ withTimezone: true, precision: 3 }).notNull().defaultNow(),
  },
  (t) => [
    check('files_purpose_check', sql`${t.purpose} in ('avatar', 'logo')`),
    index('files_uploader_id_idx').on(t.uploaderId),
  ],
);
