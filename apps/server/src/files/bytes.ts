/**
 * The byte protocol (SPEC-014 §4.5, ADR-0021; PLAN-014 S3): the only module that inserts or
 * deletes `files` rows, and the only one that unlinks stored bytes.
 *
 * Several rows can share one storage key (content addressing), so every writer follows one rule:
 * - every insert or delete of a row takes the key's lock, `pg_advisory_xact_lock(fileBytes,
 *   hashtext(key))`, in its transaction; several keys in ascending order, after any issue or
 *   file row lock (row locks first, then key locks, everywhere);
 * - an upload renames its temporary file over the key under that lock, then inserts the row;
 *   any other insert checks the bytes are there under the lock;
 * - a delete never unlinks: it records the key in `blob_release`, and the drain unlinks it later,
 *   under the lock, only if no row names the key any more; the sweep removes bytes with no row
 *   and stale temporary files, under the same lock.
 *
 * So no row ever names missing bytes, and no bytes outlive their last row past the next drain or
 * sweep (AC-14). The locks rely on `READ COMMITTED` (every transaction runner here uses it): each
 * statement after the lock sees what the previous holder committed.
 *
 * The SQL sits behind `FileTx` and `FileDb` so the property test drives this exact code against
 * a model of Postgres's locks (`test/files-bytes-model.ts`); `files-bytes-pg.int.test.ts` runs it
 * against real Postgres.
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { PgDialect } from 'drizzle-orm/pg-core';
import { LOCK_CLASSES } from '../db/locks.js';
import type { Pool, Queryable } from '../db/pool.js';
import { files, type FilePurpose } from '../db/schema/index.js';
import { transactionRunner } from '../executor/transaction.js';
import type { BlobStore } from './blob-store.js';
import { TEMP_FILE_MAX_AGE_MS } from './limits.js';

export interface NewFile {
  readonly id: string;
  readonly storageKey: string;
  readonly purpose: FilePurpose;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly uploaderId: string;
  /** The owning issue; null or absent while unclaimed (SPEC-014 §4.2). */
  readonly issueId?: string | null;
  /** Raster images only. */
  readonly width?: number | null;
  readonly height?: number | null;
  /** For a `preview`, the file it shows. */
  readonly previewOf?: string | null;
}

/** A row the protocol locked: what it needs to release its key. */
export interface FileKeyRow {
  readonly id: string;
  readonly storageKey: string;
}

/** A locked preview row, with the source it shows. */
export interface PreviewKeyRow extends FileKeyRow {
  readonly previewOf: string;
}

/** Why `files-cleanup` deletes a row (SPEC-014 §4.6). */
export type CleanupReason = 'unclaimed' | 'detached' | 'unused';

export interface CleanupCandidate {
  readonly id: string;
  readonly reason: CleanupReason;
}

/** What the protocol needs of one `READ COMMITTED` transaction. */
export interface FileTx {
  /** Each key's transaction lock, in ascending key order (SPEC-014 §4.5 step 1). */
  lockKeys(keys: readonly string[]): Promise<void>;
  /** The rows that exist among `ids`, locked in id order (`FOR UPDATE` or `FOR SHARE`). */
  lockFiles(ids: readonly string[], mode: 'update' | 'share'): Promise<FileKeyRow[]>;
  /** The previews of `sourceIds`, locked `FOR UPDATE` in id order. */
  lockPreviews(sourceIds: readonly string[]): Promise<PreviewKeyRow[]>;
  insertFile(file: NewFile): Promise<void>;
  deleteFiles(ids: readonly string[]): Promise<void>;
  /** Records keys whose last row may be gone (`blob_release`). */
  releaseKeys(keys: readonly string[]): Promise<void>;
  /** Whether any row names `key`. Call it holding the key's lock. */
  keyInUse(key: string): Promise<boolean>;
  /** Removes `key` from `blob_release`; false if it wasn't there (another drain took it). */
  forgetKey(key: string): Promise<boolean>;
  /**
   * Up to `limit` rows `files-cleanup` deletes, created (or detached) before `cutoff`, after id
   * `after`, in id order, locked `FOR UPDATE SKIP LOCKED`: a row another transaction holds (a
   * claim, a delete, a second run) is left for the next run.
   */
  cleanupCandidates(
    cutoff: Date,
    after: string | undefined,
    limit: number,
  ): Promise<CleanupCandidate[]>;
  /** Runs `fn` in a savepoint; if it throws, rolls back to the savepoint and rethrows. */
  savepoint<T>(fn: () => Promise<T>): Promise<T>;
}

