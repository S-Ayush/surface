// PLAN-014 S2: location metadata is stripped from uploaded images while they stream, with no
// decode and no change to the pixels (SPEC-014 §4.8, AC-13, D3, D24, E20, E25). Fixtures are made
// with the real sharp (in-process) and by hand where sharp can't write the case.
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import fc from 'fast-check';
import sharp, { type Metadata } from 'sharp';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { UnreadableImage, type ImageType } from '../src/files/image.js';
import { IMAGE_UNREADABLE_MESSAGE } from '../src/files/routes.js';
import { locationStripper } from '../src/files/strip-location.js';
import { fileHarness, type Harness } from './files-harness.js';

// ---------------------------------------------------------------------------------------------
// Fixtures

const XMP =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  '<rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="51,30.0N"/>' +
  '</rdf:RDF></x:xmpmeta>';
const GPS_EXIF = {
  IFD0: { Copyright: 'Ada' },
  IFD3: {
    GPSLatitudeRef: 'N',
    GPSLatitude: '51/1 30/1 0/1',
    GPSLongitudeRef: 'W',
    GPSLongitude: '0/1 7/1 0/1',
  },
};

/** A small image with some structure, so a wrong byte would change decoded pixels. */
function base() {
  const width = 48;
  const height = 32;
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 37) % 256;
  return sharp(raw, { raw: { width, height, channels: 3 } });
}

const ascii = (text: string) => Buffer.from(text, 'latin1');

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([ascii(type), data])));
  return Buffer.concat([length, ascii(type), data, crc]);
}

/** `chunks` inserted after a PNG's IHDR (8 signature bytes + 25 IHDR bytes). */
const afterIhdr = (png: Buffer, ...chunks: Buffer[]) =>
  Buffer.concat([png.subarray(0, 33), ...chunks, png.subarray(33)]);

/** An EXIF segment payload in big-endian (Motorola) order, with orientation and a GPS IFD. */
function bigEndianExif(): Buffer {
  const tiff = Buffer.alloc(8 + 2 + 2 * 12 + 4 + 2 + 2 * 12 + 4 + 24);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(8, 4);
  let at = 8;
  tiff.writeUInt16BE(2, at); // IFD0: 2 entries
  const gpsIfd = 8 + 2 + 24 + 4;
  // Orientation, SHORT, 1, value 6.
  tiff.writeUInt16BE(0x0112, at + 2);
  tiff.writeUInt16BE(3, at + 4);
  tiff.writeUInt32BE(1, at + 6);
  tiff.writeUInt16BE(6, at + 10);
  // GPSInfo, LONG, 1, offset.
  tiff.writeUInt16BE(0x8825, at + 14);
  tiff.writeUInt16BE(4, at + 16);
  tiff.writeUInt32BE(1, at + 18);
  tiff.writeUInt32BE(gpsIfd, at + 22);
  tiff.writeUInt32BE(0, at + 26); // no IFD1
  at = gpsIfd;
  const values = gpsIfd + 2 + 24 + 4;
  tiff.writeUInt16BE(2, at);
  // GPSLatitudeRef, ASCII, 2, "N\0" inline.
  tiff.writeUInt16BE(0x0001, at + 2);
  tiff.writeUInt16BE(2, at + 4);
  tiff.writeUInt32BE(2, at + 6);
  tiff.write('N', at + 10, 'latin1');
  // GPSLatitude, RATIONAL, 3, at `values`.
  tiff.writeUInt16BE(0x0002, at + 14);
  tiff.writeUInt16BE(5, at + 16);
  tiff.writeUInt32BE(3, at + 18);
  tiff.writeUInt32BE(values, at + 22);
  [51, 1, 30, 1, 7, 1].forEach((n, i) => tiff.writeUInt32BE(n, values + 4 * i));
  return Buffer.concat([ascii('Exif\0\0'), tiff]);
}

function jpegSegment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}
/** `segments` inserted after a JPEG's SOI. */
const afterSoi = (jpeg: Buffer, ...segments: Buffer[]) =>
  Buffer.concat([jpeg.subarray(0, 2), ...segments, jpeg.subarray(2)]);

