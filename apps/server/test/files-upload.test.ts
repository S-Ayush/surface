// PLAN-014 S2: `POST /files/upload?purpose=attachment|inline` (SPEC-014 §4.6, §4.8, §6.1; AC-1,
// AC-16, E3, E9, E10, E13), against a fake files store, the real local BlobStore in a temporary
// folder, a fake disk probe and the real sharp (in-process, no network).
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { localBlobStore, type BlobStore } from '../src/files/blob-store.js';
import {
  FREE_SPACE_FLOOR_BYTES,
  FILE_UPLOADS_PER_MINUTE,
  IMAGE_UPLOADS_PER_MINUTE,
  MAX_CONCURRENT_UPLOADS,
  MAX_UNCLAIMED_BYTES,
  MAX_UNCLAIMED_FILES,
  UPLOAD_IDLE_MS,
} from '../src/files/limits.js';
import {
  DISK_FULL_MESSAGE,
  EMPTY_FILE_MESSAGE,
  IMAGE_TOO_LARGE_MESSAGE,
  PURPOSE_MESSAGE,
  UNCLAIMED_CAPS_MESSAGE,
  UPLOADS_BUSY_MESSAGE,
} from '../src/files/routes.js';
import { receiveUpload, withIdleTimeout } from '../src/files/upload-body.js';
import { ADA, BEN, chunked, fileHarness, session, type Harness } from './files-harness.js';

const MiB = 1024 * 1024;

interface Answer {
  id: string;
  url: string;
  mimeType: string;
  size: number;
  name: string;
  width?: number;
  height?: number;
}

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});
const harness = async (options: Parameters<typeof fileHarness>[0] = {}) =>
  (h = await fileHarness(options));

let png: Buffer;
beforeAll(async () => {
  png = await sharp({ create: { width: 600, height: 300, channels: 3, background: '#3366ff' } })
    .png()
    .toBuffer();
});

/** Deterministic bytes that sniff as `application/octet-stream`. */
const PATTERN = Buffer.from(Array.from({ length: 256 }, (_, i) => (i * 7919) % 256));
function binary(size: number): Buffer {
  return Buffer.alloc(size, PATTERN);
}

/** A source that counts what was read from it, and fails the test if it was read at all when it shouldn't be. */
function counted(bytes: Buffer, chunk = 16 * 1024) {
  const state = { pulled: 0 };
  let at = 0;
  const stream = new Readable({
    read() {
      if (at >= bytes.length) {
        this.push(null);
        return;
      }
      const piece = bytes.subarray(at, at + chunk);
      at += piece.length;
      state.pulled += piece.length;
      this.push(piece);
    },
  });
  return { stream, state };
}

