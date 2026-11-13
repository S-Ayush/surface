/**
 * The `files` rows (server-only, ADR-0014, ADR-0021; PLAN-001 S6, PLAN-014 S1). Uploading writes
 * one, through the byte protocol (`bytes.ts`, the only module that inserts or deletes rows);
 * nothing synced changes until an operation names the file (`user.updateProfile`,
 * `workspace.update`, `attachment.createFile`).
 *
 * Every read of a file goes through `visibleFile` (SPEC-014 §4.2): `GET /files/:id`, `HEAD`, the
 * `If-None-Match` path and the `FileRef` resolver. Its SQL is built by one function,
 * `visibleFileQuery`, so a later branch is added there and never as a second predicate.
 */
import type { Actor } from '@surface/domain';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { LOCK_CLASSES } from '../db/locks.js';
import type { Queryable } from '../db/pool.js';
import type { FilePurpose } from '../db/schema/index.js';
import type { BlobStore } from './blob-store.js';
import { insertUpload, pgFileTx, type NewFile } from './bytes.js';
import { overCaps, type UnclaimedUsage } from './limits.js';

export type { NewFile } from './bytes.js';

export interface VisibleFile {
  readonly id: string;
  readonly purpose: FilePurpose;
  /** Seeing a file is not owning it: setting an avatar or logo takes only your own upload. */
  readonly uploaderId: string;
  readonly storageKey: string;
  readonly mimeType: string;
  readonly size: number;
  /** The cleaned upload name (SPEC-014 §4.8), for the download's `Content-Disposition`. */
  readonly name: string;
}

/**
 * Who reads a file. `groups` is every group the reader may see (SPEC-011 §5.7), never a socket's
 * subscriptions; `keyTeamIds` is an API key's team limit after narrowing (permissions §3.5), or
 * null when the reader isn't narrowed.
 */
export interface FileReader {
  readonly userId: string;
  readonly groups: readonly string[];
  readonly keyTeamIds: readonly string[] | null;
}

/** The reader an actor is, or undefined for an actor without a user (it reads no file). */
export function fileReaderOf(
  actor: Pick<Actor, 'userId' | 'groups' | 'apiKey'>,
): FileReader | undefined {
  if (actor.userId === undefined) return undefined;
  const teamIds = actor.apiKey?.teamIds ?? [];
  return {
    userId: actor.userId,
    groups: actor.groups,
    keyTeamIds: teamIds.length > 0 ? teamIds : null,
  };
}

/**
 * The SPEC-014 §4.2 predicate as one statement. `s` is the file whose owner decides: `f` itself,
 * or its source when `f` is a preview.
 *
 * S1 has the branches that need no `issues` table: the M0 avatar/logo rule and the unclaimed
 * upload. A claimed `attachment` or `inline` file, and every preview, match no branch yet.
 * PLAN-014 S4a adds the issue branch (`EXISTS (SELECT 1 FROM issues …)`); Postgres refuses to plan
 * a statement naming a missing table, so it can't ship before PLAN-011 S3.
 */
export function visibleFileQuery(fileId: string, reader: FileReader): SQL {
  return sql`SELECT f.id, f.purpose, f.uploader_id AS "uploaderId", f.storage_key AS "storageKey",
                    f.mime_type AS "mimeType", f.size, f.name
               FROM files f
               JOIN files s ON s.id = coalesce(f.preview_of, f.id)
              WHERE f.id = ${fileId}
                AND (${sql.join([...fileVisibilityBranches(reader)], sql` OR `)})`;
}

/** The OR-ed branches of `visibleFileQuery`, over `f` (the file) and `s` (its source). */
export function fileVisibilityBranches(reader: FileReader): readonly SQL[] {
  const branches: SQL[] = [
    // M0 rule, unchanged: avatars and the logo are workspace-wide once a user or the workspace
    // names them (those rows sync to everyone), and their uploader's until then.
    sql`(s.purpose IN ('avatar', 'logo')
         AND (s.uploader_id = ${reader.userId}
              OR EXISTS (SELECT 1 FROM users u WHERE u.avatar_file_id = s.id)
              OR EXISTS (SELECT 1 FROM workspace w WHERE w.logo_file_id = s.id)))`,
  ];
  // An unclaimed upload is its uploader's alone, and belongs to no team, so a key limited to
  // some teams never reads one (the matrix's key column). Previews are only made after claiming:
  // one of an unclaimed file is visible to nobody.
  if (reader.keyTeamIds === null) {
    branches.push(
      sql`(f.preview_of IS NULL
           AND s.purpose IN ('attachment', 'inline')
           AND s.issue_id IS NULL
           AND s.uploader_id = ${reader.userId})`,
    );
  }
  return branches;
}