/** A GIF's header, logical screen descriptor and global colour table length. */
function gifHeaderLength(gif: Buffer): number {
  const packed = gif[10] ?? 0;
  return 13 + (packed & 0x80 ? 3 << ((packed & 7) + 1) : 0);
}
function gifApplication(id: string, data: Buffer): Buffer {
  const blocks: Buffer[] = [];
  for (let at = 0; at < data.length; at += 255) {
    const piece = data.subarray(at, at + 255);
    blocks.push(Buffer.from([piece.length]), piece);
  }
  return Buffer.concat([Buffer.from([0x21, 0xff, 11]), ascii(id), ...blocks, Buffer.from([0])]);
}
const afterGifHeader = (gif: Buffer, ...blocks: Buffer[]) => {
  const at = gifHeaderLength(gif);
  return Buffer.concat([gif.subarray(0, at), ...blocks, gif.subarray(at)]);
};

const fixtures: Record<string, { type: ImageType; bytes: Buffer }> = {};
beforeAll(async () => {
  const jpeg = await base().withExif(GPS_EXIF).withXmp(XMP).jpeg().toBuffer();
  const plainJpeg = await base().jpeg().toBuffer();
  const png = await base().withExif(GPS_EXIF).withXmp(XMP).png().toBuffer();
  const plainPng = await base().png().toBuffer();
  const webp = await base().withExif(GPS_EXIF).withXmp(XMP).webp({ lossless: true }).toBuffer();
  const plainWebp = await base().webp({ lossless: true }).toBuffer();
  const gif = await base().gif().toBuffer();
  Object.assign(fixtures, {
    jpeg: { type: 'image/jpeg', bytes: jpeg },
    plainJpeg: { type: 'image/jpeg', bytes: plainJpeg },
    // Orientation 6 and a GPS IFD with a RATIONAL value, in big-endian order, plus extended XMP.
    motorolaJpeg: {
      type: 'image/jpeg',
      bytes: afterSoi(
        plainJpeg,
        jpegSegment(0xe1, bigEndianExif()),
        jpegSegment(
          0xe1,
          Buffer.concat([ascii('http://ns.adobe.com/xmp/extension/\0'), ascii(XMP)]),
        ),
      ),
    },
    png: {
      type: 'image/png',
      bytes: afterIhdr(
        png,
        pngChunk('iTXt', Buffer.concat([ascii('XML:com.adobe.xmp\0\0\0\0\0'), ascii(XMP)])),
        pngChunk(
          'tEXt',
          Buffer.concat([ascii('Raw profile type exif\0'), ascii('\nexif\n 10\n4578696600\n')]),
        ),
        pngChunk('tEXt', Buffer.concat([ascii('Comment\0'), ascii('kept')])),
      ),
    },
    plainPng: { type: 'image/png', bytes: plainPng },
    webp: { type: 'image/webp', bytes: webp },
    plainWebp: { type: 'image/webp', bytes: plainWebp },
    gif: {
      type: 'image/gif',
      bytes: afterGifHeader(
        gif,
        gifApplication('NETSCAPE2.0', Buffer.from([1, 0, 0])),
        gifApplication('XMP DataXMP', ascii(XMP)),
      ),
    },
    plainGif: { type: 'image/gif', bytes: gif },
  });
});

const fixture = (name: string) => {
  const found = fixtures[name];
  if (!found) throw new Error(`No fixture ${name}`);
  return found;
};

/** Runs the stripper over `bytes` in the given chunk sizes, with its patch applied. */
function strip(type: ImageType, bytes: Buffer, sizes: readonly number[] = [bytes.length]): Buffer {
  const stripper = locationStripper(type);
  const out: Buffer[] = [];
  let at = 0;
  let i = 0;
  while (at < bytes.length) {
    const size = Math.max(1, sizes[i % sizes.length] ?? bytes.length);
    out.push(...stripper.write(bytes.subarray(at, at + size)));
    at += size;
    i += 1;
  }
  out.push(...stripper.end());
  const result = Buffer.concat(out);
  const patch = stripper.patch();
  if (patch) result.set(patch.bytes, patch.offset);
  return result;
}

const pixels = (bytes: Buffer) => sharp(bytes).raw().toBuffer();