describe('POST /files/upload?purpose=attachment|inline (SPEC-014 §6.1)', () => {
  it('stores any file with its sniffed type and cleaned name, unclaimed, and answers it (AC-1)', async () => {
    const { upload, files, blobs } = await harness();
    // The browser's type is ignored: the bytes are text.
    const response = await upload('just some notes\n', {
      name: '../notes‮.txt',
      headers: { 'content-type': 'image/png' },
    });
    expect(response.statusCode).toBe(201);
    const { result } = response.json<{ result: Answer }>();
    expect(result).toEqual({
      id: expect.any(String) as unknown,
      url: `/files/${result.id}`,
      mimeType: 'text/plain',
      size: 16,
      name: 'notes.txt',
    });
    expect(files.rows).toEqual([
      {
        id: result.id,
        storageKey: expect.stringMatching(/^sha256\//) as unknown,
        purpose: 'attachment',
        name: 'notes.txt',
        mimeType: 'text/plain',
        size: 16,
        uploaderId: ADA,
        width: null,
        height: null,
      },
    ]);
    expect((await blobs.get(files.rows[0]?.storageKey ?? ''))?.toString()).toBe(
      'just some notes\n',
    );
    expect(await h?.temps()).toEqual([]);
  });

  it('takes inline files the same way, and never a preview', async () => {
    const { upload, files } = await harness();
    expect((await upload(binary(100), { purpose: 'inline', name: 'a.bin' })).statusCode).toBe(201);
    expect(files.rows[0]).toMatchObject({
      purpose: 'inline',
      mimeType: 'application/octet-stream',
    });
    expect((await upload(binary(100), { purpose: 'preview' })).statusCode).toBe(400);
    expect(files.rows).toHaveLength(1);
  });

  it('asks for a purpose when it is missing or unknown, whatever the size, reading nothing', async () => {
    const { app } = await harness();
    for (const query of ['', '?purpose=preview', '?purpose=nope']) {
      const { stream, state } = counted(binary(3 * MiB));
      const response = await app.inject({
        method: 'POST',
        url: `/files/upload${query}`,
        payload: stream,
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(3 * MiB) },
      });
      expect({ query, status: response.statusCode }).toEqual({ query, status: 400 });
      expect(response.json()).toMatchObject({
        error: { code: 'INVALID_INPUT', message: PURPOSE_MESSAGE },
      });
      expect(response.headers.connection).toBe('close');
      expect(state.pulled).toBe(0);
    }
  });

  it('names a file "file" when no name is sent', async () => {
    const { upload } = await harness();
    expect((await upload(binary(10))).json<{ result: Answer }>().result.name).toBe('file');
  });

  it('reads an image’s width and height from its header on disk', async () => {
    const { upload, files } = await harness();
    const { result } = (await upload(png, { name: 'shot.png' })).json<{ result: Answer }>();
    expect(result).toMatchObject({ mimeType: 'image/png', width: 600, height: 300 });
    expect(files.rows[0]).toMatchObject({ width: 600, height: 300 });
  });

  it('stores the same bytes once, as two rows (E2)', async () => {
    const { upload, files } = await harness();
    await upload(binary(500), { name: 'a.bin' });
    await upload(binary(500), { name: 'b.bin' });
    expect(files.rows.map((row) => row.name)).toEqual(['a.bin', 'b.bin']);
    expect(files.rows[0]?.storageKey).toBe(files.rows[1]?.storageKey);
  });

  it('takes a body sent without a Content-Type', async () => {
    const { app, files } = await harness();
    const response = await app.inject({
      method: 'POST',
      url: '/files/upload?purpose=attachment',
      payload: 'no type given',
    });
    expect(response.statusCode).toBe(201);
    expect(files.rows[0]?.mimeType).toBe('text/plain');
  });

  it('needs a session, and reads nothing without one', async () => {
    const { upload, as, files } = await harness();
    as(undefined);
    const { stream, state } = counted(binary(10));
    const response = await upload(stream, { headers: { 'content-length': '10' } });
    expect(state.pulled).toBe(0);
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { message: 'Log in to upload a file.' } });
    expect(files.rows).toEqual([]);
  });
});

