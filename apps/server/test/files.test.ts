// PLAN-001 S6, ADR-0014, SPEC-001 §3.5: uploading and serving avatars and the logo, against a
// fake files store and an in-memory BlobStore (the store's SQL ran in Postgres by hand). sharp is
// real: it runs in-process, with no network.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { userActor } from '@surface/domain';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ResolvedSession } from '../src/auth/sessions.js';
import { blobKey, isBlobKey, localBlobStore, memoryBlobStore } from '../src/files/blob-store.js';
import {
  imageProcessor,
  ImagesBusy,
  ImagesUnavailable,
  MAX_CONCURRENT_IMAGES,
  MAX_WAITING_IMAGES,
  sniffImage,
  UploadAbandoned,
  type SharpFactory,
} from '../src/files/image.js';
import {
  IMAGE_PIXELS_MESSAGE,
  IMAGE_TOO_LARGE_MESSAGE,
  IMAGE_TYPE_MESSAGE,
  IMAGE_UNREADABLE_MESSAGE,
  IMAGES_UNAVAILABLE_MESSAGE,
  registerFileRoutes,
  UPLOADS_PER_MINUTE,
} from '../src/files/routes.js';
import type { FileStore, NewFile } from '../src/files/store.js';
import { registerSecurityHeaders } from '../src/http/security-headers.js';

const ADA = '01930000-0000-7000-8000-00000000ada1';
const BEN = '01930000-0000-7000-8000-00000000be01';

function session(userId: string, role: 'admin' | 'member'): ResolvedSession {
  return {
    id: `session-of-${userId}`,
    userId,
    workspaceId: 'w',
    actor: userActor({ userId, role, memberships: [] }),
  };
}

/** Rows in memory; a file is readable by its uploader, or by anyone once it is `inUse`. */
class FakeFiles implements FileStore {
  rows: NewFile[] = [];
  inUse = new Set<string>();
  insert(_client: unknown, file: NewFile) {
    this.rows.push(file);
    return Promise.resolve();
  }
  readable(_client: unknown, fileId: string, userId: string) {
    const row = this.rows.find((file) => file.id === fileId);
    return Promise.resolve(
      row && (row.uploaderId === userId || this.inUse.has(fileId)) ? row : undefined,
    );
  }
}

let png: Buffer;
beforeAll(async () => {
  // Wider than tall, so the square crop shows.
  png = await sharp({
    create: { width: 600, height: 300, channels: 3, background: '#3366ff' },
  })
    .png()
    .toBuffer();
});

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function setup(
  options: {
    who?: ResolvedSession | undefined;
    ready?: boolean;
    uploadMaxMb?: number;
    sharpFails?: boolean;
  } = {},
) {
  const files = new FakeFiles();
  const blobs = memoryBlobStore();
  const errors: string[] = [];
  let who = 'who' in options ? options.who : session(ADA, 'member');
  app = Fastify();
  // The app's page CSP, which file responses must replace.
  registerSecurityHeaders(app, undefined, { https: false });
  registerFileRoutes(app, {
    auth: { session: (_request: FastifyRequest) => Promise.resolve(who) },
    lifecycle: { everReady: options.ready ?? true },
    withTransaction: (fn) => fn({} as never),
    blobs,
    log: { error: (_obj: object, message: string) => void errors.push(message) } as never,
    uploadMaxMb: options.uploadMaxMb ?? 25,
    store: files,
    ...(options.sharpFails ? { loadSharp: () => Promise.reject(new Error('no binary')) } : {}),
  });
  const upload = (body: Buffer | string, purpose = 'avatar', headers: object = {}) =>
    app!.inject({
      method: 'POST',
      url: `/files/upload?purpose=${purpose}`,
      payload: body,
      headers: { 'content-type': 'image/png', ...headers },
    });
  const get = (id: string, headers: object = {}) =>
    app!.inject({ method: 'GET', url: `/files/${id}`, headers: { ...headers } });
  return { files, blobs, errors, upload, get, as: (next?: ResolvedSession) => (who = next) };
}