/** Entries in the GPS IFD of an EXIF block (`Exif\0\0` + TIFF), or 0 without one; read independently of the stripper. */
function gpsEntries(exif: Buffer | undefined): number {
  if (exif === undefined) return 0;
  const tiff = exif.subarray(exif.indexOf('Exif\0\0', 0, 'latin1') + 6);
  const le = tiff.toString('latin1', 0, 2) === 'II';
  const u16 = (o: number) => (le ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o: number) => (le ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const ifd0 = u32(4);
  for (let i = 0; i < u16(ifd0); i++) {
    const entry = ifd0 + 2 + 12 * i;
    if (u16(entry) === 0x8825) return u16(u32(entry + 8));
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------

describe('stripping location metadata (AC-13, E20)', () => {
  it('JPEG: empties the GPS IFD, keeps the rest of EXIF, drops XMP; pixels unchanged', async () => {
    const { type, bytes } = fixture('jpeg');
    const before = await sharp(bytes).metadata();
    expect(gpsEntries(before.exif)).toBeGreaterThan(0);
    expect(before.xmp).toBeDefined();
    const after = strip(type, bytes);
    const meta = await sharp(after).metadata();
    expect(gpsEntries(meta.exif)).toBe(0);
    expect(meta.exif?.includes('Ada')).toBe(true);
    expect(meta.xmp).toBeUndefined();
    expect(after.includes('xmpmeta')).toBe(false);
    expect(await pixels(after)).toEqual(await pixels(bytes));
  });

  it('JPEG: keeps the orientation, clears a big-endian GPS IFD with its values, drops extended XMP', async () => {
    const { type, bytes } = fixture('motorolaJpeg');
    expect((await sharp(bytes).metadata()).orientation).toBe(6);
    const after = strip(type, bytes);
    const meta = await sharp(after).metadata();
    expect(meta.orientation).toBe(6);
    expect(gpsEntries(meta.exif)).toBe(0);
    // The latitude's RATIONAL values (51/1 30/1 7/1) are zeroed, not just unreferenced.
    const rational = Buffer.alloc(8);
    rational.writeUInt32BE(51, 0);
    rational.writeUInt32BE(1, 4);
    expect(bytes.includes(rational)).toBe(true);
    expect(after.includes(rational)).toBe(false);
    expect(after.includes('xmp/extension')).toBe(false);
    expect(after.length).toBe(bytes.length - (4 + 35 + XMP.length));
    expect(await pixels(after)).toEqual(await pixels(bytes));
  });

  it('PNG: drops eXIf and every XMP or raw EXIF text chunk, keeps other text; pixels unchanged', async () => {
    const { type, bytes } = fixture('png');
    for (const marker of ['eXIf', 'XML:com.adobe.xmp', 'Raw profile type exif']) {
      expect({ marker, found: bytes.includes(marker) }).toEqual({ marker, found: true });
    }
    const after = strip(type, bytes);
    for (const marker of ['eXIf', 'XML:com.adobe.xmp', 'Raw profile type exif', 'xmpmeta']) {
      expect({ marker, found: after.includes(marker) }).toEqual({ marker, found: false });
    }
    expect(after.includes('Comment')).toBe(true);
    const meta = await sharp(after).metadata();
    expect([meta.exif, meta.xmp]).toEqual([undefined, undefined]);
    expect(await pixels(after)).toEqual(await pixels(bytes));
  });

  it('WebP: drops EXIF and XMP chunks, clears their flags and fixes the RIFF size; pixels unchanged', async () => {
    const { type, bytes } = fixture('webp');
    expect(bytes.includes('EXIF')).toBe(true);
    const after = strip(type, bytes);
    expect(after.includes('EXIF')).toBe(false);
    expect(after.includes('XMP ')).toBe(false);
    expect(after.readUInt32LE(4)).toBe(after.length - 8);
    // VP8X flags: no EXIF (0x08) or XMP (0x04) bit.
    expect((after[20] ?? 0) & 0x0c).toBe(0);
    const meta = await sharp(after).metadata();
    expect([meta.exif, meta.xmp]).toEqual([undefined, undefined]);
    expect(await pixels(after)).toEqual(await pixels(bytes));
  });

  it('GIF: drops the XMP application extension, keeps the others; pixels unchanged', async () => {
    const { type, bytes } = fixture('gif');
    const after = strip(type, bytes);
    expect(after.includes('XMP DataXMP')).toBe(false);
    expect(after.includes('xmpmeta')).toBe(false);
    expect(after.includes('NETSCAPE2.0')).toBe(true);
    expect(await pixels(after)).toEqual(await pixels(bytes));
  });

  it.each(['plainJpeg', 'plainPng', 'plainWebp', 'plainGif'])(
    'leaves %s without location metadata byte for byte as it was',
    (name) => {
      const { type, bytes } = fixture(name);
      expect(strip(type, bytes).equals(bytes)).toBe(true);
    },
  );

  it('drops whatever follows the image, such as a second image with its own EXIF', () => {
    const jpeg = fixture('jpeg');
    const appended = Buffer.concat([fixture('plainJpeg').bytes, jpeg.bytes]);
    expect(strip('image/jpeg', appended).equals(fixture('plainJpeg').bytes)).toBe(true);
    const png = fixture('plainPng').bytes;
    expect(strip('image/png', Buffer.concat([png, ascii('trailing')])).equals(png)).toBe(true);
    const webp = fixture('plainWebp').bytes;
    expect(strip('image/webp', Buffer.concat([webp, ascii('trailing')])).equals(webp)).toBe(true);
    const gif = fixture('plainGif').bytes;
    expect(strip('image/gif', Buffer.concat([gif, ascii('trailing')])).equals(gif)).toBe(true);
  });

  it('gives the same bytes however the body is split into chunks', () => {
    const names = ['jpeg', 'motorolaJpeg', 'png', 'webp', 'gif'];
    fc.assert(
      fc.property(
        fc.constantFrom(...names),
        fc.array(fc.integer({ min: 1, max: 700 }), { minLength: 1, maxLength: 20 }),
        (name, sizes) => {
          const { type, bytes } = fixture(name);
          expect(strip(type, bytes, sizes).equals(strip(type, bytes))).toBe(true);
        },
      ),
      { seed: 20261112, numRuns: 200 },
    );
  });
});

describe('images the stripper can’t follow are refused (E25)', () => {
  it('refuses every truncated image, wherever it is cut', () => {
    const names = [
      'jpeg',
      'motorolaJpeg',
      'png',
      'webp',
      'gif',
      'plainJpeg',
      'plainPng',
      'plainWebp',
      'plainGif',
    ];
    fc.assert(
      fc.property(
        fc.constantFrom(...names),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (name, at) => {
          const { type, bytes } = fixture(name);
          const cut = Math.min(bytes.length - 1, Math.floor(at * bytes.length));
          expect(() => strip(type, bytes.subarray(0, cut), [97])).toThrow(UnreadableImage);
        },
      ),
      { seed: 20261112, numRuns: 300 },
    );
  });

  it.each([
    [
      'a PNG whose first chunk isn’t IHDR',
      'image/png',
      () => {
        const png = fixture('plainPng').bytes;
        return Buffer.concat([
          png.subarray(0, 8),
          pngChunk('tEXt', ascii('a\0b')),
          png.subarray(8),
        ]);
      },
    ],
    [
      'a PNG chunk with an impossible length',
      'image/png',
      () => {
        const png = Buffer.from(fixture('plainPng').bytes);
        png.writeUInt32BE(0xffffffff, 33);
        return png;
      },
    ],
    [
      'a JPEG with junk between segments',
      'image/jpeg',
      () => afterSoi(fixture('plainJpeg').bytes, ascii('junk')),
    ],
    [
      'a JPEG segment shorter than its length field',
      'image/jpeg',
      () => afterSoi(fixture('plainJpeg').bytes, Buffer.from([0xff, 0xe0, 0x00, 0x01])),
    ],
    [
      'an EXIF directory pointing outside its segment',
      'image/jpeg',
      () => {
        const exif = bigEndianExif();
        exif.writeUInt32BE(60_000, 6 + 4);
        return afterSoi(fixture('plainJpeg').bytes, jpegSegment(0xe1, exif));
      },
    ],
    [
      'a WebP chunk past the RIFF size',
      'image/webp',
      () => {
        const webp = Buffer.from(fixture('plainWebp').bytes);
        webp.writeUInt32LE(webp.readUInt32LE(16) + 1000, 16);
        return webp;
      },
    ],
    [
      'a GIF with an unknown block',
      'image/gif',
      () => afterGifHeader(fixture('plainGif').bytes, Buffer.from([0x99])),
    ],
  ] as const)('refuses %s', (_name, type, make) => {
    expect(() => strip(type, make())).toThrow(UnreadableImage);
  });
});

describe('through the upload route', () => {
  let h: Harness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  it('stores a photo without its location, under the hash of the stored bytes (E20)', async () => {
    h = await fileHarness();
    for (const name of ['jpeg', 'webp', 'png']) {
      const { bytes } = fixture(name);
      const response = await h.upload(bytes, { name: `photo-${name}` });
      expect({ name, status: response.statusCode }).toEqual({ name, status: 201 });
      const row = h.files.rows.at(-1);
      const stored = await h.blobs.get(row?.storageKey ?? '');
      if (stored === undefined) throw new Error('not stored');
      expect(stored.includes('xmpmeta')).toBe(false);
      expect(gpsEntries((await sharp(stored).metadata()).exif)).toBe(0);
      expect(row?.size).toBe(stored.length);
      // The WebP's size fix is part of the hash too.
      const hash = createHash('sha256').update(stored).digest('hex');
      expect(row?.storageKey.endsWith(hash)).toBe(true);
    }
    expect(await h.temps()).toEqual([]);
  });

  it.each(['plainPng', 'plainJpeg', 'plainGif', 'plainWebp'])(
    'refuses a truncated %s with the unreadable-image message, storing nothing (E25)',
    async (name) => {
      h = await fileHarness();
      const { bytes } = fixture(name);
      const response = await h.upload(bytes.subarray(0, bytes.length - 3), { name: 'broken' });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: { code: 'INVALID_INPUT', message: IMAGE_UNREADABLE_MESSAGE },
      });
      expect(h.files.rows).toEqual([]);
      expect(await h.temps()).toEqual([]);
    },
  );
});

// Review B1: hostile structure must cost work in proportion to its bytes, and write in
// proportion to its chunks, never per byte.
describe('hostile inputs stay cheap (B1, AC-1, E13)', () => {
  const CHUNK = 64 * 1024;
  const MiB = 1024 * 1024;

  /** Feeds `bytes` in 64 KB chunks, recording the pieces each write returns. */
  function feed(type: ImageType, bytes: Buffer) {
    const stripper = locationStripper(type);
    const pieces: number[] = [];
    let error: unknown;
    try {
      for (let at = 0; at < bytes.length; at += CHUNK) {
        pieces.push(stripper.write(bytes.subarray(at, at + CHUNK)).length);
      }
      stripper.end();
    } catch (caught) {
      error = caught;
    }
    return { pieces, steps: stripper.steps(), error };
  }

  /** A JPEG of SOI, one scan header, `scan` as its entropy-coded data, and EOI. */
  const jpegWithScan = (scan: Buffer) =>
    Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      jpegSegment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
      scan,
      Buffer.from([0xff, 0xd9]),
    ]);
  const repeat = (pattern: readonly number[], bytes: number) =>
    Buffer.alloc(bytes, Buffer.from(pattern));

  it.each([
    ['stuffed 0xFF bytes', [0xff, 0x00]],
    ['restart markers', [0xff, 0xd0, 0x12, 0xff, 0xd7]],
    ['fill bytes before restart markers', [0xff, 0xff, 0xff, 0xd3]],
  ] as const)('passes a scan of %s through in a couple of pieces per chunk', (_name, pattern) => {
    const bytes = jpegWithScan(repeat(pattern, 2 * MiB));
    const { pieces, steps, error } = feed('image/jpeg', bytes);
    expect(error).toBeUndefined();
    // The first chunk also holds the headers; every later one is one or two pieces of scan.
    expect(pieces[0]).toBeLessThanOrEqual(8);
    expect(Math.max(...pieces.slice(1))).toBeLessThanOrEqual(2);
    expect(steps).toBeLessThan(50);
  });

  it.each([
    [
      'a JPEG of fill bytes outside a scan',
      'image/jpeg',
      () =>
        Buffer.concat([Buffer.from([0xff, 0xd8]), repeat([0xff], 2 * MiB), Buffer.from([0xd9])]),
    ],
    [
      'a JPEG of restart markers outside a scan',
      'image/jpeg',
      () =>
        Buffer.concat([
          Buffer.from([0xff, 0xd8]),
          repeat([0xff, 0xd0], 2 * MiB),
          Buffer.from([0xff, 0xd9]),
        ]),
    ],
    [
      'a GIF of 1-byte sub-blocks',
      'image/gif',
      () =>
        Buffer.concat([
          ascii('GIF89a'),
          Buffer.from([1, 0, 1, 0, 0, 0, 0]),
          Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2]),
          repeat([1, 0], 2 * MiB),
          Buffer.from([0, 0x3b]),
        ]),
    ],
  ] as const)('refuses %s early, its parser work bounded by its bytes', (_name, type, make) => {
    const bytes = make();
    const { pieces, steps, error } = feed(type, bytes);
    expect(error).toBeInstanceOf(UnreadableImage);
    // 4096 steps, plus one per 32 bytes read so far: refused within the first chunks.
    expect(steps).toBeLessThanOrEqual(4096 + (pieces.length + 1) * (CHUNK / 32) + 1);
    expect(pieces.length).toBeLessThan(bytes.length / CHUNK / 4);
  });
});