describe('the size limit (AC-1, E3)', () => {
  it('refuses a declared size over UPLOAD_MAX_MB with 413 before reading a byte', async () => {
    const { upload, files } = await harness({ uploadMaxMb: 1 });
    const { stream, state } = counted(binary(MiB + 1));
    const response = await upload(stream, { headers: { 'content-length': String(MiB + 1) } });
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      error: { code: 'INVALID_INPUT', message: 'Files must be 1 MB or smaller.' },
    });
    expect(state.pulled).toBe(0);
    expect(files.rows).toEqual([]);
  });

  it('takes a file of exactly the limit', async () => {
    const { upload } = await harness({ uploadMaxMb: 1 });
    expect((await upload(binary(MiB))).statusCode).toBe(201);
  });

  it('stops reading an undeclared body at the limit, storing nothing', async () => {
    const { upload, files } = await harness({ uploadMaxMb: 1 });
    const { stream, state } = counted(binary(5 * MiB));
    const response = await upload(stream);
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { message: 'Files must be 1 MB or smaller.' } });
    expect(response.headers.connection).toBe('close');
    // Not the whole 5 MB: reading stopped within a few chunks of the limit.
    expect(state.pulled).toBeLessThan(2 * MiB);
    expect(files.rows).toEqual([]);
    expect(await h?.temps()).toEqual([]);
  });

  it('refuses an empty body, declared or not (§6.4)', async () => {
    const { upload, files } = await harness();
    for (const body of [Buffer.alloc(0), chunked(Buffer.alloc(0))]) {
      const response = await upload(body);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'INVALID_INPUT', message: EMPTY_FILE_MESSAGE },
      });
    }
    expect(files.rows).toEqual([]);
    expect(await h?.temps()).toEqual([]);
  });

  it('keeps avatars on the buffered 2 MB parser, whatever UPLOAD_MAX_MB is', async () => {
    const { upload, files } = await harness({ uploadMaxMb: 25 });
    const big = Buffer.concat([png, Buffer.alloc(2 * MiB)]);
    const avatar = await upload(big, { purpose: 'avatar' });
    expect(avatar.statusCode).toBe(413);
    expect(avatar.json()).toMatchObject({ error: { message: IMAGE_TOO_LARGE_MESSAGE } });
    const undeclared = await upload(chunked(big), { purpose: 'avatar' });
    expect(undeclared.statusCode).toBe(413);
    expect(files.rows).toEqual([]);
    // The same bytes as an attachment are fine.
    expect((await upload(big)).statusCode).toBe(201);
    // An avatar is still re-encoded from a whole buffer.
    const stored = await upload(png, { purpose: 'avatar' });
    expect(stored.json<{ result: Answer }>().result.mimeType).toBe('image/webp');
  });
});

describe('memory (AC-1, E13, SPEC-004 E10)', () => {
  /** A BlobStore that measures how far reading runs ahead of the disk. */
  function measuring(root: string, source: { pulled: () => number }) {
    const real = localBlobStore(root);
    const seen = { most: 0 };
    const store: BlobStore = {
      ...real,
      putStream: (body, finish) =>
        real.putStream(
          (async function* () {
            let written = 0;
            for await (const chunk of body) {
              seen.most = Math.max(seen.most, source.pulled() - written);
              yield chunk;
              written += chunk.length;
            }
          })(),
          finish,
        ),
    };
    return { store, seen };
  }

  /** Pull-counting source: `pulled` is what the receiver has taken so far. */
  function source(bytes: Buffer, chunk = 16 * 1024) {
    let pulled = 0;
    return {
      pulled: () => pulled,
      iterable: (async function* () {
        for (let at = 0; at < bytes.length; at += chunk) {
          // Like a socket: the next chunk arrives later.
          await Promise.resolve();
          const piece = bytes.subarray(at, at + chunk);
          pulled += piece.length;
          yield piece;
        }
      })(),
    };
  }

  it.each([
    ['a large binary file', () => binary(4 * MiB)],
    ['a large PNG (one long IDAT)', () => bigImage('png')],
    ['a large JPEG (long scan data)', () => bigImage('jpeg')],
    ['a large WebP', () => bigImage('webp')],
  ])('holds at most 64 KB of %s between reads', async (_name, make) => {
    const bytes = await make();
    // Large enough that holding it whole would show.
    expect(bytes.length).toBeGreaterThan(512 * 1024);
    const h2 = await harness();
    const input = source(bytes);
    const { store, seen } = measuring(h2.root, input);
    const received = await receiveUpload(store, input.iterable, 25 * MiB);
    expect(received.temp.size).toBeGreaterThan(bytes.length / 2);
    expect(seen.most).toBeLessThanOrEqual(64 * 1024);
    await store.discard(received.temp.tempPath);
  });

  it('writes once per chunk read, even for a scan full of stuffed bytes (B1)', async () => {
    const h2 = await harness();
    const real = localBlobStore(h2.root);
    let writes = 0;
    const store: BlobStore = {
      ...real,
      putStream: (body, finish) =>
        real.putStream(
          (async function* () {
            for await (const chunk of body) {
              writes += 1;
              yield chunk;
            }
          })(),
          finish,
        ),
    };
    const scan = Buffer.alloc(2 * MiB, Buffer.from([0xff, 0x00]));
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0]),
      scan,
      Buffer.from([0xff, 0xd9]),
    ]);
    const input = source(jpeg, 64 * 1024);
    const received = await receiveUpload(store, input.iterable, 25 * MiB);
    expect(received.mimeType).toBe('image/jpeg');
    expect(received.temp.size).toBe(jpeg.length);
    expect(writes).toBeLessThanOrEqual(Math.ceil(jpeg.length / (64 * 1024)) + 1);
    await store.discard(received.temp.tempPath);
  });

  it('streams through the route: a 20 MB body is never read far ahead of the disk', async () => {
    const { stream, state } = counted(binary(20 * MiB));
    let seen = { most: 0 };
    const h2 = await harness({
      blobs: (root) => {
        const m = measuring(root, { pulled: () => state.pulled });
        seen = m.seen;
        return m.store;
      },
    });
    const response = await h2.upload(stream, {
      headers: { 'content-length': String(20 * MiB) },
    });
    expect(response.statusCode).toBe(201);
    // The request's own stream buffers sit in between; nothing near 20 MB ever does.
    expect(seen.most).toBeLessThan(512 * 1024);
  });
});

