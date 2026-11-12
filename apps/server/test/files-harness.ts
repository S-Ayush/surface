// The file routes against fakes, for PLAN-014 S2's unit tests (`files-upload`, `files-download`,
// `files-strip-location`): an in-memory files store, the real local BlobStore in a temporary
// folder (sharp reads image headers from its paths), a fake disk probe and a captured log.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { userActor } from '@surface/domain';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type LightMyRequestResponse,
} from 'fastify';
import type { ResolvedSession } from '../src/auth/sessions.js';
import { localBlobStore, type BlobStore } from '../src/files/blob-store.js';
import type { LoadSharp } from '../src/files/image.js';
import { overCaps } from '../src/files/limits.js';
import { registerFileRoutes } from '../src/files/routes.js';
import type { FileReader, FileStore, NewFile } from '../src/files/store.js';
import { registerSecurityHeaders } from '../src/http/security-headers.js';
import { createLogger } from '../src/logger.js';
import { captureLogs, testConfig } from './helpers.js';

export const ADA = '01930000-0000-7000-8000-00000000ada1';
export const BEN = '01930000-0000-7000-8000-00000000be01';

export function session(userId: string, role: 'admin' | 'member' = 'member'): ResolvedSession {
  return {
    id: `session-of-${userId}`,
    userId,
    workspaceId: 'w',
    actor: userActor({ userId, role, memberships: [] }),
  };
}

/** A fake transaction: what it holds is released when `withTransaction` ends it. */
export class FakeClient {
  readonly releases: (() => void)[] = [];
  end(): void {
    for (const release of this.releases.splice(0)) release();
  }
}

/** Rows in memory: a file is readable by its uploader only (the unclaimed rule). */
export class FakeFiles implements FileStore {
  rows: NewFile[] = [];
  /** Per uploader: the transaction lock's tail, like `pg_advisory_xact_lock`. */
  private readonly locks = new Map<string, Promise<void>>();
  async reserveUpload(client: unknown, userId: string, incoming: number) {
    if (!(client instanceof FakeClient)) throw new Error('Not a fake transaction.');
    const previous = this.locks.get(userId) ?? Promise.resolve();
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    this.locks.set(
      userId,
      previous.then(() => held),
    );
    await previous;
    client.releases.push(release);
    return !overCaps(await this.unclaimedUsage(client, userId), incoming);
  }
  insert(_client: unknown, file: NewFile) {
    this.rows.push(file);
    return Promise.resolve();
  }
  visibleFile(_client: unknown, fileId: string, reader: FileReader) {
    const row = this.rows.find((file) => file.id === fileId && file.uploaderId === reader.userId);
    return Promise.resolve(row);
  }
  unclaimedUsage(_client: unknown, userId: string) {
    const mine = this.rows.filter(
      (file) =>
        file.uploaderId === userId &&
        (file.issueId ?? null) === null &&
        (file.purpose === 'attachment' || file.purpose === 'inline'),
    );
    return Promise.resolve({
      files: mine.length,
      bytes: mine.reduce((sum, file) => sum + file.size, 0),
    });
  }
}

const GiB = 1024 ** 3;

export interface HarnessOptions {
  readonly who?: ResolvedSession | undefined;
  readonly uploadMaxMb?: number;
  /** Free bytes on the uploads volume, per call (the probe runs before reading and again before the rename). */
  readonly free?: () => number;
  readonly blobs?: (root: string) => BlobStore;
  readonly loadSharp?: LoadSharp;
}

export interface Harness {
  readonly app: FastifyInstance;
  readonly files: FakeFiles;
  readonly blobs: BlobStore;
  readonly root: string;
  readonly logs: ReturnType<typeof captureLogs>;
  readonly errors: string[];
  // Properties, not methods: tests destructure them.
  readonly as: (next: ResolvedSession | undefined) => void;
  readonly upload: (
    body: Buffer | string | Readable,
    options?: { purpose?: string; name?: string; headers?: Record<string, string> },
  ) => Promise<LightMyRequestResponse>;
  readonly get: (
    id: string,
    options?: { query?: string; headers?: Record<string, string>; method?: 'GET' | 'HEAD' },
  ) => Promise<LightMyRequestResponse>;
  /** Files left in `<uploads>/tmp`. */
  readonly temps: () => Promise<string[]>;
  readonly close: () => Promise<void>;
}

export async function fileHarness(options: HarnessOptions = {}): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), 'surface-files-'));
  const files = new FakeFiles();
  const blobs = (options.blobs ?? localBlobStore)(root);
  const logs = captureLogs();
  const errors: string[] = [];
  let who = 'who' in options ? options.who : session(ADA);
  // Widened to Fastify's base logger type, as `app.ts` does, so the instance keeps its defaults.
  const loggerInstance: FastifyBaseLogger = createLogger(
    testConfig({ logLevel: 'info' }),
    logs.stream,
  );
  const app = Fastify({ loggerInstance });
  // The app's page CSP, which file responses must replace.
  registerSecurityHeaders(app, undefined, { https: false });
  registerFileRoutes(app, {
    auth: { session: () => Promise.resolve(who) },
    lifecycle: { everReady: true },
    withTransaction: async (fn) => {
      const client = new FakeClient();
      try {
        return await fn(client as never);
      } finally {
        client.end();
      }
    },
    blobs,
    log: { error: (_obj: object, message: string) => void errors.push(message) } as never,
    uploadMaxMb: options.uploadMaxMb ?? 25,
    diskSpace: () => Promise.resolve(options.free?.() ?? 100 * GiB),
    store: files,
    ...(options.loadSharp ? { loadSharp: options.loadSharp } : {}),
  });
  return {
    app,
    files,
    blobs,
    root,
    logs,
    errors,
    as: (next) => (who = next),
    upload: (body, { purpose = 'attachment', name, headers = {} } = {}) =>
      app.inject({
        method: 'POST',
        url: `/files/upload?purpose=${purpose}`,
        payload: body,
        headers: {
          'content-type': 'application/octet-stream',
          ...(name === undefined ? {} : { 'x-file-name': encodeURIComponent(name) }),
          ...headers,
        },
      }),
    get: (id, { query = '', headers = {}, method = 'GET' } = {}) =>
      app.inject({ method, url: `/files/${id}${query}`, headers }),
    temps: async () => {
      try {
        return await readdir(path.join(root, 'tmp'));
      } catch {
        return [];
      }
    },
    close: async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** A body as a stream with no declared length (chunked), in pieces of `size` bytes. */
export function chunked(bytes: Buffer, size = 16 * 1024): Readable {
  let at = 0;
  return new Readable({
    read() {
      if (at >= bytes.length) {
        this.push(null);
        return;
      }
      this.push(bytes.subarray(at, at + size));
      at += size;
    },
  });
}
