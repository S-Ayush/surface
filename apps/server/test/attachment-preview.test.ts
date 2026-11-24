// PLAN-014 S4b, SPEC-014 §4.4: the `files-preview` job. With the real sharp (as `files.test.ts`):
// an 800 px WebP without metadata, orientation applied, a GIF's first frame, the 25 MP skip, a
// broken image skipped, sharp missing (E10). The job on fakes: the preview row through the byte
// protocol with the source's uploader, `attachment.setPreview` as the system, nothing for a gone
// attachment or source, a re-run, a reused preview after an undo. One decode limiter shared with
// avatars. AC-12, E10, E14, E21.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { systemActor } from '@surface/domain';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecuteResult, Executor } from '../src/executor/execute.js';
import { localBlobStore, memoryBlobStore, type BlobStore } from '../src/files/blob-store.js';
import type { FileDb, FileTx, NewFile } from '../src/files/bytes.js';
import {
  decodeSlots,
  imageProcessor,
  MAX_CONCURRENT_IMAGES,
  previewMaker,
  type PreviewImage,
  type SharpFactory,
} from '../src/files/image.js';
import {
  makePreview,
  previewJobHandler,
  previewName,
  type PreviewJobDeps,
  type PreviewTarget,
} from '../src/jobs/files-preview.js';

const quiet = { error: () => undefined };
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'surface-preview-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function onDisk(name: string, bytes: Buffer): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, bytes);
  return file;
}

const made = (image: PreviewImage) => {
  if (image.kind !== 'made') throw new Error(`no preview: ${image.reason}`);
  return image;
};

/** A valid PNG whose header claims `width` × `height` (its pixel data is a 1 × 1 image's). */
async function pngClaiming(width: number, height: number): Promise<Buffer> {
  const png = await sharp({
    create: { width: 1, height: 1, channels: 3, background: '#888' },
  })
    .png()
    .toBuffer();
  // IHDR starts at 8: length (4), type (4), width (4), height (4), …, then its CRC.
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
  return png;
}

