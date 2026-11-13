/**
 * The byte protocol (SPEC-014 §4.5, ADR-0021; PLAN-014 S3): the only module that inserts or
 * deletes `files` rows, and the only one that unlinks stored bytes.
 *
 * Several rows can share one storage key (content addressing), so every writer follows one rule:
 * - every insert or delete of a row takes the key's lock, `pg_advisory_xact_lock(fileBytes,
 *   hashtext(key))`, in its transaction; all of a transaction's keys in one statement, in
 *   `hashtext` order, after every issue and file row lock it takes (row locks first, then key
 *   locks, everywhere: a transaction that went row, key, row, key could deadlock with one that
 *   holds the second row and waits for the first key);
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
import type { PoolClient } from 'pg';
import type { Pool, Queryable } from '../db/pool.js';
import { files, type FilePurpose } from '../db/schema/index.js';
import { loggableError } from '../executor/log-error.js';
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

/** Log lines the protocol writes: ids and counts, never a key, a path or a name. */
export interface FileLog {
  warn(object: object, message: string): void;
  error(object: object, message: string): void;
}

/** What the protocol needs of one `READ COMMITTED` transaction. */
export interface FileTx {
  /**
   * Each key's transaction lock, all at once, in one fixed order (SPEC-014 §4.5 step 1). Call it
   * once per transaction, after every row lock.
   */
  lockKeys(keys: readonly string[]): Promise<void>;
  /** The rows that exist among `ids`, locked in id order (`FOR UPDATE` or `FOR SHARE`). */
  lockFiles(ids: readonly string[], mode: 'update' | 'share'): Promise<FileKeyRow[]>;
  /**
   * §4.3's claim: `id` becomes `issueId`'s if it is an unclaimed `inline` upload of
   * `uploaderId`. One conditional `UPDATE`; false when it matched no row (gone, claimed meanwhile,
   * someone else's, another purpose).
   */
  claimInline(id: string, issueId: string, uploaderId: string): Promise<boolean>;
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

/** A document's unclaimed `inline` upload, to be claimed by the document's issue (§4.3). */
export interface InlineClaim {
  readonly id: string;
  readonly issueId: string;
  /** The saving actor: only their own upload is claimed. */
  readonly uploaderId: string;
}

/** A new row for a visible file's bytes (§4.3's copy): the key comes from the locked source. */
export interface InlineCopy {
  readonly sourceId: string;
  readonly file: Omit<NewFile, 'storageKey'>;
}

/**
 * Step 3 for a saved document (§4.3): every claim and every copy in one go, in the lock order of
 * step 1. First the row locks, in id order: each claim's conditional `UPDATE` and each copy
 * source `FOR SHARE` (so no source can be deleted meanwhile). Then one `lockKeys` over every
 * copy's key. Then, per copy, the bytes checked and the row inserted. A claim or copy taken one
 * file at a time would go row, key, row, key, and deadlock with a clean-up holding an unclaimed
 * row that shares a key.
 *
 * Returns the ids that can't be used: a claim that matched no row (E24) or a source that is gone.
 * Then nothing was inserted, and the caller refuses the document and rolls back (the claims made
 * so far included). Missing bytes mean a broken invariant: logged as `file bytes missing` and
 * thrown, so the operation answers `INTERNAL`.
 */
export async function insertCopies(
  tx: FileTx,
  blobs: Pick<BlobStore, 'stat'>,
  saved: { readonly claims: readonly InlineClaim[]; readonly copies: readonly InlineCopy[] },
  log: Pick<FileLog, 'error'>,
): Promise<{ readonly unusable: readonly string[] }> {
  const claims = new Map(saved.claims.map((claim) => [claim.id, claim]));
  const sources = new Set(saved.copies.map((copy) => copy.sourceId));
  for (const id of claims.keys()) {
    if (sources.has(id)) throw new Error('A file is either claimed or copied, not both.');
  }
  const keyOf = new Map<string, string>();
  const unusable: string[] = [];
  for (const id of [...claims.keys(), ...sources].sort()) {
    const claim = claims.get(id);
    if (claim !== undefined) {
      if (!(await tx.claimInline(claim.id, claim.issueId, claim.uploaderId))) unusable.push(id);
      continue;
    }
    const [source] = await tx.lockFiles([id], 'share');
    if (source === undefined) unusable.push(id);
    else keyOf.set(id, source.storageKey);
  }
  if (unusable.length > 0) return { unusable };
  await tx.lockKeys([...keyOf.values()]);
  for (const copy of saved.copies) {
    const storageKey = keyOf.get(copy.sourceId);
    if (storageKey === undefined || (await blobs.stat(storageKey)) === undefined) {
      log.error({ fileId: copy.file.id }, 'file bytes missing');
      throw new FileBytesMissing(copy.file.id);
    }
    await tx.insertFile({ ...copy.file, storageKey });
  }
  return { unusable: [] };
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
  /** Keys whose bytes couldn't be removed: left in `blob_release` for the next run. */
  readonly failed: number;
}

/**
 * A blob store removal that failed (EACCES, EIO, EBUSY): the one error the drain and the sweep
 * count and go past. Anything else (the database gone, say) fails the run.
 */
class RemoveFailed extends Error {
  constructor(readonly error: unknown) {
    super('File bytes could not be removed.');
    this.name = 'RemoveFailed';
  }
}

async function removing(remove: () => Promise<void>): Promise<void> {
  try {
    await remove();
  } catch (error) {
    throw new RemoveFailed(error);
  }
}

/**
 * An error as the file code logs it. A file system error (one with a `syscall`) keeps its code and
 * call only: its message and `path` hold the key or the temporary path. Anything else goes
 * through `loggableError`.
 */
export function loggableFileError(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return loggableError(error);
  const syscall: unknown = Reflect.get(error, 'syscall');
  if (typeof syscall !== 'string') return loggableError(error);
  const code: unknown = Reflect.get(error, 'code');
  return { type: error.constructor.name, ...(typeof code === 'string' ? { code } : {}), syscall };
}

/**
 * Step 4's second half (`files-cleanup`): per key in `blob_release`, in its own transaction,
 * takes the key lock, forgets the key, and unlinks the bytes if no row names it. A crash
 * leaves the key in `blob_release` (drained next run) or bytes without a row (the sweep's).
 */
export async function drainBlobRelease(
  db: FileDb,
  blobs: Pick<BlobStore, 'delete'>,
  log: Pick<FileLog, 'warn'>,
  batch = 100,
): Promise<Drained> {
  let unlinked = 0;
  let kept = 0;
  let failed = 0;
  let after: string | undefined;
  for (;;) {
    const keys = await db.releasedKeys(batch, after);
    for (const key of keys) {
      try {
        const outcome = await db.transaction(async (tx) => {
          await tx.lockKeys([key]);
          // A drain running at the same time got here first.
          if (!(await tx.forgetKey(key))) return 'gone';
          if (await tx.keyInUse(key)) return 'kept';
          await removing(() => blobs.delete(key));
          return 'unlinked';
        });
        if (outcome === 'unlinked') unlinked++;
        else if (outcome === 'kept') kept++;
      } catch (error) {
        // One key that can't be removed must not stop the others every run. Its transaction
        // rolled back: the key stays in `blob_release` for the next run.
        if (!(error instanceof RemoveFailed)) throw error;
        failed++;
        log.warn({ err: loggableFileError(error.error) }, 'file bytes could not be removed');
      }
    }
    after = keys.at(-1);
    if (keys.length < batch) return { unlinked, kept, failed };
  }
}

export interface Swept {
  /** Keys on disk that no row named. */
  readonly orphans: number;
  /** Temporary files older than `TEMP_FILE_MAX_AGE_MS`. */
  readonly temps: number;
  /** Keys or temporary files that couldn't be removed: tried again next run. */
  readonly failed: number;
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
  log: Pick<FileLog, 'warn'>,
  batch = 500,
): Promise<Swept> {
  let orphans = 0;
  let failed = 0;
  // As in the drain: one file that can't be removed doesn't stop the others.
  const failure = (error: unknown) => {
    if (!(error instanceof RemoveFailed)) throw error;
    failed++;
    log.warn({ err: loggableFileError(error.error) }, 'file bytes could not be removed');
  };
  let pending: string[] = [];
  const settle = async () => {
    const used = await db.keysInUse(pending);
    for (const key of pending) {
      if (used.has(key)) continue;
      // An upload may have renamed and inserted since: only the check under the lock counts.
      try {
        const removed = await db.transaction(async (tx) => {
          await tx.lockKeys([key]);
          if (await tx.keyInUse(key)) return false;
          await removing(() => blobs.delete(key));
          return true;
        });
        if (removed) orphans++;
      } catch (error) {
        failure(error);
      }
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
    try {
      await removing(() => blobs.discard(temp.tempPath));
      temps++;
    } catch (error) {
      failure(error);
    }
  }
  return { orphans, temps, failed };
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
  return sql`SELECT f.id, f.purpose, f.issue_id AS "issueId"
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
}): CleanupReason {
  if (row.purpose === 'avatar' || row.purpose === 'logo') return 'unused';
  return row.issueId === null ? 'unclaimed' : 'detached';
}

/**
 * Every key's lock in one statement, in `hashtext` order: the sorted subquery feeds the locks one
 * row at a time. Ordering by the hash, not the key, means two keys whose hashes collide are one
 * lock taken once, never two locks taken in opposite orders.
 */
export const LOCK_KEYS_SQL = `SELECT pg_advisory_xact_lock($1::int, h)
  FROM (SELECT DISTINCT hashtext(k) AS h FROM unnest($2::text[]) AS k ORDER BY h) AS keys`;

/**
 * `FileTx` on a connection inside a `READ COMMITTED` transaction: a checked-out client, never the
 * pool, since `pg_advisory_xact_lock` outside `BEGIN` is released at once and protects nothing.
 */
export function pgFileTx(client: PoolClient): FileTx {
  let savepoints = 0;
  return {
    async lockKeys(keys) {
      if (keys.length === 0) return;
      await client.query(LOCK_KEYS_SQL, [LOCK_CLASSES.fileBytes, [...new Set(keys)]]);
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
    async claimInline(id, issueId, uploaderId) {
      // SPEC-014 §4.3: the check and the claim are one statement.
      const rows = await run<{ id: string }>(
        client,
        sql`UPDATE files SET issue_id = ${issueId}
             WHERE id = ${id} AND issue_id IS NULL AND uploader_id = ${uploaderId}
               AND purpose = 'inline'
            RETURNING id`,
      );
      return rows.length > 0;
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
      const rows = await run<{ id: string; purpose: FilePurpose; issueId: string | null }>(
        client,
        cleanupCandidatesQuery(cutoff, after, limit),
      );
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
