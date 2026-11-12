/**
 * Where uploaded bytes live (ADR-0014): the local `uploads` volume, `<DATA_DIR>/uploads`, which the
 * backup scripts already include (docs/ops/backup-manual.md). Keys are content addressed
 * (`sha256/ab/cd/<hash>`), so the same bytes uploaded twice are stored once, and a key never
 * comes from anything the uploader named. An S3-compatible store is v2 (FR-OPS-11).
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface BlobStore {
  /** Stores `bytes` and returns their key; storing the same bytes again returns the same key. */
  put(bytes: Uint8Array): Promise<string>;
  /** The bytes under `key`, or undefined if there are none. */
  get(key: string): Promise<Buffer | undefined>;
  delete(key: string): Promise<void>;
  stat(key: string): Promise<{ readonly size: number } | undefined>;
}

const KEY_PATTERN = /^sha256\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{64})$/;

export function blobKey(bytes: Uint8Array): string {
  const hash = createHash('sha256').update(bytes).digest('hex');
  return `sha256/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`;
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

const isMissing = (error: unknown) =>
  typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT';

/** The local volume. `root` is `<DATA_DIR>/uploads`, created on the first write. */
export function localBlobStore(root: string): BlobStore {
  const fileOf = (key: string) => path.join(root, ...checkedKey(key).split('/'));
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
  };
}

/** For tests: the same contract in memory. */
export function memoryBlobStore(): BlobStore & { readonly keys: () => string[] } {
  const blobs = new Map<string, Buffer>();
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
    keys: () => [...blobs.keys()],
  };
}