describe('POST /files/upload (ADR-0014; SPEC-001 §3.5)', () => {
  it('stores an avatar as a 256 px square WebP and answers its id', async () => {
    const { upload, files, blobs } = setup();
    const response = await upload(png);
    expect(response.statusCode).toBe(201);
    const { result } = response.json<{ result: { id: string; url: string; mimeType: string } }>();
    expect(result.url).toBe(`/files/${result.id}`);
    expect(result.mimeType).toBe('image/webp');
    expect(files.rows).toEqual([
      expect.objectContaining({
        id: result.id,
        purpose: 'avatar',
        name: 'avatar.webp',
        mimeType: 'image/webp',
        uploaderId: ADA,
      }),
    ]);
    const stored = await blobs.get(files.rows[0]?.storageKey ?? '');
    const meta = await sharp(stored).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 256, 256]);
  });

  it('takes the type from the bytes, refusing SVG and anything else whatever it claims', async () => {
    const { upload, files } = setup();
    const svg = await upload('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>', 'avatar', {
      'content-type': 'image/png',
    });
    expect(svg.statusCode).toBe(400);
    expect(svg.json()).toMatchObject({
      error: { code: 'INVALID_INPUT', message: IMAGE_TYPE_MESSAGE },
    });
    expect(files.rows).toEqual([]);
  });

  it('refuses bytes that only start like an image', async () => {
    const { upload, files } = setup();
    const response = await upload(Buffer.concat([png.subarray(0, 16), Buffer.alloc(64)]));
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { message: IMAGE_UNREADABLE_MESSAGE } });
    expect(files.rows).toEqual([]);
  });

  it('refuses more than 2 MB with 413 before reading it', async () => {
    const { upload, files } = setup();
    const response = await upload(Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]));
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ error: { message: IMAGE_TOO_LARGE_MESSAGE } });
    expect(files.rows).toEqual([]);
  });

  it('keeps to a lower UPLOAD_MAX_MB, which can only lower the limit', async () => {
    const { upload } = setup({ uploadMaxMb: 1 });
    expect((await upload(Buffer.concat([png, Buffer.alloc(1024 * 1024)]))).statusCode).toBe(413);
    await app?.close();
    const generous = setup({ uploadMaxMb: 10_000 });
    expect(
      (await generous.upload(Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)]))).statusCode,
    ).toBe(413);
  });

  it('needs a session, and an Admin for the logo', async () => {
    const signedOut = setup({ who: undefined });
    const refused = await signedOut.upload(png);
    expect(refused.statusCode).toBe(401);
    expect(refused.json()).toMatchObject({ error: { message: 'Log in to upload an image.' } });
    await app?.close();
    const member = setup();
    expect((await member.upload(png, 'logo')).json()).toMatchObject({
      error: { code: 'FORBIDDEN', message: 'Only Admins can change the workspace logo.' },
    });
    member.as(session(ADA, 'admin'));
    expect((await member.upload(png, 'logo')).statusCode).toBe(201);
    expect(member.files.rows[0]?.name).toBe('logo.webp');
  });

  it('asks what the image is for', async () => {
    const { upload } = setup();
    const response = await upload(png, 'banner');
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { message: expect.stringContaining('?purpose=avatar') as unknown },
    });
  });

  it('limits each user to UPLOADS_PER_MINUTE uploads, before decoding (S9 security review L3)', async () => {
    const { upload, files, as } = setup();
    for (let i = 0; i < UPLOADS_PER_MINUTE; i += 1)
      expect((await upload(png)).statusCode).toBe(201);
    const refused = await upload(png);
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(refused.json()).toMatchObject({
      ok: false,
      error: {
        code: 'RATE_LIMITED',
        message: expect.stringMatching(/^Too many uploads/) as unknown,
      },
    });
    expect(files.rows).toHaveLength(UPLOADS_PER_MINUTE);
    // Per user: someone else can still upload.
    as(session(BEN, 'member'));
    expect((await upload(png)).statusCode).toBe(201);
  });

  it('answers 503 until the server is ready (SPEC-001 Q5)', async () => {
    const { upload } = setup({ ready: false });
    expect((await upload(png)).statusCode).toBe(503);
  });

  it('refuses uploads with 503 when sharp can’t load, storing nothing (S6 review)', async () => {
    // The original would keep its metadata (a photo's location) for the whole workspace to read.
    const { upload, files, blobs, errors } = setup({ sharpFails: true });
    const response = await upload(png);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false,
      error: { code: 'UNAVAILABLE', message: IMAGES_UNAVAILABLE_MESSAGE },
    });
    expect(files.rows).toEqual([]);
    expect(blobs.keys()).toEqual([]);
    expect(errors).toEqual(['sharp could not load; image uploads are refused']);
  });
});