/** The jobs' side: transactions, and the two reads made outside one. */
export interface FileDb {
  transaction<T>(fn: (tx: FileTx) => Promise<T>): Promise<T>;
  /** Up to `limit` keys in `blob_release` after `after`, in key order. */
  releasedKeys(limit: number, after: string | undefined): Promise<string[]>;
  /** Which of `keys` some row names. Without a lock: the sweep's first, cheap pass. */
  keysInUse(keys: readonly string[]): Promise<Set<string>>;
}

/** Bytes a row is about to name are missing: the protocol is broken somewhere (§4.5 step 3). */
export class FileBytesMissing extends Error {
  constructor(readonly fileId: string) {
    // No key or name: they never reach a log or an answer.
    super('File bytes missing.');
    this.name = 'FileBytesMissing';
  }
}

/**
 * Step 2: an upload. Under the key lock, renames the temporary file over the key (always, even
 * when the key exists, §4.5), then inserts the row. A retried transaction repeats the rename,
 * which `commit` allows. If the transaction then fails, the bytes stay under the key for the
 * sweep; the caller removes a temporary file still there.
 */
export async function insertUpload(
  tx: FileTx,
  blobs: Pick<BlobStore, 'commit'>,
  temp: { readonly tempPath: string; readonly key: string },
  file: Omit<NewFile, 'storageKey'>,
): Promise<void> {
  await tx.lockKeys([temp.key]);
  await blobs.commit(temp.tempPath, temp.key);
  await tx.insertFile({ ...file, storageKey: temp.key });
}

/**
 * Step 3: a new row for bytes already stored (the §4.3 copy). The caller locks the source row
 * `FOR SHARE` first, so it can't be deleted meanwhile. Missing bytes mean a broken invariant:
 * logged as `file bytes missing` and thrown, so the operation answers `INTERNAL`.
 */
export async function insertCopy(
  tx: FileTx,
  blobs: Pick<BlobStore, 'stat'>,
  file: NewFile,
  log: { error(object: object, message: string): void },
): Promise<void> {
  await tx.lockKeys([file.storageKey]);
  if ((await blobs.stat(file.storageKey)) === undefined) {
    log.error({ fileId: file.id }, 'file bytes missing');
    throw new FileBytesMissing(file.id);
  }
  await tx.insertFile(file);
}

/**
 * A preview of `file.previewOf` (§4.4): its source row locked `FOR SHARE` (so a deleter, which
 * locks it `FOR UPDATE`, waits or is waited for), then an upload. False, with nothing inserted,
 * if the source is gone; the caller then discards the temporary file.
 */
export async function insertPreview(
  tx: FileTx,
  blobs: Pick<BlobStore, 'commit'>,
  temp: { readonly tempPath: string; readonly key: string },
  file: Omit<NewFile, 'storageKey' | 'previewOf'> & { readonly previewOf: string },
): Promise<boolean> {
  const [source] = await tx.lockFiles([file.previewOf], 'share');
  if (source === undefined) return false;
  await insertUpload(tx, blobs, temp, file);
  return true;
}

export interface DeletedFiles {
  /** Rows of `ids` deleted (those already gone don't count). */
  readonly files: number;
  /** Their previews, deleted first. */
  readonly previews: number;
}

/** Rows locked for deleting, with their previews, and every key they name locked too. */
export interface LockedForDelete {
  readonly sources: readonly FileKeyRow[];
  readonly previews: readonly PreviewKeyRow[];
}

/**
 * Step 4's locks: each source row `FOR UPDATE` (so a preview job can't add a preview in
 * between), then their previews, then every key they name, once, in ascending order. All of a
 * transaction's keys are locked here before any row is deleted, so two deleters sharing keys
 * never wait on each other in a cycle.
 */
export async function lockForDelete(tx: FileTx, ids: readonly string[]): Promise<LockedForDelete> {
  const sources = await tx.lockFiles(ids, 'update');
  if (sources.length === 0) return { sources, previews: [] };
  const sourceIds = new Set(sources.map((row) => row.id));
  // A preview named in `ids` is deleted as a source already.
  const previews = (await tx.lockPreviews([...sourceIds])).filter((row) => !sourceIds.has(row.id));
  await tx.lockKeys([...sources, ...previews].map((row) => row.storageKey));
  return { sources, previews };
}

/**
 * Step 4's deletes, on rows `lockForDelete` locked: the previews of `sources`, then `sources`
 * (RESTRICT keys refuse the reverse), and every key into `blob_release`. Never unlinks: the drain
 * does, after commit. A delete that fails a foreign key (an avatar named meanwhile) throws.
 */
