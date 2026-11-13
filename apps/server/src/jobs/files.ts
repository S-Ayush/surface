/**
 * The file jobs (SPEC-014 §4.5, §4.6; ADR-0024): `files-cleanup` (hourly) deletes rows nobody
 * needs and drains `blob_release`; `files-sweep` (daily) removes bytes with no row and stale
 * temporary files. Both touch only server-only tables and the uploads volume, so they write
 * directly, through the byte protocol (`files/bytes.ts`), not through operations (ADR-0024).
 * Both are idempotent, and two runs at once are safe: rows are taken `SKIP LOCKED`, keys under
 * their lock.
 *
 * With `SURFACE_ROLE=worker`, the worker must mount the same uploads volume as the web process
 * (docs/ops/troubleshooting.md).
 */
import { postgresCode } from '../executor/transaction.js';
import type { BlobStore } from '../files/blob-store.js';
import {
  deleteLocked,
  drainBlobRelease,
  lockForDelete,
  sweep,
  type CleanupReason,
  type FileDb,
  type Swept,
} from '../files/bytes.js';
import { FILE_CLEANUP_AFTER_MS } from '../files/limits.js';

/** 23503 foreign_key_violation: a user or the workspace named the avatar or logo meanwhile. */
const FOREIGN_KEY_VIOLATION = '23503';

export interface CleanupCounts {
  /** Unclaimed `attachment` and `inline` uploads. */
  readonly unclaimed: number;
  /** Detached attachments. */
  readonly detached: number;
  /** Avatars and logos no user or workspace names. */
  readonly unused: number;
  /** Previews deleted with their source. */
  readonly previews: number;
  /** Rows whose delete failed a foreign key: kept, tried again next run (E22). */
  readonly skipped: number;
  /** `blob_release` keys whose bytes were unlinked, and those a row still names. */
  readonly unlinked: number;
  readonly kept: number;
}

export interface FileJobDeps {
  readonly db: FileDb;
  readonly blobs: BlobStore;
  readonly now?: () => Date;
  /** Rows per transaction. */
  readonly batch?: number;
}

/**
 * SPEC-014 §4.6: deletes, 24 hours on, unclaimed uploads, detached attachments and avatars and
 * logos nobody names; each with its previews first (§4.5 step 4), each in a savepoint so one
 * refused by a foreign key (E22) doesn't undo the others. Then drains `blob_release`.
 */
export async function cleanupFiles({
  db,
  blobs,
  now = () => new Date(),
  batch = 100,
}: FileJobDeps): Promise<CleanupCounts> {
  const cutoff = new Date(now().getTime() - FILE_CLEANUP_AFTER_MS);
  const deleted: Record<CleanupReason, number> = { unclaimed: 0, detached: 0, unused: 0 };
  let previews = 0;
  let skipped = 0;
  let after: string | undefined;
  for (;;) {
    // Counted only once the transaction commits: a retried one starts again from zero.
    const round = await db.transaction(async (tx) => {
      const candidates = await tx.cleanupCandidates(cutoff, after, batch);
      const counts = { unclaimed: 0, detached: 0, unused: 0, previews: 0, skipped: 0 };
      // Every key of the batch locked at once, in order (§4.5 step 1); then one savepoint per row.
      const locked = await lockForDelete(
        tx,
        candidates.map((candidate) => candidate.id),
      );
      for (const candidate of candidates) {
        const source = locked.sources.find((row) => row.id === candidate.id);
        if (source === undefined) continue;
        try {
          const result = await tx.savepoint(() => deleteLocked(tx, locked, [source]));
          counts[candidate.reason] += result.files;
          counts.previews += result.previews;
        } catch (error) {
          if (postgresCode(error) !== FOREIGN_KEY_VIOLATION) throw error;
          counts.skipped++;
        }
      }
      return { last: candidates.at(-1)?.id, size: candidates.length, counts };
    });
    for (const reason of ['unclaimed', 'detached', 'unused'] as const) {
      deleted[reason] += round.counts[reason];
    }
    previews += round.counts.previews;
    skipped += round.counts.skipped;
    if (round.size < batch || round.last === undefined) break;
    after = round.last;
  }
  const drained = await drainBlobRelease(db, blobs);
  return { ...deleted, previews, skipped, ...drained };
}

/** SPEC-014 §4.5 step 5. */
export function sweepFiles({ db, blobs, now = () => new Date() }: FileJobDeps): Promise<Swept> {
  return sweep(db, blobs, now());
}

/** The two jobs' handlers, logging their counts (SPEC-014 §10: `files cleanup`). */
export function fileJobs(deps: FileJobDeps, log: { info(object: object, message: string): void }) {
  // Properties, not methods: `registerJobs` hands them to pg-boss on their own.
  return {
    cleanup: async (queue: string) => {
      const counts = await cleanupFiles(deps);
      log.info({ queue, ...counts }, 'files cleanup');
    },
    sweep: async (queue: string) => {
      const counts = await sweepFiles(deps);
      log.info({ queue, ...counts }, 'files sweep');
    },
  };
}