let bigImages: Partial<Record<string, Buffer>> = {};
/** A 1000 × 1000 noisy image, so it compresses badly and is 1–3 MB. */
async function bigImage(format: 'png' | 'jpeg' | 'webp'): Promise<Buffer> {
  const cached = bigImages[format];
  if (cached) return cached;
  const side = 1000;
  const raw = binary(side * side * 3);
  const image = sharp(raw, { raw: { width: side, height: side, channels: 3 } });
  const bytes = await (
    format === 'png'
      ? image.png({ compressionLevel: 0 })
      : format === 'jpeg'
        ? image.jpeg({ quality: 100 })
        : image.webp({ quality: 100 })
  ).toBuffer();
  bigImages = { ...bigImages, [format]: bytes };
  return bytes;
}

describe('rates and caps (AC-16, SPEC-014 §4.6)', () => {
  it(`allows ${FILE_UPLOADS_PER_MINUTE} file uploads a minute per user, apart from avatars`, async () => {
    const { upload, as, logs } = await harness();
    for (let i = 0; i < FILE_UPLOADS_PER_MINUTE; i++) {
      expect((await upload(binary(10 + i))).statusCode).toBe(201);
    }
    const refused = await upload(binary(5));
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(refused.json()).toMatchObject({
      error: {
        code: 'RATE_LIMITED',
        message: expect.stringMatching(/^Too many uploads/) as unknown,
      },
    });
    expect(logs.lines).toContainEqual(
      expect.objectContaining({ msg: 'upload refused', reason: 'rate' }),
    );
    // Avatars have their own bucket of 10.
    for (let i = 0; i < IMAGE_UPLOADS_PER_MINUTE; i++) {
      expect((await upload(png, { purpose: 'avatar' })).statusCode).toBe(201);
    }
    expect((await upload(png, { purpose: 'avatar' })).statusCode).toBe(429);
    // Per user.
    as(session(BEN));
    expect((await upload(binary(5))).statusCode).toBe(201);
  });

  it(`refuses a user's upload past ${MAX_UNCLAIMED_FILES} unclaimed files`, async () => {
    const { upload, files, logs } = await harness();
    const row = (i: number, extra: object = {}) => ({
      id: `f${i}`,
      storageKey: 'k',
      purpose: 'attachment' as const,
      name: 'x',
      mimeType: 'text/plain',
      size: 1,
      uploaderId: ADA,
      ...extra,
    });
    files.rows = Array.from({ length: MAX_UNCLAIMED_FILES - 1 }, (_, i) => row(i));
    // Claimed files and someone else's don't count.
    files.rows.push(row(200, { issueId: 'issue' }), row(201, { uploaderId: BEN }));
    expect((await upload(binary(10))).statusCode).toBe(201);
    const refused = await upload(binary(10));
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({
      error: { code: 'RATE_LIMITED', message: UNCLAIMED_CAPS_MESSAGE },
    });
    expect(logs.lines).toContainEqual(
      expect.objectContaining({ msg: 'upload refused', reason: 'caps' }),
    );
  });

  it('refuses a user’s upload past 1 GB unclaimed, from the declared size or, without one, after writing', async () => {
    const { upload, files } = await harness();
    files.rows = [
      {
        id: 'big',
        storageKey: 'k',
        purpose: 'inline',
        name: 'x',
        mimeType: 'text/plain',
        size: MAX_UNCLAIMED_BYTES - 100,
        uploaderId: ADA,
      },
    ];
    const { stream, state } = counted(binary(101));
    const declared = await upload(stream, { headers: { 'content-length': '101' } });
    expect(declared.statusCode).toBe(429);
    expect(state.pulled).toBe(0);
    const undeclared = await upload(chunked(binary(101)));
    expect(undeclared.statusCode).toBe(429);
    expect(undeclared.json()).toMatchObject({ error: { message: UNCLAIMED_CAPS_MESSAGE } });
    expect(files.rows).toHaveLength(1);
    expect(await h?.temps()).toEqual([]);
    expect((await upload(binary(100))).statusCode).toBe(201);
  });
});

