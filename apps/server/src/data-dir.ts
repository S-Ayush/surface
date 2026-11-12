/**
 * The data volume (SPEC-004 E5): `DATA_DIR` and the uploads folder under it, where uploaded files
 * are stored (ADR-0014). The compose files mount `uploads` as its own volume, so checking
 * `DATA_DIR` alone would miss a bind mount Surface can't write to.
 *
 * Startup stops on a problem (`checkDataDir`); `surface doctor` reports the same facts with the
 * same messages, read-only.
 */
import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { mkdir, open, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { StartupError } from './startup-error.js';

/** The image runs as this user (SPEC-004 §5). */
export const IMAGE_UID = 10001;

export type DataDirFacts =
  | { path: string; state: 'writable' }
  | { path: string; state: 'missing' | 'not-directory' }
  | { path: string; state: 'not-writable'; reason: string; uid: number | undefined };

/** Where uploaded files are stored (`files/blob-store.ts`). */
export function uploadsDir(dataDir: string): string {
  return path.join(dataDir, 'uploads');
}

function errorText(error: unknown): string {
  const e = error as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : undefined;
  const message = typeof e?.message === 'string' ? e.message : '';
  if (!message) return code ?? String(error);
  return code && !message.includes(code) ? `${code}: ${message}` : message;
}

const notWritable = (dir: string, error: unknown, probe?: string): DataDirFacts => ({
  path: dir,
  state: 'not-writable',
  reason: probe === undefined ? errorText(error) : errorText(error).replace(probe, dir),
  uid: process.getuid?.(),
});

/** Whether `dir` is a directory Surface can write to. Leaves nothing behind. */
export async function dataDirFacts(dir: string): Promise<DataDirFacts> {
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) return { path: dir, state: 'not-directory' };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT') return { path: dir, state: 'missing' };
    // A parent is a file: /etc/hosts/data.
    if (code === 'ENOTDIR') return { path: dir, state: 'not-directory' };
    // EACCES (a parent can't be searched), and anything else (ELOOP, EIO, a network mount's
    // EPERM): the operator still gets a message naming the directory and the error.
    return notWritable(dir, error);
  }

  // Write a real file: permission bits alone miss read-only mounts and ACLs.
  const probe = path.join(dir, `.surface-write-check-${randomBytes(6).toString('hex')}`);
  let created = false;
  try {
    const handle = await open(
      probe,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    );
    created = true;
    await handle.close();
    return { path: dir, state: 'writable' };
  } catch (error) {
    return notWritable(dir, error, probe);
  } finally {
    // Nothing is left behind, even if closing the file failed.
    if (created) await unlink(probe).catch(() => undefined);
  }
}

/** What the operator must fix, or undefined when `facts` is writable. */
export function dataDirProblem(facts: DataDirFacts): string | undefined {
  switch (facts.state) {
    case 'writable':
      return undefined;
    case 'missing':
      return `${facts.path} does not exist. Mount a volume there, or point DATA_DIR at an existing directory.`;
    case 'not-directory':
      return `${facts.path} is not a directory. Mount a volume there, or point DATA_DIR at a directory.`;
    case 'not-writable': {
      const who =
        facts.uid === undefined || facts.uid === IMAGE_UID
          ? `uid ${IMAGE_UID}, the user in the Surface image`
          : `uid ${facts.uid}, the user running Surface here; the image uses ${IMAGE_UID}`;
      return `Surface cannot write to ${facts.path} (${facts.reason}). Make the volume writable by ${who}, e.g. chown -R ${IMAGE_UID}:${IMAGE_UID} on the host directory.`;
    }
  }
}

/**
 * Startup's check (SPEC-004 E5, §8 step 1): `DATA_DIR`, then its uploads folder, created first when
 * missing (an install without compose has no uploads volume). Throws a `StartupError` naming the
 * directory and the fix.
 */
export async function checkDataDir(dataDir: string): Promise<void> {
  const problem = dataDirProblem(await dataDirFacts(dataDir));
  if (problem !== undefined) throw new StartupError(problem);
  const uploads = uploadsDir(dataDir);
  // A failure here shows up in the probe below, with its reason.
  await mkdir(uploads, { recursive: true }).catch(() => undefined);
  const uploadsProblem = dataDirProblem(await dataDirFacts(uploads));
  if (uploadsProblem !== undefined) throw new StartupError(uploadsProblem);
}