describe('previewMaker with the real sharp (AC-12)', () => {
  it('makes a WebP at most 800 px on its longer side, keeping the aspect ratio', async () => {
    const file = await onDisk(
      'wide.png',
      await sharp({ create: { width: 2000, height: 1000, channels: 3, background: '#3a6' } })
        .png()
        .toBuffer(),
    );
    const preview = made(await previewMaker(quiet)(file));
    expect([preview.width, preview.height]).toEqual([800, 400]);
    const meta = await sharp(preview.bytes).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 800, 400]);
  });

  it('never enlarges a small image', async () => {
    const file = await onDisk(
      'small.png',
      await sharp({ create: { width: 300, height: 200, channels: 4, background: '#fff0' } })
        .png()
        .toBuffer(),
    );
    expect(made(await previewMaker(quiet)(file))).toMatchObject({ width: 300, height: 200 });
  });

  it('applies the camera orientation, then drops every piece of metadata', async () => {
    const file = await onDisk(
      'photo.jpg',
      await sharp({ create: { width: 1600, height: 800, channels: 3, background: '#a33' } })
        .jpeg()
        .withMetadata({ orientation: 6 })
        .withExif({ IFD0: { Artist: 'Ada Lovelace', Copyright: 'Ada' } })
        .toBuffer(),
    );
    expect((await sharp(file).metadata()).exif).toBeDefined();
    const preview = made(await previewMaker(quiet)(file));
    // Orientation 6 is a quarter turn: the stored 1600 × 800 displays as 800 × 1600.
    expect([preview.width, preview.height]).toEqual([400, 800]);
    const meta = await sharp(preview.bytes).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.orientation).toBeUndefined();
    expect(preview.bytes.includes(Buffer.from('Ada Lovelace'))).toBe(false);
  });

  it('makes an animated GIF’s preview from its first frame', async () => {
    const frame = (background: string) =>
      sharp({ create: { width: 40, height: 30, channels: 4, background } })
        .png()
        .toBuffer();
    const gif = await sharp([await frame('#ff0000'), await frame('#0000ff')], {
      join: { animated: true },
    })
      .gif()
      .toBuffer();
    expect((await sharp(gif).metadata()).pages).toBe(2);
    const preview = made(await previewMaker(quiet)(await onDisk('anim.gif', gif)));
    const meta = await sharp(preview.bytes).metadata();
    expect(meta.pages).toBeUndefined();
    const { data } = await sharp(preview.bytes).raw().toBuffer({ resolveWithObject: true });
    // Red, the first frame, not blue.
    expect(data[0]).toBeGreaterThan(200);
    expect(data[2]).toBeLessThan(50);
  });

  it('skips an image whose header says more than 25 MP, decoding nothing (E14)', async () => {
    let decodes = 0;
    const counting = decodeSlots();
    const make = previewMaker(quiet, undefined, (task) => {
      decodes += 1;
      return counting(task);
    });
    const big = await onDisk('huge.png', await pngClaiming(6000, 5000));
    expect(await make(big)).toEqual({ kind: 'skipped', reason: 'too large' });
    expect(decodes).toBe(0);
    // Exactly 25 MP is allowed through to the decode (which then finds the data short).
    expect(await make(await onDisk('edge.png', await pngClaiming(5000, 5000)))).toEqual({
      kind: 'skipped',
      reason: 'unreadable',
    });
    expect(decodes).toBe(1);
  });

  it('skips a file it can’t decode, without throwing', async () => {
    const broken = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('not really a png'),
    ]);
    expect(await previewMaker(quiet)(await onDisk('broken.png', broken))).toEqual({
      kind: 'skipped',
      reason: 'unreadable',
    });
    expect(await previewMaker(quiet)(path.join(dir, 'missing.png'))).toEqual({
      kind: 'skipped',
      reason: 'unreadable',
    });
  });

  it('skips every image when sharp can’t load, logging the error once (E10)', async () => {
    const errors: string[] = [];
    const make = previewMaker(
      { error: (_object: object, message: string) => void errors.push(message) },
      () => Promise.reject(new Error('no prebuilt binary')),
    );
    expect(await make('/nowhere/a.png')).toEqual({ kind: 'skipped', reason: 'unavailable' });
    expect(await make('/nowhere/b.png')).toEqual({ kind: 'skipped', reason: 'unavailable' });
    expect(errors).toEqual(['sharp could not load; image previews are not made']);
  });
});

describe('one decode limiter per process, shared with avatars (§4.4, SPEC-004 E10)', () => {
  /** A fake sharp whose decodes finish only when released; counts how many run at once. */
  function gatedSharp() {
    let inFlight = 0;
    let most = 0;
    const gates: (() => void)[] = [];
    const pipeline: ReturnType<SharpFactory> = {
      rotate: () => pipeline,
      resize: () => pipeline,
      webp: () => pipeline,
      metadata: () => Promise.resolve({ width: 100, height: 100 }),
      toBuffer: async () => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise<void>((resolve) => gates.push(resolve));
        inFlight -= 1;
        return Buffer.from('webp');
      },
    };
    const factory: SharpFactory = Object.assign(() => pipeline, {
      cache: () => undefined,
      concurrency: () => undefined,
    });
    return {
      load: () => Promise.resolve(factory),
      inFlight: () => inFlight,
      most: () => most,
      release: () => gates.shift()?.(),
    };
  }
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

  it(`lets at most ${MAX_CONCURRENT_IMAGES} avatar and preview decodes run at once, together`, async () => {
    const fake = gatedSharp();
    // Both on their default limiter: the process's one.
    const avatar = imageProcessor(quiet, fake.load);
    const preview = previewMaker(quiet, fake.load);
    const all = Promise.all([
      avatar(Buffer.from('a')),
      preview('/p1.png'),
      avatar(Buffer.from('b')),
      preview('/p2.png'),
    ]);
    for (let left = 4; left > 0; left--) {
      await settle();
      expect(fake.inFlight()).toBe(Math.min(MAX_CONCURRENT_IMAGES, left));
      fake.release();
    }
    await all;
    expect(fake.most()).toBe(MAX_CONCURRENT_IMAGES);
  });
});