describe('server errors on the streamed path (review m6)', () => {
  it('closes the connection when the caps can’t be read, the body unread', async () => {
    const { upload, files } = await harness();
    files.unclaimedUsage = () => Promise.reject(new Error('database is down'));
    const { stream, state } = counted(binary(10));
    const response = await upload(stream);
    expect(response.statusCode).toBe(500);
    expect(response.headers.connection).toBe('close');
    expect(state.pulled).toBe(0);
  });

  it('closes the connection and removes the temporary file when the insert fails', async () => {
    const { upload, files, temps } = await harness();
    files.insert = () => Promise.reject(new Error('database is down'));
    const response = await upload(binary(10));
    expect(response.statusCode).toBe(500);
    expect(response.headers.connection).toBe('close');
    expect(await temps()).toEqual([]);
  });
});

describe('parallel uploads and the caps (review M2)', () => {
  it('lets only one of two parallel uploads take the last unclaimed slot', async () => {
    const { upload, files } = await harness();
    files.rows = Array.from({ length: MAX_UNCLAIMED_FILES - 1 }, (_, i) => ({
      id: `f${i}`,
      storageKey: 'k',
      purpose: 'attachment' as const,
      name: 'x',
      mimeType: 'text/plain',
      size: 1,
      uploaderId: ADA,
    }));
    // Both pass the check before reading; the one in the insert's transaction decides.
    const answers = await Promise.all([upload(binary(10)), upload(binary(20))]);
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([201, 429]);
    expect(files.rows).toHaveLength(MAX_UNCLAIMED_FILES);
    expect(await h?.temps()).toEqual([]);
  });

  it('lets only one of two parallel uploads take the last unclaimed bytes', async () => {
    const { upload, files } = await harness();
    files.rows = [
      {
        id: 'big',
        storageKey: 'k',
        purpose: 'inline',
        name: 'x',
        mimeType: 'text/plain',
        size: MAX_UNCLAIMED_BYTES - 100,
        uploaderId: ADA,
      },
    ];
    const answers = await Promise.all([upload(binary(60)), upload(binary(61))]);
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([201, 429]);
    expect(files.rows).toHaveLength(2);
  });
});