// SPEC-014 D27 (review m1, m4): location also hides in the Exif sub-IFD, in IFD1, in the EXIF
// thumbnail's own segments, and in Photoshop's APP13.
describe('JPEG location outside IFD0 (D27)', () => {
  /** A TIFF field: a number is stored inline; data and directories are laid out after it. */
  interface Field {
    tag: number;
    type: number;
    count: number;
    value: number | { data: Buffer } | { ifd: Ifd };
  }
  interface Ifd {
    fields: Field[];
    next?: Ifd;
  }

  /** A little-endian TIFF with `ifd0` (and what it points to) laid out in order. */
  function tiffOf(ifd0: Ifd): Buffer {
    const header = Buffer.alloc(8);
    header.write('II', 0, 'latin1');
    header.writeUInt16LE(42, 2);
    const parts: Buffer[] = [header];
    let size = 8;
    const place = (bytes: Buffer) => {
      const at = size;
      parts.push(bytes);
      size += bytes.length;
      return at;
    };
    const placeIfd = (ifd: Ifd): number => {
      const table = Buffer.alloc(2 + 12 * ifd.fields.length + 4);
      const at = place(table);
      table.writeUInt16LE(ifd.fields.length, 0);
      ifd.fields.forEach((field, i) => {
        const entry = 2 + 12 * i;
        table.writeUInt16LE(field.tag, entry);
        table.writeUInt16LE(field.type, entry + 2);
        table.writeUInt32LE(field.count, entry + 4);
        const value = field.value;
        const stored =
          typeof value === 'number'
            ? value
            : 'ifd' in value
              ? placeIfd(value.ifd)
              : place(value.data);
        table.writeUInt32LE(stored, entry + 8);
      });
      if (ifd.next) table.writeUInt32LE(placeIfd(ifd.next), 2 + 12 * ifd.fields.length);
      return at;
    };
    header.writeUInt32LE(placeIfd(ifd0), 4);
    return Buffer.concat(parts);
  }

  /** RATIONAL degrees, minutes, seconds: `degrees`/1 30/1 7/1, little-endian. */
  const latitude = (degrees: number) => {
    const data = Buffer.alloc(24);
    [degrees, 1, 30, 1, 7, 1].forEach((n, i) => data.writeUInt32LE(n, 4 * i));
    return data;
  };
  const gpsIfd = (degrees: number): Ifd => ({
    fields: [
      { tag: 0x0001, type: 2, count: 2, value: 0x4e }, // GPSLatitudeRef "N"
      { tag: 0x0002, type: 5, count: 3, value: { data: latitude(degrees) } },
    ],
  });
  const gpsPointer = (degrees: number): Field => ({
    tag: 0x8825,
    type: 4,
    count: 1,
    value: { ifd: gpsIfd(degrees) },
  });
  const orientation6: Field = { tag: 0x0112, type: 3, count: 1, value: 6 };
  const thumbnailFields = (thumbnail: Buffer): Field[] => [
    { tag: 0x0201, type: 4, count: 1, value: { data: thumbnail } },
    { tag: 0x0202, type: 4, count: 1, value: thumbnail.length },
  ];
  const exifSegment = (tiff: Buffer) => jpegSegment(0xe1, Buffer.concat([ascii('Exif\0\0'), tiff]));
  const xmpSegment = () =>
    jpegSegment(0xe1, Buffer.concat([ascii('http://ns.adobe.com/xap/1.0/\0'), ascii(XMP)]));
  /** Photoshop image resources: an XMP block (0x0424) inside APP13. */
  const photoshopSegment = () => {
    const resource = Buffer.alloc(12);
    resource.write('8BIM', 0, 'latin1');
    resource.writeUInt16BE(0x0424, 4);
    resource.writeUInt32BE(XMP.length, 8);
    return jpegSegment(
      0xed,
      Buffer.concat([ascii('Photoshop 3.0\0'), resource, ascii(XMP), Buffer.alloc(XMP.length & 1)]),
    );
  };
  const includesLatitude = (bytes: Buffer, degrees: number) => bytes.includes(latitude(degrees));

  it('clears GPS IFDs pointed to from the Exif sub-IFD and from IFD1, keeping the orientation', async () => {
    const plain = fixture('plainJpeg').bytes;
    const tiff = tiffOf({
      fields: [
        orientation6,
        { tag: 0x8769, type: 4, count: 1, value: { ifd: { fields: [gpsPointer(51)] } } },
      ],
      next: { fields: [gpsPointer(52)] },
    });
    const bytes = afterSoi(plain, exifSegment(tiff));
    expect([includesLatitude(bytes, 51), includesLatitude(bytes, 52)]).toEqual([true, true]);
    const after = strip('image/jpeg', bytes);
    expect([includesLatitude(after, 51), includesLatitude(after, 52)]).toEqual([false, false]);
    expect(after.length).toBe(bytes.length);
    expect((await sharp(after).metadata()).orientation).toBe(6);
    expect(await pixels(after)).toEqual(await pixels(bytes));
  });

  it('cleans the EXIF thumbnail: its GPS cleared, its XMP and Photoshop blocks blanked', async () => {
    const plain = fixture('plainJpeg').bytes;
    const thumbnail = afterSoi(
      plain,
      exifSegment(tiffOf({ fields: [gpsPointer(53)] })),
      xmpSegment(),
      photoshopSegment(),
    );
    const bytes = afterSoi(
      plain,
      exifSegment(tiffOf({ fields: [orientation6], next: { fields: thumbnailFields(thumbnail) } })),
    );
    expect(includesLatitude(bytes, 53)).toBe(true);
    const after = strip('image/jpeg', bytes);
    expect(includesLatitude(after, 53)).toBe(false);
    expect(after.includes('xmpmeta')).toBe(false);
    expect(after.length).toBe(bytes.length);
    // The thumbnail stays where it was, the same length, and still decodes to the same pixels.
    const at = bytes.indexOf(thumbnail);
    const cleaned = after.subarray(at, at + thumbnail.length);
    expect(await pixels(cleaned)).toEqual(await pixels(thumbnail));
    expect((await sharp(after).metadata()).orientation).toBe(6);
    expect(await pixels(after)).toEqual(await pixels(bytes));
  });

  it('cleans a thumbnail inside a thumbnail, and blanks one nested deeper', () => {
    const plain = fixture('plainJpeg').bytes;
    const nest = (inner: Buffer, degrees: number) =>
      afterSoi(
        plain,
        exifSegment(
          tiffOf({ fields: [gpsPointer(degrees)], next: { fields: thumbnailFields(inner) } }),
        ),
      );
    const deepest = nest(plain, 57);
    const bytes = afterSoi(
      plain,
      exifSegment(
        tiffOf({
          fields: [orientation6],
          next: { fields: thumbnailFields(nest(nest(deepest, 56), 55)) },
        }),
      ),
    );
    for (const degrees of [55, 56, 57]) expect(includesLatitude(bytes, degrees)).toBe(true);
    const after = strip('image/jpeg', bytes);
    for (const degrees of [55, 56, 57]) {
      expect({ degrees, found: includesLatitude(after, degrees) }).toEqual({
        degrees,
        found: false,
      });
    }
    expect(after.length).toBe(bytes.length);
  });

  it('blanks an EXIF thumbnail it can’t follow, instead of keeping what it holds', () => {
    const plain = fixture('plainJpeg').bytes;
    const junk = Buffer.concat([ascii('not a JPEG'), latitude(54)]);
    const bytes = afterSoi(
      plain,
      exifSegment(tiffOf({ fields: [orientation6], next: { fields: thumbnailFields(junk) } })),
    );
    const after = strip('image/jpeg', bytes);
    expect(includesLatitude(after, 54)).toBe(false);
    expect(after.includes('not a JPEG')).toBe(false);
    expect(after.length).toBe(bytes.length);
  });

  it('clears GPS in an EXIF segment whose header padding isn’t zeros, as readers accept it', () => {
    // libvips (and so sharp) reads any APP1 starting with `Exif` as EXIF.
    const exif = bigEndianExif();
    exif.write('X', 5, 'latin1');
    const bytes = afterSoi(fixture('plainJpeg').bytes, jpegSegment(0xe1, exif));
    const rational = Buffer.from([0, 0, 0, 51, 0, 0, 0, 1]);
    expect(bytes.includes(rational)).toBe(true);
    const after = strip('image/jpeg', bytes);
    expect(after.includes(rational)).toBe(false);
    expect(after.length).toBe(bytes.length);
  });

  it('drops a Photoshop APP13 segment whole', () => {
    const plain = fixture('plainJpeg').bytes;
    const after = strip('image/jpeg', afterSoi(plain, photoshopSegment()));
    expect(after.equals(plain)).toBe(true);
  });
});