export async function deleteLocked(
  tx: FileTx,
  locked: LockedForDelete,
  sources: readonly FileKeyRow[] = locked.sources,
): Promise<DeletedFiles> {
  if (sources.length === 0) return { files: 0, previews: 0 };
  const sourceIds = new Set(sources.map((row) => row.id));
  const previews = locked.previews.filter((row) => sourceIds.has(row.previewOf));
  if (previews.length > 0) await tx.deleteFiles(previews.map((row) => row.id));
  await tx.deleteFiles([...sourceIds]);
  await tx.releaseKeys([...new Set([...sources, ...previews].map((row) => row.storageKey))]);
  return { files: sourceIds.size, previews: previews.length };
}

/**
 * Step 4: deletes `ids` and their previews (purge, PLAN-015 S2 and PLAN-014 S4a). Take any issue
 * row lock first. A foreign key failure throws and the caller's transaction rolls back.
 */
export async function deleteFiles(tx: FileTx, ids: readonly string[]): Promise<DeletedFiles> {
  return deleteLocked(tx, await lockForDelete(tx, ids));
}

export interface Drained {
  /** Keys whose bytes were unlinked: no row named them. */
  readonly unlinked: number;
  /** Keys a row still names: their bytes stay. */
  readonly kept: number;
}

/**
 * Step 4's second half (`files-cleanup`): per key in `blob_release`, in its own transaction,
 * takes the key lock, forgets the key, and unlinks the bytes if no row names it. A crash
 * leaves the key in `blob_release` (drained next run) or bytes without a row (the sweep's).
 */
export async function drainBlobRelease(
  db: FileDb,
  blobs: Pick<BlobStore, 'delete'>,
  batch = 100,
): Promise<Drained> {
  let unlinked = 0;
  let kept = 0;
  let after: string | undefined;
  for (;;) {
    const keys = await db.releasedKeys(batch, after);
    for (const key of keys) {
      const outcome = await db.transaction(async (tx) => {
        await tx.lockKeys([key]);
        // A drain running at the same time got here first.
        if (!(await tx.forgetKey(key))) return 'gone';
        if (await tx.keyInUse(key)) return 'kept';
        await blobs.delete(key);
        return 'unlinked';
      });
      if (outcome === 'unlinked') unlinked++;
      else if (outcome === 'kept') kept++;
    }
    after = keys.at(-1);
    if (keys.length < batch) return { unlinked, kept };
  }
}

export interface Swept {
  /** Keys on disk that no row named. */
  readonly orphans: number;
  /** Temporary files older than `TEMP_FILE_MAX_AGE_MS`. */
  readonly temps: number;
}

/**
 * Step 5 (`files-sweep`): removes bytes no row names (bytes renamed by an upload whose
 * transaction then failed, or a drain that crashed), each re-checked under its key lock, and
 * temporary files untouched for an hour (an upload that crashed mid-way).
 */
export async function sweep(
  db: FileDb,
  blobs: Pick<BlobStore, 'list' | 'listTemps' | 'delete' | 'discard'>,
  now: Date,
  batch = 500,
): Promise<Swept> {
  let orphans = 0;
  let pending: string[] = [];
  const settle = async () => {
    const used = await db.keysInUse(pending);
    for (const key of pending) {
      if (used.has(key)) continue;
      // An upload may have renamed and inserted since: only the check under the lock counts.
      const removed = await db.transaction(async (tx) => {
        await tx.lockKeys([key]);
        if (await tx.keyInUse(key)) return false;
        await blobs.delete(key);
        return true;
      });
      if (removed) orphans++;
    }
    pending = [];
  };
  for await (const key of blobs.list()) {
    pending.push(key);
    if (pending.length >= batch) await settle();
  }
  await settle();

  let temps = 0;
  const staleBefore = now.getTime() - TEMP_FILE_MAX_AGE_MS;
  for await (const temp of blobs.listTemps()) {
    if (temp.modifiedAt.getTime() >= staleBefore) continue;
    await blobs.discard(temp.tempPath);
    temps++;
  }
  return { orphans, temps };
}

const dialect = new PgDialect();

async function run<T extends object>(
  client: Pick<Queryable, 'query'>,
  statement: ReturnType<typeof sql>,
): Promise<T[]> {
  const query = dialect.sqlToQuery(statement);
  const { rows } = await client.query<T>(query.sql, query.params);
  return rows;
}

/** The SQL of `cleanupCandidates` (SPEC-014 §4.6 step 1), exported for its statement test. */
export function cleanupCandidatesQuery(cutoff: Date, after: string | undefined, limit: number) {
  return sql`SELECT f.id, f.purpose, f.issue_id AS "issueId", f.detached_at AS "detachedAt"
               FROM files f
              WHERE (${after ?? null}::uuid IS NULL OR f.id > ${after ?? null}::uuid)
                AND ((f.purpose IN ('attachment', 'inline')
                      AND f.issue_id IS NULL
                      AND f.created_at < ${cutoff})
                  OR (f.purpose = 'attachment' AND f.detached_at < ${cutoff})
                  OR (f.purpose IN ('avatar', 'logo')
                      AND f.created_at < ${cutoff}
                      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_file_id = f.id)
                      AND NOT EXISTS (SELECT 1 FROM workspace w WHERE w.logo_file_id = f.id)))
              ORDER BY f.id
              LIMIT ${limit}
                FOR UPDATE OF f SKIP LOCKED`;
}