/** Waits, a turn of the event loop at a time, for `ready`; no timers, so fake ones don't stall it. */
async function until(ready: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let turn = 0; turn < 20_000; turn++) {
    if (await ready()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Gave up waiting for ${what}.`);
}

/** A body that sends `first`, then nothing until `finish()`. */
function stalled(first: Buffer, rest: Buffer = Buffer.alloc(0)) {
  let sent = false;
  const stream = new Readable({
    read() {
      if (!sent) {
        sent = true;
        this.push(first);
      }
    },
  });
  return {
    stream,
    finish: () => {
      if (rest.length > 0) stream.push(rest);
      stream.push(null);
    },
  };
}

describe('slow and stalled uploads (review M1)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('withIdleTimeout calls onIdle once nothing arrives for the timeout, restarting on each chunk', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const source = new PassThrough();
    let idle = 0;
    const got: Buffer[] = [];
    const reading = (async () => {
      for await (const chunk of withIdleTimeout(source, UPLOAD_IDLE_MS, () => {
        idle += 1;
        source.destroy(new Error('idle'));
      })) {
        got.push(chunk as Buffer);
      }
    })();
    source.write('a');
    await until(() => got.length === 1, 'the first chunk');
    vi.advanceTimersByTime(UPLOAD_IDLE_MS - 1);
    source.write('b');
    await until(() => got.length === 2, 'the second chunk');
    vi.advanceTimersByTime(UPLOAD_IDLE_MS - 1);
    expect(idle).toBe(0);
    vi.advanceTimersByTime(1);
    expect(idle).toBe(1);
    await expect(reading).rejects.toThrow('idle');
  });

  it('withIdleTimeout leaves no timer behind once the source ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let idle = 0;
    const chunks: unknown[] = [];
    for await (const chunk of withIdleTimeout(Readable.from([Buffer.from('x')]), 10, () => {
      idle += 1;
    })) {
      chunks.push(chunk);
    }
    vi.advanceTimersByTime(60_000);
    expect([chunks.length, idle, vi.getTimerCount()]).toEqual([1, 0, 0]);
  });

  it(`closes an upload that sends nothing for ${UPLOAD_IDLE_MS / 1000} seconds, storing nothing`, async () => {
    const { upload, files, logs, temps, root } = await harness();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const first = 64 * 1024;
    const body = stalled(binary(first));
    const answer = upload(body.stream);
    // The first chunk is on disk and the route waits for the next, its idle timer running.
    await until(async () => {
      const [temp] = await temps();
      if (temp === undefined) return false;
      const written = (await stat(path.join(root, 'tmp', temp))).size;
      return written === first && vi.getTimerCount() === 1;
    }, 'the first chunk on disk');
    vi.advanceTimersByTime(UPLOAD_IDLE_MS - 1);
    expect(logs.lines.some((line) => line.msg === 'upload refused')).toBe(false);
    vi.advanceTimersByTime(1);
    // The connection is destroyed, so no answer reaches the client.
    await expect(answer).rejects.toThrow('response destroyed');
    await until(
      () => logs.lines.some((line) => line.msg === 'upload refused' && line.reason === 'idle'),
      'the refusal',
    );
    expect(files.rows).toEqual([]);
    await until(async () => (await temps()).length === 0, 'the temporary file to go');
  });

  it(`takes at most ${MAX_CONCURRENT_UPLOADS} uploads at once per user`, async () => {
    const { upload, files, logs, temps, as } = await harness();
    const bodies = Array.from({ length: MAX_CONCURRENT_UPLOADS }, (_, i) =>
      stalled(binary(16 * 1024 + i), binary(100)),
    );
    const answers = bodies.map((body) => upload(body.stream));
    await until(
      async () => (await temps()).length === MAX_CONCURRENT_UPLOADS,
      'the uploads to start',
    );
    const { stream, state } = counted(binary(10));
    const busy = await upload(stream);
    expect(busy.statusCode).toBe(429);
    expect(busy.json()).toMatchObject({
      error: { code: 'RATE_LIMITED', message: UPLOADS_BUSY_MESSAGE },
    });
    expect(busy.headers.connection).toBe('close');
    expect(state.pulled).toBe(0);
    expect(logs.lines).toContainEqual(
      expect.objectContaining({ msg: 'upload refused', reason: 'busy' }),
    );
    // Someone else isn't held up.
    as(session(BEN));
    expect((await upload(binary(10))).statusCode).toBe(201);
    as(session(ADA));
    for (const body of bodies) body.finish();
    expect((await Promise.all(answers)).map((answer) => answer.statusCode)).toEqual(
      Array.from({ length: MAX_CONCURRENT_UPLOADS }, () => 201),
    );
    // Finished uploads free their places.
    expect((await upload(binary(10))).statusCode).toBe(201);
    expect(files.rows).toHaveLength(MAX_CONCURRENT_UPLOADS + 2);
  });
});

describe('the free-space floor (AC-16, E9, SPEC-004 E6)', () => {
  it('refuses with 507 before reading when the upload would leave less than 1 GB free', async () => {
    const { upload, files, logs } = await harness({ free: () => FREE_SPACE_FLOOR_BYTES + 100 });
    const { stream, state } = counted(binary(101));
    const response = await upload(stream, { headers: { 'content-length': '101' } });
    expect(response.statusCode).toBe(507);
    expect(response.json()).toMatchObject({
      ok: false,
      error: { code: 'INSUFFICIENT_STORAGE', message: DISK_FULL_MESSAGE },
    });
    expect(state.pulled).toBe(0);
    expect(files.rows).toEqual([]);
    expect(logs.lines).toContainEqual(
      expect.objectContaining({ msg: 'upload refused', reason: 'floor' }),
    );
    // 100 bytes fit.
    expect((await upload(binary(100))).statusCode).toBe(201);
  });

  it('counts the whole limit when no length is declared', async () => {
    const { upload } = await harness({ uploadMaxMb: 2, free: () => FREE_SPACE_FLOOR_BYTES + MiB });
    expect((await upload(chunked(binary(10)))).statusCode).toBe(507);
  });

  it('checks again before the rename, removing what was written', async () => {
    const answers = [FREE_SPACE_FLOOR_BYTES * 2, FREE_SPACE_FLOOR_BYTES - 1];
    const { upload, files, blobs } = await harness({ free: () => answers.shift() ?? 0 });
    const response = await upload(binary(1000));
    expect(response.statusCode).toBe(507);
    expect(files.rows).toEqual([]);
    expect(await h?.temps()).toEqual([]);
    expect(await blobs.stat(`sha256/00/00/${'0'.repeat(64)}`)).toBeUndefined();
  });

  it('answers 507 and stores nothing when the disk fills while writing (E9)', async () => {
    const { upload, files } = await harness({
      blobs: (root) => {
        const real = localBlobStore(root);
        return {
          ...real,
          putStream: async (body) => {
            for await (const _chunk of body) break;
            throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
          },
        };
      },
    });
    const response = await upload(binary(1000));
    expect(response.statusCode).toBe(507);
    expect(response.json()).toMatchObject({ error: { code: 'INSUFFICIENT_STORAGE' } });
    expect(files.rows).toEqual([]);
  });
});

describe('logs and sharp (SPEC-014 §10, E10)', () => {
  it('logs the id, purpose and size, never the name or the contents', async () => {
    const { upload, logs, files } = await harness();
    await upload('the secret plan is on page 2', { name: 'secret-plan.txt' });
    expect(logs.lines).toContainEqual(
      expect.objectContaining({
        msg: 'file uploaded',
        fileId: files.rows[0]?.id,
        purpose: 'attachment',
        size: 28,
      }),
    );
    expect(logs.text()).not.toContain('secret');
  });

  it('still takes uploads when sharp can’t load, without dimensions, logging it once', async () => {
    const { upload, errors, files } = await harness({
      loadSharp: () => Promise.reject(new Error('no binary')),
    });
    const first = await upload(png);
    const second = await upload(png);
    expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
    expect(first.json<{ result: Answer }>().result).not.toHaveProperty('width');
    expect(files.rows[0]).toMatchObject({ width: null, height: null, mimeType: 'image/png' });
    expect(errors).toEqual(['sharp could not load; image dimensions are left empty']);
  });

  it('writes temporary files under <uploads>/tmp and leaves none behind', async () => {
    const { upload, root, files } = await harness();
    await upload(binary(1234));
    expect(await h?.temps()).toEqual([]);
    const key = files.rows[0]?.storageKey ?? '';
    expect((await readFile(path.join(root, ...key.split('/')))).length).toBe(1234);
  });
});
