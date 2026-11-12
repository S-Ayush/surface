// PLAN-014 S2: `GET /files/:id` headers and streaming (SPEC-014 §4.8, AC-3, E4, D17): only the
// four raster image types and previews show inline; everything else downloads under its name,
// with an RFC 6266 fallback; every file has the `sandbox` CSP and `nosniff`.
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { localBlobStore, type BlobStore } from '../src/files/blob-store.js';
import { ADA, fileHarness, type Harness } from './files-harness.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

let png: Buffer;
beforeAll(async () => {
  png = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#c33' } })
    .png()
    .toBuffer();
});

async function uploaded(
  body: Buffer | string,
  name: string,
  options: Parameters<typeof fileHarness>[0] = {},
) {
  h = await fileHarness(options);
  const response = await h.upload(body, { name });
  expect(response.statusCode).toBe(201);
  return { h, id: response.json<{ result: { id: string } }>().result.id };
}

const SAFE = {
  'content-security-policy': "default-src 'none'; sandbox",
  'x-content-type-options': 'nosniff',
  'cache-control': 'private, no-cache',
};

describe('GET /files/:id headers (AC-3)', () => {
  it('shows a raster image inline, with the safe headers and its length', async () => {
    const { h, id } = await uploaded(png, 'chart.png');
    const response = await h.get(id);
    expect(response.statusCode).toBe(200);
    expect(response.headers).toMatchObject({
      ...SAFE,
      'content-type': 'image/png',
      'content-disposition': 'inline',
      'content-length': String(png.length),
      etag: expect.stringMatching(/^"[0-9a-f]{64}"$/) as unknown,
    });
    expect(response.rawPayload.equals(png)).toBe(true);
  });

  it('downloads an image with ?download=1, under its name', async () => {
    const { h, id } = await uploaded(png, 'chart.png');
    const response = await h.get(id, { query: '?download=1' });
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="chart.png"; filename*=UTF-8''chart.png`,
    );
    expect(response.headers['content-type']).toBe('image/png');
  });

  it('serves HTML and SVG as plain text, as a download, never as a page (E4)', async () => {
    for (const [name, body] of [
      ['page.html', '<!doctype html><script>alert(document.cookie)</script>'],
      ['logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ] as const) {
      const { h, id } = await uploaded(body, name);
      const response = await h.get(id);
      expect(response.headers).toMatchObject({
        ...SAFE,
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename="${name}"; filename*=UTF-8''${name}`,
      });
      expect(response.body).toBe(body);
      await h.close();
    }
    h = undefined;
  });

  it('downloads a PDF and anything else, never inline (D17)', async () => {
    const { h, id } = await uploaded('%PDF-1.7\n%%EOF\n', 'spec.pdf');
    const response = await h.get(id);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-disposition']).toMatch(/^attachment; /);
  });

  it('gives a non-ASCII name an ASCII fallback and the exact name in filename* (RFC 6266)', async () => {
    const { h, id } = await uploaded('notes', 'Grüße "2026".txt');
    expect((await h.get(id)).headers['content-disposition']).toBe(
      `attachment; filename="Gr__e _2026_.txt"; filename*=UTF-8''Gr%C3%BC%C3%9Fe%20%222026%22.txt`,
    );
  });

  it('shows a preview inline, and downloads it with ?download=1', async () => {
    h = await fileHarness();
    const storageKey = await h.blobs.put(png);
    const id = randomUUID();
    h.files.rows.push({
      id,
      storageKey,
      purpose: 'preview',
      name: 'preview.webp',
      mimeType: 'image/webp',
      size: png.length,
      uploaderId: ADA,
      previewOf: randomUUID(),
    });
    expect((await h.get(id)).headers['content-disposition']).toBe('inline');
    expect((await h.get(id, { query: '?download=1' })).headers['content-disposition']).toMatch(
      /^attachment; filename="preview.webp"/,
    );
  });

  it('answers HEAD with the same headers and no body, without opening the bytes', async () => {
    let opened = 0;
    const { h, id } = await uploaded('some text', 'a.txt', {
      blobs: (root) => {
        const real = localBlobStore(root);
        const counting: BlobStore = {
          ...real,
          getStream: (key) => {
            opened += 1;
            return real.getStream(key);
          },
        };
        return counting;
      },
    });
    const get = await h.get(id);
    expect(opened).toBe(1);
    const head = await h.get(id, { method: 'HEAD' });
    expect(opened).toBe(1);
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe('');
    for (const name of [
      'content-type',
      'content-disposition',
      'content-length',
      'etag',
      'cache-control',
      'content-security-policy',
      'x-content-type-options',
    ]) {
      expect({ name, value: head.headers[name] }).toEqual({ name, value: get.headers[name] });
    }
  });

  it('answers a matching If-None-Match with 304 and no body, without opening the bytes', async () => {
    let opened = 0;
    const { h, id } = await uploaded('some text', 'a.txt', {
      blobs: (root) => {
        const real = localBlobStore(root);
        const counting: BlobStore = {
          ...real,
          getStream: (key) => {
            opened += 1;
            return real.getStream(key);
          },
        };
        return counting;
      },
    });
    const etag = (await h.get(id)).headers.etag;
    expect(opened).toBe(1);
    const again = await h.get(id, { headers: { 'if-none-match': String(etag) } });
    expect(opened).toBe(1);
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    expect(again.headers.etag).toBe(etag);
    expect(again.headers['cache-control']).toBe('private, no-cache');
    expect(again.headers['content-disposition']).toBeUndefined();
    expect(again.headers['content-length']).toBeUndefined();
    // A row without its bytes is not confirmed by a 304 either.
    await h.blobs.delete(h.files.rows[0]?.storageKey ?? '');
    const gone = await h.get(id, { headers: { 'if-none-match': String(etag) } });
    expect(gone.statusCode).toBe(404);
    expect(gone.headers.etag).toBeUndefined();
  });

  it('streams a large file whole', async () => {
    const pattern = Buffer.from(Array.from({ length: 251 }, (_, i) => (i * 31) % 251));
    const big = Buffer.alloc(3 * 1024 * 1024 + 7, pattern);
    const { h, id } = await uploaded(big, 'data.bin');
    const response = await h.get(id);
    expect(response.headers['content-type']).toBe('application/octet-stream');
    expect(response.headers['content-length']).toBe(String(big.length));
    expect(response.rawPayload.equals(big)).toBe(true);
  });

  it('answers a row without its bytes exactly like a missing file: no file headers (PLAN-014 S1 note)', async () => {
    const { h, id } = await uploaded('soon gone', 'a.txt');
    const key = h.files.rows[0]?.storageKey ?? '';
    await h.blobs.delete(key);
    const gone = await h.get(id);
    const missing = await h.get(randomUUID());
    expect(gone.statusCode).toBe(404);
    const strip = (headers: Record<string, unknown>) => {
      const { date: _date, ...rest } = headers;
      return rest;
    };
    expect(strip(gone.headers)).toEqual(strip(missing.headers));
    expect(gone.headers.etag).toBeUndefined();
    expect(gone.headers['content-disposition']).toBeUndefined();
    const body = (text: string) => {
      const parsed = JSON.parse(text) as { error: { correlationId?: string } };
      delete parsed.error.correlationId;
      return parsed;
    };
    expect(body(gone.body)).toEqual(body(missing.body));
    expect(h.logs.lines).toContainEqual(
      expect.objectContaining({ msg: 'file row without its bytes', fileId: id }),
    );
  });
});