describe('GET /files/:id (ADR-0014)', () => {
  it('serves the stored type, never as a page, revalidated by ETag', async () => {
    const { upload, get } = setup();
    const { result } = (await upload(png)).json<{ result: { id: string } }>();
    const response = await get(result.id);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/webp');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(response.headers['content-disposition']).toBe('inline');
    expect(response.headers['cache-control']).toBe('private, no-cache');
    const etag = response.headers.etag;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const again = await get(result.id, { 'if-none-match': etag });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
  });

  it('is 404 for someone else’s upload nothing uses yet, and readable once it is in use', async () => {
    const { upload, get, files, as } = setup();
    const { result } = (await upload(png)).json<{ result: { id: string } }>();
    as(session(BEN, 'member'));
    const hidden = await get(result.id);
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    files.inUse.add(result.id);
    expect((await get(result.id)).statusCode).toBe(200);
  });

  it('is 404 for an unknown or malformed id, and 401 without a session', async () => {
    const { get, as } = setup();
    expect((await get('01930000-0000-7000-8000-000000000000')).statusCode).toBe(404);
    expect((await get('..%2F..%2Fetc%2Fpasswd')).statusCode).toBe(404);
    as(undefined);
    expect((await get('01930000-0000-7000-8000-000000000000')).statusCode).toBe(401);
  });
});

describe('image memory (SPEC-004 E10)', () => {
  /**
   * A fake sharp: every image is 100 × 100, and a decode finishes only when the test releases it.
   * It records the order decodes start in (by the input's text) and how many run at once.
   */
  function gatedSharp(options: { settingsThrow?: boolean } = {}) {
    let inFlight = 0;
    let most = 0;
    const started: string[] = [];
    const gates: (() => void)[] = [];
    const calls = { cache: [] as unknown[], concurrency: [] as unknown[] };
    const pipelineFor = (input: Buffer): ReturnType<SharpFactory> => {
      const pipeline: ReturnType<SharpFactory> = {
        rotate: () => pipeline,
        resize: () => pipeline,
        webp: () => pipeline,
        metadata: () => Promise.resolve({ width: 100, height: 100 }),
        toBuffer: async () => {
          started.push(input.toString());
          inFlight += 1;
          most = Math.max(most, inFlight);
          await new Promise<void>((resolve) => gates.push(resolve));
          inFlight -= 1;
          return Buffer.from('webp');
        },
      };
      return pipeline;
    };
    const factory: SharpFactory = Object.assign((input: Buffer) => pipelineFor(input), {
      cache: (value: boolean) => {
        if (options.settingsThrow) throw new Error('no cache control');
        calls.cache.push(value);
      },
      concurrency: (value: number) => void calls.concurrency.push(value),
    });
    return {
      factory,
      calls,
      started,
      most: () => most,
      inFlight: () => gates.length,
      release: () => gates.shift()?.(),
    };
  }

  function processorWith(fake: ReturnType<typeof gatedSharp>, errors: string[] = []) {
    return imageProcessor(
      { error: (_obj: object, message: string) => void errors.push(message) } as never,
      () => Promise.resolve(fake.factory),
    );
  }

  /** Lets queued promise callbacks run, so started decodes reach their gate. */
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

  it(`decodes at most ${MAX_CONCURRENT_IMAGES} images at once, the rest in arrival order`, async () => {
    const fake = gatedSharp();
    const process = processorWith(fake);
    const all = Promise.all([0, 1, 2, 3, 4].map((i) => process(Buffer.from(String(i)))));
    for (let done = 0; done < 5; done++) {
      await settle();
      expect(fake.inFlight()).toBe(Math.min(MAX_CONCURRENT_IMAGES, 5 - done));
      fake.release();
    }
    expect(await all).toHaveLength(5);
    expect(fake.most()).toBe(MAX_CONCURRENT_IMAGES);
    expect(fake.started).toEqual(['0', '1', '2', '3', '4']);
  });

  it(`refuses an upload when ${MAX_WAITING_IMAGES} are already waiting, and finishes the others`, async () => {
    const fake = gatedSharp();
    const process = processorWith(fake);
    const accepted = Array.from({ length: MAX_CONCURRENT_IMAGES + MAX_WAITING_IMAGES }, (_, i) =>
      process(Buffer.from(String(i))),
    );
    await settle();
    await expect(process(Buffer.from('one too many'))).rejects.toBeInstanceOf(ImagesBusy);
    for (let i = 0; i < accepted.length; i++) {
      await settle();
      fake.release();
    }
    expect(await Promise.all(accepted)).toHaveLength(accepted.length);
  });

  it('skips the decode of an upload whose client went away while it waited', async () => {
    const fake = gatedSharp();
    const process = processorWith(fake);
    let gone = false;
    const first = [process(Buffer.from('a')), process(Buffer.from('b'))];
    const waiting = process(Buffer.from('left'), () => gone);
    await settle();
    gone = true;
    fake.release();
    await expect(waiting).rejects.toBeInstanceOf(UploadAbandoned);
    fake.release();
    await Promise.all(first);
    expect(fake.started).toEqual(['a', 'b']);
  });

  it('turns off the operation cache and uses one libvips thread per image', async () => {
    const fake = gatedSharp();
    const one = processorWith(fake)(Buffer.from('img'));
    await settle();
    fake.release();
    await one;
    expect(fake.calls).toEqual({ cache: [false], concurrency: [1] });
  });

  it('refuses uploads, with a log line, when sharp can’t be set up', async () => {
    const errors: string[] = [];
    const process = processorWith(gatedSharp({ settingsThrow: true }), errors);
    await expect(process(Buffer.from('img'))).rejects.toBeInstanceOf(ImagesUnavailable);
    expect(errors).toEqual(['sharp could not load; image uploads are refused']);
  });

  it('refuses an image over 25 MP from its header, saying how big it may be', async () => {
    const solid = (width: number, height: number) =>
      sharp({ create: { width, height, channels: 3, background: '#c33' } })
        .png()
        .toBuffer();
    const { upload } = setup();
    expect((await upload(await solid(5000, 5000))).statusCode).toBe(201);
    const over = await upload(await solid(5001, 5000));
    expect(over.statusCode).toBe(400);
    expect(over.json()).toMatchObject({
      error: { code: 'INVALID_INPUT', message: IMAGE_PIXELS_MESSAGE },
    });
  });
});