// ---------------------------------------------------------------------------------------------
// The job, on fakes

const FILE = '01940000-0000-7000-8000-00000000f11e';
const ATTACHMENT = '01940000-0000-7000-8000-0000000000a7';
const UPLOADER = '01940000-0000-7000-8000-00000000ada1';
const OLD_PREVIEW = '01940000-0000-7000-8000-0000000000b1';
const NEW_PREVIEW = '01940000-0000-7000-8000-0000000000b2';

interface JobState {
  readonly blobs: BlobStore;
  readonly inserted: NewFile[];
  readonly statements: string[];
  readonly executed: { op: string; input: unknown; kind: string }[];
  readonly warnings: { object: object; message: string }[];
  readonly made: string[];
  target: PreviewTarget | undefined;
  sourceGone: boolean;
  /** A preview row another run committed after this one's read (an expired job's retry). */
  raced: string | null;
  answer: ExecuteResult;
}
type JobWorld = JobState & { readonly deps: PreviewJobDeps };

async function jobWorld(
  image: PreviewImage = { kind: 'made', bytes: Buffer.from('webp bytes'), width: 800, height: 600 },
): Promise<JobWorld> {
  const blobs = localBlobStore(path.join(dir, 'uploads'));
  const key = await blobs.put(Buffer.from('the original'));
  const world: JobState = {
    blobs,
    inserted: [],
    statements: [],
    executed: [],
    warnings: [],
    made: [],
    target: {
      attachmentId: ATTACHMENT,
      previewFileId: null,
      storageKey: key,
      mimeType: 'image/jpeg',
      name: 'holiday.photo.jpg',
      uploaderId: UPLOADER,
      existingPreviewId: null,
    },
    sourceGone: false,
    raced: null,
    answer: { ok: true, result: {} },
  };
  const unexpected = () => Promise.reject(new Error('Not a statement a preview makes.'));
  const tx: FileTx = {
    lockFiles(ids, mode) {
      world.statements.push(`${mode} ${ids.join(',')}`);
      return Promise.resolve(world.sourceGone ? [] : ids.map((id) => ({ id, storageKey: key })));
    },
    lockKeys(keys) {
      world.statements.push(`keys ${keys.length}`);
      return Promise.resolve();
    },
    insertFile(file) {
      world.statements.push(`insert ${file.id}`);
      world.inserted.push(file);
      return Promise.resolve();
    },
    lockPreviews(ids) {
      world.statements.push(`previews ${ids.join(',')}`);
      const raced = world.raced;
      return Promise.resolve(
        raced === null ? [] : [{ id: raced, storageKey: 'sha256/00/raced', previewOf: FILE }],
      );
    },
    claimInline: unexpected,
    deleteFiles: unexpected,
    releaseKeys: unexpected,
    keyInUse: unexpected,
    forgetKey: unexpected,
    cleanupCandidates: unexpected,
    savepoint: unexpected,
  };
  const files: FileDb = {
    transaction: (fn) => fn(tx),
    releasedKeys: unexpected,
    keysInUse: unexpected,
  };
  const executor: Pick<Executor, 'execute'> = {
    execute(op, input, actor) {
      world.executed.push({ op, input, kind: actor.kind });
      return Promise.resolve(world.answer);
    },
  };
  return Object.assign(world, {
    deps: {
      db: { target: () => Promise.resolve(world.target) },
      files,
      blobs,
      executor,
      make: (file: string) => {
        world.made.push(file);
        return Promise.resolve(image);
      },
      log: {
        debug: () => undefined,
        warn: (object: object, message: string) => void world.warnings.push({ object, message }),
      },
      newId: () => NEW_PREVIEW,
    } satisfies PreviewJobDeps,
  });
}

