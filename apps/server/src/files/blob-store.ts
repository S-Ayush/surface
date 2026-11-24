/**
 * Where uploaded bytes live (ADR-0014): the local `uploads` volume, `<DATA_DIR>/uploads`, which the
 * backup scripts already include (docs/ops/backup-manual.md). Keys are content addressed
 * (`sha256/ab/cd/<hash>`), so the same bytes uploaded twice are stored once, and a key never
 * comes from anything the uploader named. An S3-compatible store is v2 (FR-OPS-11).
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';

/** Bytes written to a temporary file by `putStream`, not yet under a key. */
export interface TempBlob {
  /** Where the bytes are, for `commit`, `discard` and reading the image header. */
  readonly tempPath: string;
  /** The SHA-256 of the bytes as written (after any patch), in hex. */
  readonly sha256: string;
  /** The key `commit` stores them under (`blobKey` of the same bytes). */
  readonly key: string;
  readonly size: number;
}

/** Bytes to overwrite once the whole body is written (`strip-location.ts`'s WebP size fix). */
export interface BlobPatch {
  readonly offset: number;
  readonly bytes: Uint8Array;
}

/** A stored file opened for reading: its bytes stream from disk, never whole into memory. */
export interface BlobStream {
  readonly stream: Readable;
  readonly size: number;
}

/** A temporary file left by `putStream`, for the sweep (SPEC-014 §4.5 step 5). */
export interface TempEntry {
  readonly tempPath: string;
  /** Its last write: an upload in progress writes at least every 30 s (`UPLOAD_IDLE_MS`). */
  readonly modifiedAt: Date;
}

export interface BlobStore {
  /**
   * Stores `bytes` and returns their key; storing the same bytes again returns the same key.
   * Test fixtures only: production bytes enter through `putStream` and `insertUpload`
   * (`bytes.ts`), under the key lock (SPEC-014 §4.5).
   */
  put(bytes: Uint8Array): Promise<string>;
  /** The bytes under `key`, or undefined if there are none. */
  get(key: string): Promise<Buffer | undefined>;
  delete(key: string): Promise<void>;
  stat(key: string): Promise<{ readonly size: number } | undefined>;
  /**
   * Where `key`'s bytes are on the local volume, for a reader that opens them itself (sharp reads
   * an attachment image from its path, SPEC-014 §4.4). Undefined for a store that keeps no files
   * (the memory store of tests) and for a string that is no key. Says nothing about whether the
   * bytes are there.
   */
  localPath(key: string): string | undefined;
  /**
   * Writes `source` to a new temporary file (`<uploads>/tmp/<uuid>.tmp`), one chunk at a time,
   * hashing on the way (SPEC-014 §4.5 step 2). `finish`, called once `source` ends, may return a
   * patch; the hash is then of the patched bytes. If `source` throws, the temporary file is
   * removed and the error rethrown.
   */
  putStream(
    source: AsyncIterable<Uint8Array>,
    finish?: () => BlobPatch | undefined,
  ): Promise<TempBlob>;
  /**
   * Moves a temporary file under `key`. Always a rename, even when the key exists: the bytes are
   * the same, and skipping it would time-leak that someone uploaded them before. Repeating a
   * commit whose rename already happened (a retried transaction) succeeds.
   */
  commit(tempPath: string, key: string): Promise<void>;
  /** Removes a temporary file that won't be committed; nothing if it is gone already. */
  discard(tempPath: string): Promise<void>;
  /** The bytes under `key` as a stream, or undefined if there are none. */
  getStream(key: string): Promise<BlobStream | undefined>;
  /** Every key with bytes, for the sweep. Deleting keys while iterating is allowed. */
  list(): AsyncIterable<string>;
  /** The temporary files `putStream` left, for the sweep. */
  listTemps(): AsyncIterable<TempEntry>;
}

const KEY_PATTERN = /^sha256\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{64})$/;

export function blobKey(bytes: Uint8Array): string {
  return keyOfHash(createHash('sha256').update(bytes).digest('hex'));
}

