/**
 * Limits that protect the uploads volume (SPEC-014 §4.6, SPEC-004 E6). It is shared with backups
 * and, on a single-disk host, with Postgres. Fixed constants in M1 (D23): if they ever become
 * settings, they come from `loadConfig()` (CLAUDE.md rule 7).
 */
import { statfs } from 'node:fs/promises';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/**
 * An attachment or inline upload is refused if it would leave less free space than this on the
 * uploads volume: the same 1 GB at which `surface doctor` warns (`DISK_WARN_BYTES`).
 */
export const FREE_SPACE_FLOOR_BYTES = 1 * GiB;

/** Unclaimed `attachment` and `inline` uploads one user may have at once. */
export const MAX_UNCLAIMED_BYTES = 1 * GiB;
export const MAX_UNCLAIMED_FILES = 100;

/** Uploads per user per minute: attachments and inline files (D18), avatars and logos (M0). */
export const FILE_UPLOADS_PER_MINUTE = 30;
export const IMAGE_UPLOADS_PER_MINUTE = 10;

/**
 * A streamed upload that sends nothing for this long is closed (review M1): the server sets no
 * request timeout (a 25 MB file on a slow link may take minutes), so without it a client could
 * hold a connection, a temporary file and a place below forever.
 */
export const UPLOAD_IDLE_MS = 30_000;
/**
 * Attachment and inline uploads one user may stream at once (review M1). A drop of many files
 * is queued by the client; this caps open connections and temporary files per user.
 */
export const MAX_CONCURRENT_UPLOADS = 3;

/** Free bytes on the uploads volume; tests pass a fake. */
export type DiskSpace = () => Promise<number>;

/** Free bytes for an unprivileged user (what Surface runs as) on the volume holding `dir`. */
export function diskSpace(dir: string): DiskSpace {
  return async () => {
    const facts = await statfs(dir);
    return facts.bavail * facts.bsize;
  };
}

/** Whether writing `incoming` more bytes would take the volume below the floor. */
export function belowFloor(freeBytes: number, incoming: number): boolean {
  return freeBytes - incoming < FREE_SPACE_FLOOR_BYTES;
}

export interface UnclaimedUsage {
  readonly files: number;
  readonly bytes: number;
}

/** Whether one more upload of `incoming` bytes goes over a per-user cap. */
export function overCaps(usage: UnclaimedUsage, incoming: number): boolean {
  return usage.files + 1 > MAX_UNCLAIMED_FILES || usage.bytes + incoming > MAX_UNCLAIMED_BYTES;
}