async function temps(blobs: BlobStore): Promise<string[]> {
  const found: string[] = [];
  for await (const temp of blobs.listTemps()) found.push(temp.tempPath);
  return found;
}

describe('the files-preview job (AC-12, E21)', () => {
  it('stores the preview through the byte protocol, then names it with attachment.setPreview as the system', async () => {
    const w = await jobWorld();
    expect(await makePreview(w.deps, FILE)).toBe('made');
    // Read from its path on the volume, never loaded whole.
    expect(w.made).toEqual([w.blobs.localPath(w.target?.storageKey ?? '')]);
    // The source FOR UPDATE (one run at a time per file), its previews, then FOR SHARE, the key
    // and the row (§4.5 step 3).
    expect(w.statements).toEqual([
      `update ${FILE}`,
      `previews ${FILE}`,
      `share ${FILE}`,
      'keys 1',
      `insert ${NEW_PREVIEW}`,
    ]);
    const [row] = w.inserted;
    expect(row?.storageKey).toMatch(/^sha256\//);
    expect(row).toEqual({
      id: NEW_PREVIEW,
      storageKey: row?.storageKey,
      purpose: 'preview',
      name: 'holiday.photo.webp',
      mimeType: 'image/webp',
      size: Buffer.byteLength('webp bytes'),
      // The source's uploader: the column is NOT NULL and the system has no user (§4.2).
      uploaderId: UPLOADER,
      issueId: null,
      width: 800,
      height: 600,
      previewOf: FILE,
    });
    expect(await w.blobs.get(row?.storageKey ?? '')).toEqual(Buffer.from('webp bytes'));
    expect(await temps(w.blobs)).toEqual([]);
    expect(w.executed).toEqual([
      {
        op: 'attachment.setPreview',
        input: { attachment: ATTACHMENT, previewFile: NEW_PREVIEW },
        kind: 'system',
      },
    ]);
    expect(systemActor().kind).toBe('system');
  });

  it('does nothing when the attachment or its file is gone', async () => {
    const w = await jobWorld();
    w.target = undefined;
    expect(await makePreview(w.deps, FILE)).toBe('gone');
    expect([w.made, w.statements, w.executed]).toEqual([[], [], []]);
  });

  it('does nothing on a re-run after success', async () => {
    const w = await jobWorld();
    expect(await makePreview(w.deps, FILE)).toBe('made');
    w.target = w.target && {
      ...w.target,
      previewFileId: NEW_PREVIEW,
      existingPreviewId: NEW_PREVIEW,
    };
    w.statements.length = 0;
    w.executed.length = 0;
    w.made.length = 0;
    expect(await makePreview(w.deps, FILE)).toBe('already');
    expect([w.made, w.statements, w.executed]).toEqual([[], [], []]);
  });

  it('names the preview made before a removal again when the file is re-attached', async () => {
    const w = await jobWorld();
    w.target = w.target && { ...w.target, existingPreviewId: OLD_PREVIEW };
    expect(await makePreview(w.deps, FILE)).toBe('reused');
    expect([w.made, w.statements]).toEqual([[], []]);
    expect(w.executed).toEqual([
      {
        op: 'attachment.setPreview',
        input: { attachment: ATTACHMENT, previewFile: OLD_PREVIEW },
        kind: 'system',
      },
    ]);
  });

  it('names the row of a run that committed first instead of adding a second (an expired job’s retry)', async () => {
    const w = await jobWorld();
    w.raced = OLD_PREVIEW;
    expect(await makePreview(w.deps, FILE)).toBe('reused');
    expect(w.statements).toEqual([`update ${FILE}`, `previews ${FILE}`]);
    expect(w.inserted).toEqual([]);
    expect(await temps(w.blobs)).toEqual([]);
    expect(w.executed).toEqual([
      {
        op: 'attachment.setPreview',
        input: { attachment: ATTACHMENT, previewFile: OLD_PREVIEW },
        kind: 'system',
      },
    ]);
  });

  it('makes none for a file that isn’t a raster image', async () => {
    const w = await jobWorld();
    w.target = w.target && { ...w.target, mimeType: 'application/pdf' };
    expect(await makePreview(w.deps, FILE)).toBe('not an image');
    expect([w.made, w.statements, w.executed]).toEqual([[], [], []]);
  });

  it('inserts nothing and removes its temporary file when the source was deleted meanwhile (E21)', async () => {
    const w = await jobWorld();
    w.sourceGone = true;
    expect(await makePreview(w.deps, FILE)).toBe('gone');
    expect(w.statements).toEqual([`update ${FILE}`]);
    expect(w.inserted).toEqual([]);
    expect(w.executed).toEqual([]);
    expect(await temps(w.blobs)).toEqual([]);
  });

  it('leaves the preview row when the attachment was removed before setPreview ran', async () => {
    const w = await jobWorld();
    w.answer = { ok: false, error: { code: 'NOT_FOUND', message: 'gone', correlationId: 'c1' } };
    expect(await makePreview(w.deps, FILE)).toBe('gone');
    expect(w.inserted).toHaveLength(1);
  });

  it('fails the run on any other setPreview answer, so pg-boss retries it', async () => {
    const w = await jobWorld();
    w.answer = { ok: false, error: { code: 'INTERNAL', message: 'boom', correlationId: 'c2' } };
    await expect(makePreview(w.deps, FILE)).rejects.toThrow('attachment.setPreview failed');
  });

  it.each([
    ['too large', 'over 25 MP (E14)'],
    ['unreadable', 'that can’t be decoded'],
    ['unavailable', 'while sharp can’t load (E10)'],
  ] as const)(
    'skips an image %s, %s, logging file preview failed with no error',
    async (reason, _why) => {
      const w = await jobWorld({ kind: 'skipped', reason });
      expect(await makePreview(w.deps, FILE)).toBe(`skipped: ${reason}`);
      expect(w.warnings).toEqual([
        { object: { fileId: FILE, reason }, message: 'file preview failed' },
      ]);
      expect([w.statements, w.executed]).toEqual([[], []]);
    },
  );

  it('ignores a job without a file id, logging it', async () => {
    const w = await jobWorld();
    const run = previewJobHandler(w.deps);
    expect(await run({ nope: true })).toBeUndefined();
    expect(w.warnings.map((line) => line.message)).toEqual(['file preview job has no file id']);
    expect(await run({ fileId: FILE })).toBe('made');
  });

  it('skips a file the volume has no path for, logging it, without failing', async () => {
    const w = await jobWorld();
    w.target = w.target && { ...w.target, storageKey: 'not-a-key' };
    expect(await makePreview(w.deps, FILE)).toBe('skipped: unreadable');
    expect(w.made).toEqual([]);
    expect(w.warnings.map((line) => line.message)).toEqual(['file preview failed']);
  });

  it('reads originals from the local volume by path; the memory store has none', async () => {
    const root = path.join(dir, 'volume');
    const key = await localBlobStore(root).put(Buffer.from('x'));
    expect(localBlobStore(root).localPath(key)).toBe(path.join(root, ...key.split('/')));
    expect(localBlobStore(root).localPath('../../etc/passwd')).toBeUndefined();
    expect(memoryBlobStore().localPath(key)).toBeUndefined();
  });

  it('names a preview after its original', () => {
    expect(previewName('screenshot.png')).toBe('screenshot.webp');
    expect(previewName('.hidden')).toBe('.hidden.webp');
    expect(previewName('no extension')).toBe('no extension.webp');
  });
});
