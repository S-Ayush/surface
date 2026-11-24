/**
 * The `attachments` table (PLAN-014 S4a, SPEC-014 §4.1, §4.10): the eager `Attachment` model.
 * Synced: written only through `sync/repo.ts`. Like every synced table, it holds only its
 * model's fields plus `sync_groups` (`team:<teamId>` only, SPEC-011 §5.7).
 *
 * Every foreign key is `ON DELETE RESTRICT`: purge deletes an issue's attachments through the
 * repo (one `D` each) before the issue and its files (SPEC-015 §4.5), so no cascade hides that.
 * The keys to `files` hold the invariant that an attachment never names a missing file
 * (SPEC-014 §4.9); a file's last attachment is always deleted before the file.
 */
import { ATTACHMENT_KINDS, type AttachmentKind } from '@surface/domain';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { files } from './files.js';
import { issues } from './issues.js';
import { instant, oneOf, syncGroups, teams, users } from './workspace.js';

export const attachments = pgTable(
  'attachments',
  {
    id: uuid().primaryKey(),
    issueId: uuid()
      .notNull()
      .references(() => issues.id, { onDelete: 'restrict' }),
    /** Denormalised: always the issue's team (SPEC-011 §5.1). The repo sets it from the issue row. */
    teamId: uuid()
      .notNull()
      .references(() => teams.id, { onDelete: 'restrict' }),
    kind: text().$type<AttachmentKind>().notNull(),
    title: text().notNull(),
    /** `link` only. Never fetched (SPEC-014 D10). */
    url: text(),
    /** `file` only: a file of purpose `attachment` owned by `issue_id` (§4.9). */
    fileId: uuid().references(() => files.id, { onDelete: 'restrict' }),
    fileName: text(),
    mimeType: text(),
    size: bigint({ mode: 'number' }),
    imageWidth: integer(),
    imageHeight: integer(),
    previewFileId: uuid().references(() => files.id, { onDelete: 'restrict' }),
    creatorId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    syncGroups: syncGroups(),
    createdAt: instant().notNull().defaultNow(),
    updatedAt: instant().notNull().defaultNow(),
  },
  (t) => [
    // The issue's attachments: `issue.get`, the 100 limit, purge and restore's re-log.
    index('attachments_issue_id_idx').on(t.issueId, t.id),
    // One attachment per file at a time: an undo re-attaches a detached file with a new row.
    uniqueIndex('attachments_file_id_idx').on(t.fileId),
    index('attachments_preview_file_id_idx').on(t.previewFileId),
    index('attachments_sync_groups_idx').using('gin', t.syncGroups),
    check('attachments_kind_check', oneOf(t.kind, ATTACHMENT_KINDS)),
    check('attachments_title_check', sql`char_length(${t.title}) BETWEEN 1 AND 255`),
    check('attachments_link_check', sql`(${t.kind} = 'link') = (${t.url} IS NOT NULL)`),
    check('attachments_url_check', sql`${t.url} IS NULL OR char_length(${t.url}) <= 2048`),
    check('attachments_file_check', sql`(${t.kind} = 'file') = (${t.fileId} IS NOT NULL)`),
    check('attachments_size_check', sql`${t.size} IS NULL OR ${t.size} >= 0`),
  ],
);
