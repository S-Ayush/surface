/**
 * Where uploaded bytes live (ADR-0014): the local `uploads` volume, `<DATA_DIR>/uploads`, which the
 * backup scripts already include (docs/ops/backup-manual.md). Keys are content addressed
 * (`sha256/ab/cd/<hash>`), so the same bytes uploaded twice are stored once, and a key never
 * comes from anything the uploader named. An S3-compatible store is v2 (FR-OPS-11).
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
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

export interface BlobStore {
  /** Stores `bytes` and returns their key; storing the same bytes again returns the same key. */
  put(bytes: Uint8Array): Promise<string>;
  /** The bytes under `key`, or undefined if there are none. */
  get(key: string): Promise<Buffer | undefined>;
  delete(key: string): Promise<void>;
  stat(key: string): Promise<{ readonly size: number } | undefined>;
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
  };
}

/** For tests: the same contract in memory. */
export function memoryBlobStore(): BlobStore & {
  readonly keys: () => string[];
  readonly temps: () => string[];
} {
  const blobs = new Map<string, Buffer>();
  const temps = new Map<string, Buffer>();
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
    async putStream(source, finish) {
      const tempPath = `memory/tmp/${randomUUID()}.tmp`;
      const parts: Buffer[] = [];
      for await (const chunk of source) parts.push(Buffer.from(chunk));
      const bytes = Buffer.concat(parts);
      const patch = finish?.();
      if (patch !== undefined) bytes.set(patch.bytes, patch.offset);
      temps.set(tempPath, bytes);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      return { tempPath, sha256, key: keyOfHash(sha256), size: bytes.length };
    },
    commit(tempPath, key) {
      const bytes = temps.get(tempPath);
      // A retried transaction repeats a commit that already happened.
      if (bytes === undefined && blobs.has(checkedKey(key))) return Promise.resolve();
      if (bytes === undefined) return Promise.reject(new Error('No such temporary upload.'));
      temps.delete(tempPath);
      blobs.set(checkedKey(key), bytes);
      return Promise.resolve();
    },
    discard(tempPath) {
      temps.delete(tempPath);
      return Promise.resolve();
    },
    getStream(key) {
      const found = blobs.get(checkedKey(key));
      return Promise.resolve(found && { stream: Readable.from([found]), size: found.length });
    },
    keys: () => [...blobs.keys()],
    temps: () => [...temps.keys()],
  };
}