const dialect = new PgDialect();

interface VisibleRow {
  id: string;
  purpose: FilePurpose;
  uploaderId: string;
  storageKey: string;
  mimeType: string;
  /** `bigint`: node-postgres reads it as a string. */
  size: string | number;
  name: string;
}

/** The file if `reader` may see it, else undefined (shown as not found, permissions §5). */
export async function visibleFile(
  db: Pick<Queryable, 'query'>,
  fileId: string,
  reader: FileReader,
): Promise<VisibleFile | undefined> {
  const query = dialect.sqlToQuery(visibleFileQuery(fileId, reader));
  const { rows } = await db.query<VisibleRow>(query.sql, query.params);
  const row = rows[0];
  if (row === undefined) return undefined;
  return {
    id: row.id,
    purpose: row.purpose,
    uploaderId: row.uploaderId,
    storageKey: row.storageKey,
    mimeType: row.mimeType,
    size: Number(row.size),
    name: row.name,
  };
}

/**
 * The SPEC-014 §4.6 per-user caps: how many `attachment` and `inline` uploads of `userId` are
 * unclaimed, and their bytes. Served by `files_unclaimed_uploader_idx`.
 */
export function unclaimedUsageQuery(userId: string): SQL {
  return sql`SELECT count(*) AS files, coalesce(sum(size), 0) AS bytes
               FROM files
              WHERE uploader_id = ${userId}
                AND issue_id IS NULL
                AND purpose IN ('attachment', 'inline')`;
}

export async function unclaimedUsage(
  db: Pick<Queryable, 'query'>,
  userId: string,
): Promise<UnclaimedUsage> {
  const query = dialect.sqlToQuery(unclaimedUsageQuery(userId));
  // `count` and `sum` of a `bigint` arrive as strings.
  const { rows } = await db.query<{ files: string | number; bytes: string | number }>(
    query.sql,
    query.params,
  );
  const row = rows[0];
  return { files: Number(row?.files ?? 0), bytes: Number(row?.bytes ?? 0) };
}

/**
 * Whether one more upload of `incoming` bytes fits the uploader's caps, decided inside the insert's
 * transaction under a per-uploader transaction lock (review M2). Parallel uploads all pass the
 * check made before reading; here each waits for the one before to commit, so its row is counted.
 */
export async function reserveUpload(
  db: Pick<Queryable, 'query'>,
  userId: string,
  incoming: number,
): Promise<boolean> {
  await db.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [
    LOCK_CLASSES.uploadCaps,
    userId,
  ]);
  return !overCaps(await unclaimedUsage(db, userId), incoming);
}

export interface FileStore {
  /** `insertUpload` (`bytes.ts`): the key lock, the rename, then the row (SPEC-014 §4.5). */
  insertUpload(
    client: Queryable,
    blobs: Pick<BlobStore, 'commit'>,
    temp: { readonly tempPath: string; readonly key: string },
    file: Omit<NewFile, 'storageKey'>,
  ): Promise<void>;
  /** `visibleFile`; an interface so route tests keep a fake. */
  visibleFile(
    client: Queryable,
    fileId: string,
    reader: FileReader,
  ): Promise<VisibleFile | undefined>;
  /** `unclaimedUsage`: the uploader's unclaimed files for the per-user caps. */
  unclaimedUsage(client: Queryable, userId: string): Promise<UnclaimedUsage>;
  /** `reserveUpload`: the caps again, under the uploader's lock, in the insert's transaction. */
  reserveUpload(client: Queryable, userId: string, incoming: number): Promise<boolean>;
}

export const PG_FILE_STORE: FileStore = {
  insertUpload: (client, blobs, temp, file) => insertUpload(pgFileTx(client), blobs, temp, file),
  visibleFile,
  unclaimedUsage,
  reserveUpload,
};

/** What `/metrics` reports about stored files (SPEC-014 §10). */
export interface FileStorageStats {
  /** Bytes on the uploads volume: each key counted once, however many rows share it. */
  readonly storedBytes: number;
  /** Keys in `blob_release` waiting for the drain. */
  readonly releaseBacklog: number;
}

export async function fileStorageStats(db: Pick<Queryable, 'query'>): Promise<FileStorageStats> {
  const { rows } = await db.query<{ stored: string | number; backlog: string | number }>(
    `SELECT (SELECT coalesce(sum(size), 0)
               FROM (SELECT DISTINCT ON (storage_key) size FROM files ORDER BY storage_key) k)
              AS stored,
            (SELECT count(*) FROM blob_release) AS backlog`,
  );
  const row = rows[0];
  return { storedBytes: Number(row?.stored ?? 0), releaseBacklog: Number(row?.backlog ?? 0) };
}