/** Whether `key` is one `blobKey` makes: nothing else reaches the file system. */
export function isBlobKey(key: string): boolean {
  const match = KEY_PATTERN.exec(key);
  return match !== null && match[3]?.slice(0, 2) === match[1] && match[3]?.slice(2, 4) === match[2];
}

function checkedKey(key: string): string {
  if (!isBlobKey(key)) throw new Error('Not a blob key.');
  return key;
}

const TEMP_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;

export function keyOfHash(sha256: string): string {
  return `sha256/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

async function writeAll(handle: FileHandle, bytes: Uint8Array, position?: number): Promise<void> {
  let done = 0;
  while (done < bytes.length) {
    const at = position === undefined ? null : position + done;
    const { bytesWritten } = await handle.write(bytes, done, bytes.length - done, at);
    done += bytesWritten;
  }
}

const isMissing = (error: unknown) =>
  typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT';

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/** The local volume. `root` is `<DATA_DIR>/uploads`, created on the first write. */
export function localBlobStore(root: string): BlobStore {
  const fileOf = (key: string) => path.join(root, ...checkedKey(key).split('/'));
  const tempDir = path.join(root, 'tmp');
  // Only paths `putStream` makes reach `commit` and `discard`.
  const checkedTemp = (tempPath: string) => {
    if (path.dirname(tempPath) !== tempDir || !TEMP_NAME.test(path.basename(tempPath))) {
      throw new Error('Not a temporary upload.');
    }
    return tempPath;
  };
  return {
    async put(bytes) {
      const key = blobKey(bytes);
      const file = fileOf(key);
      if ((await this.stat(key)) !== undefined) return key;
      await mkdir(path.dirname(file), { recursive: true });
      // A temporary name in the same directory, then a rename: a crash never leaves half a
      // file under a real key, and two uploads of the same bytes both end with the whole file.
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, bytes, { flag: 'wx' });
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true });
      }
      return key;
    },
    // A string that is no key names no file (the guard `fileOf` would throw on).
    localPath: (key) => (isBlobKey(key) ? fileOf(key) : undefined),
    async get(key) {
      try {
        return await readFile(fileOf(key));
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    },
    async delete(key) {
      await rm(fileOf(key), { force: true });
    },
    async stat(key) {
      try {
        const found = await stat(fileOf(key));
        return { size: found.size };
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    },
    async putStream(source, finish) {
      await mkdir(tempDir, { recursive: true });
      const tempPath = path.join(tempDir, `${randomUUID()}.tmp`);
      // Read and write: a patched file is read back to hash it.
      const handle = await open(tempPath, 'wx+');
      try {
        const hash = createHash('sha256');
        let size = 0;
        // One chunk at a time: the next is read only once this one is on disk.
        for await (const chunk of source) {
          hash.update(chunk);
          size += chunk.length;
          await writeAll(handle, chunk);
        }
        const patch = finish?.();
        let sha256: string;
        if (patch === undefined) {
          sha256 = hash.digest('hex');
        } else {
          if (patch.offset < 0 || patch.offset + patch.bytes.length > size) {
            throw new Error('A patch outside the written bytes.');
          }
          await writeAll(handle, patch.bytes, patch.offset);
          // Rare (a WebP that lost its EXIF or XMP chunk): read the file back to hash it.
          const again = createHash('sha256');
          for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) {
            again.update(chunk as Buffer);
          }
          sha256 = again.digest('hex');
        }
        await handle.close();
        return { tempPath, sha256, key: keyOfHash(sha256), size };
      } catch (error) {
        await handle.close().catch(() => undefined);
        await rm(tempPath, { force: true });
        throw error;
      }
    },
    async commit(tempPath, key) {
      const file = fileOf(key);
      await mkdir(path.dirname(file), { recursive: true });
      try {
        await rename(checkedTemp(tempPath), file);
      } catch (error) {
        // `commit` runs inside the insert's transaction, which runs again after a serialization
        // failure: the first run's rename already moved the file (review m2).
        if (isMissing(error) && (await exists(file))) return;
        throw error;
      }
    },
    async discard(tempPath) {
      await rm(checkedTemp(tempPath), { force: true });
    },
    async getStream(key) {
      let handle: FileHandle;
      try {
        handle = await open(fileOf(key), 'r');
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
      try {
        const { size } = await handle.stat();
        // The stream closes the handle when it ends or is destroyed.
        return { stream: handle.createReadStream(), size };
      } catch (error) {
        await handle.close();
        throw error;
      }
    },
    async *list() {
      // One directory level at a time, each read whole before anything under it is deleted.
      for (const a of await entries(path.join(root, 'sha256'))) {
        for (const b of await entries(path.join(root, 'sha256', a))) {
          for (const name of await entries(path.join(root, 'sha256', a, b))) {
            const key = `sha256/${a}/${b}/${name}`;
            // Anything else (a crashed `put`'s `.tmp`) is never a key, so never ours to judge.
            if (isBlobKey(key)) yield key;
          }
        }
      }
    },
    async *listTemps() {
      for (const name of await entries(tempDir)) {
        if (!TEMP_NAME.test(name)) continue;
        const tempPath = path.join(tempDir, name);
        try {
          yield { tempPath, modifiedAt: (await stat(tempPath)).mtime };
        } catch (error) {
          // Committed or discarded since the listing.
          if (!isMissing(error)) throw error;
        }
      }
    },
  };
}

/** A directory's names, or none if it doesn't exist (yet). */
async function entries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

/** For tests: the same contract in memory. `now` stamps temporary files (the sweep's age). */
export function memoryBlobStore(options: { now?: () => Date } = {}): BlobStore & {
  readonly keys: () => string[];
  readonly temps: () => string[];
} {
  const now = options.now ?? (() => new Date());
  const blobs = new Map<string, Buffer>();
  const temps = new Map<string, Buffer>();
  const written = new Map<string, Date>();
  return {
    put(bytes) {
      const key = blobKey(bytes);
      blobs.set(key, Buffer.from(bytes));
      return Promise.resolve(key);
    },
    get(key) {
      return Promise.resolve(blobs.get(checkedKey(key)));
    },
    delete(key) {
      blobs.delete(checkedKey(key));
      return Promise.resolve();
    },
    stat(key) {
      const found = blobs.get(checkedKey(key));
      return Promise.resolve(found && { size: found.length });
    },
    localPath: () => undefined,
    async putStream(source, finish) {
      const tempPath = `memory/tmp/${randomUUID()}.tmp`;
      const parts: Buffer[] = [];
      for await (const chunk of source) parts.push(Buffer.from(chunk));
      const bytes = Buffer.concat(parts);
      const patch = finish?.();
      if (patch !== undefined) bytes.set(patch.bytes, patch.offset);
      temps.set(tempPath, bytes);
      written.set(tempPath, now());
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      return { tempPath, sha256, key: keyOfHash(sha256), size: bytes.length };
    },
    commit(tempPath, key) {
      const bytes = temps.get(tempPath);
      // A retried transaction repeats a commit that already happened.
      if (bytes === undefined && blobs.has(checkedKey(key))) return Promise.resolve();
      if (bytes === undefined) return Promise.reject(new Error('No such temporary upload.'));
      temps.delete(tempPath);
      written.delete(tempPath);
      blobs.set(checkedKey(key), bytes);
      return Promise.resolve();
    },
    discard(tempPath) {
      temps.delete(tempPath);
      written.delete(tempPath);
      return Promise.resolve();
    },
    getStream(key) {
      const found = blobs.get(checkedKey(key));
      return Promise.resolve(found && { stream: Readable.from([found]), size: found.length });
    },
    async *list() {
      // A copy: deleting while iterating is allowed.
      for (const key of [...blobs.keys()]) yield await Promise.resolve(key);
    },
    async *listTemps() {
      for (const [tempPath, modifiedAt] of [...written]) {
        yield await Promise.resolve({ tempPath, modifiedAt });
      }
    },
    keys: () => [...blobs.keys()],
    temps: () => [...temps.keys()],
  };
}