/** The reason a candidate row matched `cleanupCandidatesQuery`. */
export function cleanupReason(row: {
  purpose: FilePurpose;
  issueId: string | null;
  detachedAt: Date | string | null;
}): CleanupReason {
  if (row.purpose === 'avatar' || row.purpose === 'logo') return 'unused';
  return row.issueId === null ? 'unclaimed' : 'detached';
}

/** `FileTx` on a connection inside a `READ COMMITTED` transaction. */
export function pgFileTx(client: Queryable): FileTx {
  let savepoints = 0;
  return {
    async lockKeys(keys) {
      // Sorted and distinct: two transactions never wait on each other's keys in a cycle.
      for (const key of [...new Set(keys)].sort()) {
        await client.query('SELECT pg_advisory_xact_lock($1::int, hashtext($2))', [
          LOCK_CLASSES.fileBytes,
          key,
        ]);
      }
    },
    async lockFiles(ids, mode) {
      if (ids.length === 0) return [];
      const lock = mode === 'update' ? sql`FOR UPDATE` : sql`FOR SHARE`;
      return run<FileKeyRow>(
        client,
        sql`SELECT id, storage_key AS "storageKey" FROM files
             WHERE id = ANY(${sql.param([...ids])}::uuid[]) ORDER BY id ${lock}`,
      );
    },
    async lockPreviews(sourceIds) {
      if (sourceIds.length === 0) return [];
      return run<PreviewKeyRow>(
        client,
        sql`SELECT id, storage_key AS "storageKey", preview_of AS "previewOf" FROM files
             WHERE preview_of = ANY(${sql.param([...sourceIds])}::uuid[]) ORDER BY id FOR UPDATE`,
      );
    },
    async insertFile(file) {
      await drizzle({ client, casing: 'snake_case' }).insert(files).values(file);
    },
    async deleteFiles(ids) {
      if (ids.length === 0) return;
      await run(client, sql`DELETE FROM files WHERE id = ANY(${sql.param([...ids])}::uuid[])`);
    },
    async releaseKeys(keys) {
      if (keys.length === 0) return;
      await run(
        client,
        sql`INSERT INTO blob_release (storage_key)
            SELECT unnest(${sql.param([...keys])}::text[]) ON CONFLICT (storage_key) DO NOTHING`,
      );
    },
    async keyInUse(key) {
      const [row] = await run<{ used: boolean }>(
        client,
        sql`SELECT EXISTS (SELECT 1 FROM files WHERE storage_key = ${key}) AS used`,
      );
      return row?.used === true;
    },
    async forgetKey(key) {
      const rows = await run<{ storageKey: string }>(
        client,
        sql`DELETE FROM blob_release WHERE storage_key = ${key} RETURNING storage_key AS "storageKey"`,
      );
      return rows.length > 0;
    },
    async cleanupCandidates(cutoff, after, limit) {
      const rows = await run<{
        id: string;
        purpose: FilePurpose;
        issueId: string | null;
        detachedAt: Date | null;
      }>(client, cleanupCandidatesQuery(cutoff, after, limit));
      return rows.map((row) => ({ id: row.id, reason: cleanupReason(row) }));
    },
    async savepoint(fn) {
      const name = `file_bytes_${++savepoints}`;
      await client.query(`SAVEPOINT ${name}`);
      try {
        const result = await fn();
        await client.query(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        throw error;
      }
    },
  };
}

/** `FileDb` on the app's pool: `READ COMMITTED` transactions, retried on a deadlock. */
export function pgFileDb(pool: Pool): FileDb {
  const withTransaction = transactionRunner(pool);
  return {
    transaction: (fn) => withTransaction((client) => fn(pgFileTx(client))),
    async releasedKeys(limit, after) {
      const rows = await run<{ storageKey: string }>(
        pool,
        sql`SELECT storage_key AS "storageKey" FROM blob_release
             WHERE storage_key > ${after ?? ''} ORDER BY storage_key LIMIT ${limit}`,
      );
      return rows.map((row) => row.storageKey);
    },
    async keysInUse(keys) {
      if (keys.length === 0) return new Set();
      const rows = await run<{ storageKey: string }>(
        pool,
        sql`SELECT DISTINCT storage_key AS "storageKey" FROM files
             WHERE storage_key = ANY(${sql.param([...keys])}::text[])`,
      );
      return new Set(rows.map((row) => row.storageKey));
    },
  };
}