// Review m5: damaged files must end in one of two ways, refused as unreadable or stored without
// location that a reader (libvips, through sharp) can find.
describe('damaged images (m5, E25)', () => {
  const NAMES = ['jpeg', 'motorolaJpeg', 'png', 'webp', 'gif'];

  /** GPS entries as a reader would find them; a structure no reader can follow has none. */
  function readableGpsEntries(exif: Buffer | undefined): number {
    try {
      return gpsEntries(exif);
    } catch (error) {
      if (error instanceof RangeError) return 0;
      throw error;
    }
  }

  const damage = fc.record({
    name: fc.constantFrom(...NAMES),
    donor: fc.constantFrom(...NAMES),
    flips: fc.array(
      fc.tuple(fc.double({ min: 0, max: 1, noNaN: true }), fc.integer({ min: 0, max: 255 })),
      {
        maxLength: 6,
      },
    ),
    splice: fc.option(
      fc.tuple(
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 0, max: 400 }),
        fc.integer({ min: 0, max: 400 }),
      ),
    ),
  });

  it('refuses a damaged image as unreadable, or stores it with no location a reader finds', async () => {
    await fc.assert(
      fc.asyncProperty(damage, async ({ name, donor, flips, splice }) => {
        const { type, bytes: original } = fixture(name);
        let bytes = Buffer.from(original);
        for (const [where, value] of flips) {
          bytes[Math.min(bytes.length - 1, Math.floor(where * bytes.length))] = value;
        }
        if (splice) {
          const [where, from, drop, take] = splice;
          const other = fixture(donor).bytes;
          const at = Math.floor(where * bytes.length);
          const start = Math.floor(from * other.length);
          bytes = Buffer.concat([
            bytes.subarray(0, at),
            other.subarray(start, start + take),
            bytes.subarray(at + drop),
          ]);
        }
        let after: Buffer;
        try {
          after = strip(type, bytes, [4096]);
        } catch (error) {
          expect(error).toBeInstanceOf(UnreadableImage);
          return;
        }
        let meta: Metadata;
        try {
          meta = await sharp(after).metadata();
        } catch {
          return; // libvips can't read it either, so there is nothing to find.
        }
        expect(meta.xmp).toBeUndefined();
        expect(readableGpsEntries(meta.exif)).toBe(0);
      }),
      { seed: 20261112, numRuns: 400 },
    );
  });
});