describe('sniffImage', () => {
  it('knows PNG, JPEG, GIF and WebP by their first bytes, and nothing else', () => {
    const bytes = (...parts: (number[] | string)[]) =>
      Buffer.concat(
        parts.map((part) =>
          typeof part === 'string' ? Buffer.from(part, 'latin1') : Buffer.from(part),
        ),
      );
    expect(sniffImage(png)).toBe('image/png');
    expect(sniffImage(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(bytes('GIF89a'))).toBe('image/gif');
    expect(sniffImage(bytes('GIF87a'))).toBe('image/gif');
    expect(sniffImage(bytes('RIFF', [1, 2, 3, 4], 'WEBPVP8 '))).toBe('image/webp');
    expect(sniffImage(bytes('RIFF', [1, 2, 3, 4], 'WAVEfmt '))).toBeUndefined();
    expect(sniffImage(bytes('<svg'))).toBeUndefined();
    expect(sniffImage(bytes('<?xml version="1.0"?><svg'))).toBeUndefined();
    expect(sniffImage(bytes([0x89, 0x50]))).toBeUndefined();
  });
});

describe('the local BlobStore (ADR-0014)', () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('stores bytes under their hash once, leaving no temporary files', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'surface-blobs-'));
    const blobs = localBlobStore(root);
    const key = await blobs.put(png);
    expect(key).toBe(blobKey(png));
    expect(await blobs.put(png)).toBe(key);
    expect(await blobs.get(key)).toEqual(png);
    expect(await blobs.stat(key)).toEqual({ size: png.length });
    const dir = path.join(root, ...key.split('/').slice(0, 3));
    expect(await readdir(dir)).toEqual([key.split('/')[3]]);
    await blobs.delete(key);
    expect(await blobs.get(key)).toBeUndefined();
    expect(await blobs.stat(key)).toBeUndefined();
  });

  it('touches only keys it made', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'surface-blobs-'));
    const blobs = localBlobStore(root);
    const hash = 'a'.repeat(64);
    expect(isBlobKey(`sha256/aa/aa/${hash}`)).toBe(true);
    expect(isBlobKey(`sha256/ab/aa/${hash}`)).toBe(false);
    expect(isBlobKey('../../etc/passwd')).toBe(false);
    expect(isBlobKey(`sha256/aa/aa/${hash}/../x`)).toBe(false);
    await expect(blobs.get('../../etc/passwd')).rejects.toThrow('Not a blob key.');
  });
});
