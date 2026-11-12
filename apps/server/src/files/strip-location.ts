/**
 * Removes location metadata from attachment and inline images while they stream, without decoding
 * them and without touching image data (SPEC-014 §4.8, D3, D24, D27, E20, E25):
 *
 * - JPEG keeps its EXIF segment (orientation, colour) with every GPS IFD overwritten in place (from
 *   IFD0, IFD1 or the Exif sub-IFD) and its thumbnail cleaned the same way, and drops its XMP
 *   segments (standard and extended) and Photoshop's APP13;
 * - PNG drops `eXIf` chunks and XMP text chunks (`XML:com.adobe.xmp` in `iTXt`, and in `zTXt` or
 *   `tEXt`, where libvips and ImageMagick put it), and ImageMagick's raw EXIF and XMP profiles;
 * - WebP drops its `EXIF` and `XMP ` chunks, clears their VP8X flags, and fixes the RIFF size;
 * - GIF has no EXIF; its XMP application extension is dropped.
 *
 * Every format is parsed structurally, and bytes after the image's end (after JPEG's EOI, PNG's
 * IEND, the RIFF size, GIF's trailer) are dropped: a second image appended there could carry its
 * own location. That loses MPF secondary images, Ultra HDR gain maps and Motion Photo video (D27). A file whose structure can't be followed is refused (`UnreadableImage`), never
 * stored with its metadata (E25).
 *
 * The stripper is incremental: `write(chunk)` returns the bytes to store so far, `end()` the rest.
 * It holds at most one metadata unit it must rewrite (a JPEG EXIF segment, at most 64 KB by the
 * format) or a few header bytes; image data passes straight through, so a 25 MB file never sits in
 * memory. It is not a Node `Transform`: the upload runs it inside its one read-write loop
 * (`upload-body.ts`), so no stream buffers sit between the socket and the disk.
 */
import { UnreadableImage, type ImageType } from './image.js';

/** Bytes to overwrite in the written file once the whole body is through (WebP's RIFF size). */
export interface Patch {
  readonly offset: number;
  readonly bytes: Uint8Array;
}

export interface LocationStripper {
  write(chunk: Buffer): Buffer[];
  /** Throws `UnreadableImage` if the image ended early. */
  end(): Buffer[];
  /** After `end()`: a fix-up for bytes already written, if the format needs one. */
  patch(): Patch | undefined;
  /** Parser steps run so far (bounded by the bytes read, see `stepBudget`). */
  steps(): number;
}

type Step =
  | { kind: 'take'; n: number }
  | { kind: 'pass'; n: number }
  | { kind: 'skip'; n: number }
  | { kind: 'emit'; bytes: Buffer }
  // JPEG entropy-coded data: copied until a marker, which the parser receives (not copied).
  | { kind: 'scan' }
  // The image has ended: everything after it is dropped.
  | { kind: 'rest' };

/** A format parser: yields steps, and is resumed with the bytes of a `take` or a scan's marker. */
type Parser = Generator<Step, Patch | undefined, Buffer>;

const malformed = (what: string) => new UnreadableImage(`Malformed image: ${what}.`);

function* take(n: number): Generator<Step, Buffer, Buffer> {
  return yield { kind: 'take', n };
}
function* byte(): Generator<Step, number, Buffer> {
  const one = yield* take(1);
  return one[0] ?? 0;
}
const pass = (n: number): Step => ({ kind: 'pass', n });
const skip = (n: number): Step => ({ kind: 'skip', n });
const emit = (...parts: (Buffer | readonly number[])[]): Step => ({
  kind: 'emit',
  bytes: Buffer.concat(parts.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part)))),
});
const REST: Step = { kind: 'rest' };

const latin1 = (bytes: Buffer, start = 0, end = bytes.length) =>
  bytes.toString('latin1', start, end);

// ---------------------------------------------------------------------------------------------
// JPEG

const JPEG_XMP = ['http://ns.adobe.com/xap/1.0/\0', 'http://ns.adobe.com/xmp/extension/\0'];
/**
 * An EXIF APP1 starts `Exif\0\0`, but readers (libvips among them) take any APP1 starting `Exif`
 * as EXIF, so the stripper does too; the TIFF structure starts after the 6-byte header.
 */
const JPEG_EXIF = 'Exif';
const EXIF_HEADER_BYTES = 6;
/** Long enough to tell EXIF and both XMP identifiers apart. */
const APP1_ID_BYTES = 35;

function* jpegMarker(): Generator<Step, number, Buffer> {
  if ((yield* byte()) !== 0xff) throw malformed('expected a JPEG marker');
  let marker = yield* byte();
  // 0xFF fill bytes may precede a marker.
  while (marker === 0xff) marker = yield* byte();
  if (marker === 0x00) throw malformed('expected a JPEG marker');
  return marker;
}

function* jpeg(): Parser {
  const soi = yield* take(2);
  if (soi[0] !== 0xff || soi[1] !== 0xd8) throw malformed('no JPEG start');
  yield emit(soi);
  let marker = yield* jpegMarker();
  for (;;) {
    if (marker === 0xd9) {
      yield emit([0xff, 0xd9]);
      yield REST;
      return undefined;
    }
    if (marker === 0xd8) throw malformed('a second JPEG start');
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      // Standalone markers have no length.
      yield emit([0xff, marker]);
      marker = yield* jpegMarker();
      continue;
    }
    const length = yield* take(2);
    const size = length.readUInt16BE(0) - 2;
    if (size < 0) throw malformed('a JPEG segment shorter than its length');
    if (marker === JPEG_PHOTOSHOP) {
      // Photoshop's image resources carry IPTC (city, country), EXIF and XMP: dropped whole (D27).
      yield skip(size);
    } else if (marker === 0xe1) {
      const id = yield* take(Math.min(size, APP1_ID_BYTES));
      const name = latin1(id);
      if (JPEG_XMP.some((xmp) => name.startsWith(xmp))) {
        yield skip(size - id.length);
      } else if (name.startsWith(JPEG_EXIF)) {
        const segment = Buffer.concat([id, yield* take(size - id.length)]);
        clearGps(segment.subarray(EXIF_HEADER_BYTES));
        yield emit([0xff, 0xe1], length, segment);
      } else {
        yield emit([0xff, 0xe1], length, id);
        yield pass(size - id.length);
      }
    } else {
      yield emit([0xff, marker], length);
      yield pass(size);
    }
    // After a scan header comes entropy-coded data, up to the next marker.
    marker = marker === 0xda ? ((yield { kind: 'scan' })[0] ?? 0) : yield* jpegMarker();
  }
}

/** Bytes per value of each TIFF field type. */
const TIFF_TYPE_BYTES: Record<number, number> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  6: 1,
  7: 1,
  8: 2,
  9: 4,
  10: 8,
  11: 4,
  12: 8,
};
const GPS_IFD_TAG = 0x8825;
const EXIF_IFD_TAG = 0x8769;
/** IFD1's JPEG thumbnail: its offset and length. */
const THUMBNAIL_OFFSET_TAG = 0x0201;
const THUMBNAIL_LENGTH_TAG = 0x0202;
/** A thumbnail's EXIF may hold a thumbnail too; one nested deeper than this is blanked whole. */
const MAX_THUMBNAIL_DEPTH = 2;
/** Real files have one GPS IFD and one Exif sub-IFD; more is refused, so clearing stays cheap. */
const MAX_POINTED_IFDS = 4;
const JPEG_PHOTOSHOP = 0xed;

/**
 * Empties every GPS IFD of a TIFF structure (an EXIF segment after its `Exif\0\0`), in place:
 * its entries, their values, and its next-IFD pointer become zeros, so it reads as an empty IFD.
 * GPS IFDs are found from IFD0, IFD1 and the Exif sub-IFD; IFD1's JPEG thumbnail is cleaned the
 * same way (SPEC-014 D27). The rest of EXIF (orientation above all) stays, and no byte moves.
 */
export function clearGps(tiff: Buffer, depth = 0): void {
  const order = latin1(tiff, 0, 2);
  if (order !== 'II' && order !== 'MM') throw malformed('EXIF byte order');
  const little = order === 'II';
  const inside = (offset: number, bytes: number) => offset >= 0 && offset + bytes <= tiff.length;
  const u16 = (offset: number) => {
    if (!inside(offset, 2)) throw malformed('EXIF offset');
    return little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset);
  };
  const u32 = (offset: number) => {
    if (!inside(offset, 4)) throw malformed('EXIF offset');
    return little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset);
  };
  /** An entry's single SHORT or LONG value. */
  const scalar = (entry: number) => (u16(entry + 2) === 3 ? u16(entry + 8) : u32(entry + 8));
  if (u16(2) !== 42) throw malformed('EXIF header');
  const entriesOf = (ifd: number) => {
    const count = u16(ifd);
    if (!inside(ifd, 2 + 12 * count + 4)) throw malformed('EXIF directory');
    return count;
  };
  const add = (set: Set<number>, ifd: number) => {
    set.add(ifd);
    if (set.size > MAX_POINTED_IFDS) throw malformed('too many EXIF directories');
  };

  const gps = new Set<number>();
  const exif = new Set<number>();
  let thumbnailOffset: number | undefined;
  let thumbnailLength: number | undefined;
  // IFD0 holds the GPS and Exif pointers; IFD1 (the thumbnail's) is checked too, in case a writer
  // put them there.
  let ifd = u32(4);
  const seen = new Set<number>();
  for (let index = 0; ifd !== 0 && index < 2; index++) {
    if (seen.has(ifd)) throw malformed('EXIF directory loop');
    seen.add(ifd);
    const count = entriesOf(ifd);
    for (let i = 0; i < count; i++) {
      const entry = ifd + 2 + 12 * i;
      const tag = u16(entry);
      if (tag === GPS_IFD_TAG) add(gps, u32(entry + 8));
      else if (tag === EXIF_IFD_TAG) add(exif, u32(entry + 8));
      else if (index === 1 && tag === THUMBNAIL_OFFSET_TAG) thumbnailOffset = scalar(entry);
      else if (index === 1 && tag === THUMBNAIL_LENGTH_TAG) thumbnailLength = scalar(entry);
    }
    ifd = u32(ifd + 2 + 12 * count);
  }
  // Some writers put the GPS pointer in the Exif sub-IFD (review m4).
  for (const directory of exif) {
    const count = entriesOf(directory);
    for (let i = 0; i < count; i++) {
      const entry = directory + 2 + 12 * i;
      if (u16(entry) === GPS_IFD_TAG) add(gps, u32(entry + 8));
    }
  }

  for (const directory of gps) {
    const count = entriesOf(directory);
    for (let i = 0; i < count; i++) {
      const entry = directory + 2 + 12 * i;
      const unit = TIFF_TYPE_BYTES[u16(entry + 2)];
      if (unit === undefined) throw malformed('EXIF GPS field type');
      const bytes = unit * u32(entry + 4);
      if (bytes > 4) {
        const at = u32(entry + 8);
        if (!inside(at, bytes)) throw malformed('EXIF GPS value');
        tiff.fill(0, at, at + bytes);
      }
    }
    tiff.fill(0, directory, directory + 2 + 12 * count + 4);
  }

  if (thumbnailOffset !== undefined && thumbnailLength !== undefined) {
    // A length running past the segment is common in camera files: clean what is there.
    const start = Math.min(thumbnailOffset, tiff.length);
    const thumbnail = tiff.subarray(start, Math.min(tiff.length, start + thumbnailLength));
    cleanThumbnail(thumbnail, depth + 1);
  }
}

/**
 * Cleans an EXIF thumbnail (a whole JPEG inside the EXIF segment) in place, without moving a byte:
 * its EXIF loses its GPS IFDs, its XMP and Photoshop segments become zeros, and bytes after its
 * end become zeros. One it can't follow, or one nested too deep, is blanked whole (D27, m1).
 */
function cleanThumbnail(jpeg: Buffer, depth: number): void {
  if (depth > MAX_THUMBNAIL_DEPTH) {
    jpeg.fill(0);
    return;
  }
  try {
    const end = cleanJpegInPlace(jpeg, depth);
    jpeg.fill(0, end);
  } catch (error) {
    if (!(error instanceof UnreadableImage)) throw error;
    jpeg.fill(0);
  }
}

/** Walks a JPEG held in memory, cleaning its metadata segments; returns the offset after EOI. */
function cleanJpegInPlace(jpeg: Buffer, depth: number): number {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw malformed('an EXIF thumbnail');
  let at = 2;
  for (;;) {
    if (jpeg[at] !== 0xff) throw malformed('an EXIF thumbnail marker');
    while (jpeg[at] === 0xff) at += 1;
    const marker = jpeg[at];
    if (marker === undefined || marker === 0x00 || marker === 0xd8) {
      throw malformed('an EXIF thumbnail marker');
    }
    at += 1;
    if (marker === 0xd9) return at;
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (at + 2 > jpeg.length) throw malformed('an EXIF thumbnail segment');
    const size = jpeg.readUInt16BE(at) - 2;
    const start = at + 2;
    const stop = start + size;
    if (size < 0 || stop > jpeg.length) throw malformed('an EXIF thumbnail segment');
    const payload = jpeg.subarray(start, stop);
    if (marker === 0xe1) {
      const name = latin1(payload, 0, Math.min(size, APP1_ID_BYTES));
      if (name.startsWith(JPEG_EXIF)) clearGps(payload.subarray(EXIF_HEADER_BYTES), depth);
      else if (JPEG_XMP.some((xmp) => name.startsWith(xmp))) payload.fill(0);
    } else if (marker === JPEG_PHOTOSHOP) {
      payload.fill(0);
    }
    at = stop;
    if (marker === 0xda) {
      // Entropy-coded data, up to the next marker.
      for (;;) {
        const ff = jpeg.indexOf(0xff, at);
        if (ff === -1 || ff + 1 >= jpeg.length) throw malformed('an EXIF thumbnail scan');
        at = ff + 1;
        if (isScanMarker(jpeg[ff + 1] ?? 0)) {
          at = ff;
          break;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// PNG

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_TEXT_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt']);
/** Text keywords that carry EXIF or XMP (Adobe's, and ImageMagick's raw profiles). */
const PNG_LOCATION_KEYWORDS = new Set([
  'XML:com.adobe.xmp',
  'Raw profile type exif',
  'Raw profile type APP1',
  'Raw profile type xmp',
]);
/** A keyword is 1–79 bytes and a NUL. */
const PNG_KEYWORD_BYTES = 80;
const CRC_BYTES = 4;

function* png(): Parser {
  const signature = yield* take(8);
  if (!signature.equals(PNG_SIGNATURE)) throw malformed('no PNG signature');
  yield emit(signature);
  let first = true;
  for (;;) {
    const header = yield* take(8);
    const size = header.readUInt32BE(0);
    const type = latin1(header, 4, 8);
    if (size > 0x7fffffff) throw malformed('a PNG chunk length');
    if (first && type !== 'IHDR') throw malformed('PNG without IHDR first');
    first = false;
    if (type === 'eXIf') {
      yield skip(size + CRC_BYTES);
      continue;
    }
    if (PNG_TEXT_CHUNKS.has(type)) {
      const start = yield* take(Math.min(size, PNG_KEYWORD_BYTES));
      const nul = start.indexOf(0);
      const keyword = latin1(start, 0, nul === -1 ? start.length : nul);
      if (PNG_LOCATION_KEYWORDS.has(keyword)) {
        yield skip(size - start.length + CRC_BYTES);
        continue;
      }
      yield emit(header, start);
      yield pass(size - start.length + CRC_BYTES);
      continue;
    }
    yield emit(header);
    yield pass(size + CRC_BYTES);
    if (type === 'IEND') {
      yield REST;
      return undefined;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// WebP

const WEBP_DROPPED = new Set(['EXIF', 'XMP ']);
/** VP8X flag bits for the EXIF and XMP chunks. */
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;
const VP8X_BYTES = 10;

function* webp(): Parser {
  const header = yield* take(12);
  if (latin1(header, 0, 4) !== 'RIFF' || latin1(header, 8, 12) !== 'WEBP') {
    throw malformed('no WebP header');
  }
  const riffSize = header.readUInt32LE(4);
  yield emit(header);
  // The RIFF size counts `WEBP` and the chunks.
  let remaining = riffSize - 4;
  if (remaining < 8) throw malformed('an empty WebP');
  let dropped = 0;
  let first = true;
  while (remaining > 0) {
    if (remaining < 8) throw malformed('a WebP chunk past the RIFF size');
    const chunk = yield* take(8);
    const fourcc = latin1(chunk, 0, 4);
    const size = chunk.readUInt32LE(4);
    const padded = size + (size & 1);
    if (8 + padded > remaining) throw malformed('a WebP chunk past the RIFF size');
    remaining -= 8 + padded;
    if (WEBP_DROPPED.has(fourcc)) {
      yield skip(padded);
      dropped += 8 + padded;
    } else if (first && fourcc === 'VP8X') {
      if (size !== VP8X_BYTES) throw malformed('a WebP VP8X size');
      const data = yield* take(padded);
      data[0] = (data[0] ?? 0) & ~(VP8X_EXIF | VP8X_XMP);
      yield emit(chunk, data);
    } else {
      yield emit(chunk);
      yield pass(padded);
    }
    first = false;
  }
  yield REST;
  if (dropped === 0) return undefined;
  const size = Buffer.alloc(4);
  size.writeUInt32LE(riffSize - dropped);
  return { offset: 4, bytes: size };
}

// ---------------------------------------------------------------------------------------------
// GIF

const GIF_XMP_APPLICATION = 'XMP DataXMP';

function* gifSubBlocks(keep: boolean): Generator<Step, void, Buffer> {
  for (;;) {
    const size = yield* byte();
    if (keep) yield emit([size]);
    if (size === 0) return;
    yield keep ? pass(size) : skip(size);
  }
}

const colorTableBytes = (packed: number) => (packed & 0x80 ? 3 << ((packed & 0x07) + 1) : 0);

function* gif(): Parser {
  const header = yield* take(13);
  const version = latin1(header, 0, 6);
  if (version !== 'GIF87a' && version !== 'GIF89a') throw malformed('no GIF header');
  yield emit(header);
  yield pass(colorTableBytes(header[10] ?? 0));
  for (;;) {
    const introducer = yield* byte();
    if (introducer === 0x3b) {
      yield emit([0x3b]);
      yield REST;
      return undefined;
    }
    if (introducer === 0x21) {
      const label = yield* byte();
      if (label === 0xff) {
        const size = yield* byte();
        const id = yield* take(size);
        if (size === 11 && latin1(id) === GIF_XMP_APPLICATION) {
          yield* gifSubBlocks(false);
          continue;
        }
        yield emit([0x21, 0xff, size], id);
      } else {
        yield emit([0x21, label]);
      }
      yield* gifSubBlocks(true);
      continue;
    }
    if (introducer === 0x2c) {
      const descriptor = yield* take(9);
      yield emit([0x2c], descriptor);
      yield pass(colorTableBytes(descriptor[8] ?? 0));
      // The LZW minimum code size, then the image data.
      yield pass(1);
      yield* gifSubBlocks(true);
      continue;
    }
    throw malformed('an unknown GIF block');
  }
}

// ---------------------------------------------------------------------------------------------
// The driver

const FF = Buffer.from([0xff]);

/** After a 0xFF in a scan: a byte that ends the scan (not stuffing, a restart, or more fill). */
const isScanMarker = (byte: number) =>
  byte !== 0x00 && byte !== 0xff && !(byte >= 0xd0 && byte <= 0xd7);

/**
 * Parser steps allowed after `bytes` bytes: a fixed allowance for headers, then one per 32 bytes.
 * Real images take far fewer (a GIF's 255-byte sub-blocks take 3 steps each, PNG and JPEG a few
 * per chunk or segment); a structure built of 1-byte pieces (fill bytes, standalone markers,
 * tiny sub-blocks) runs out and is refused, so parsing work stays in proportion to the bytes
 * (review B1).
 */
export const stepBudget = (bytes: number) => 4096 + Math.floor(bytes / 32);

const PARSERS: Record<ImageType, () => Parser> = {
  'image/jpeg': jpeg,
  'image/png': png,
  'image/webp': webp,
  'image/gif': gif,
};

/** A stripper for a sniffed image type. */
export function locationStripper(type: ImageType): LocationStripper {
  return new Driver(PARSERS[type]());
}

class Driver implements LocationStripper {
  private step: Step = REST;
  private finished = false;
  private result: Patch | undefined;
  private taken: Buffer[] = [];
  private takenBytes = 0;
  /** In a scan, the previous chunk ended with 0xFF. */
  private scanFF = false;
  private out: Buffer[] = [];
  private stepCount = 0;
  /** Bytes given to `write` so far, for the step budget. */
  private bytesIn = 0;

  constructor(private readonly parser: Parser) {
    this.resume(Buffer.alloc(0));
  }

  /** Runs the parser until it needs bytes, collecting what it emits. */
  private resume(input: Buffer): void {
    let value = input;
    for (;;) {
      this.stepCount += 1;
      if (this.stepCount > stepBudget(this.bytesIn)) {
        throw malformed('too many tiny parts for its size');
      }
      const next = this.parser.next(value);
      if (next.done === true) {
        this.finished = true;
        this.result = next.value;
        this.step = REST;
        return;
      }
      const step = next.value;
      value = Buffer.alloc(0);
      if (step.kind === 'emit') {
        if (step.bytes.length > 0) this.out.push(step.bytes);
        continue;
      }
      if ((step.kind === 'take' || step.kind === 'pass' || step.kind === 'skip') && step.n === 0) {
        continue;
      }
      // Steps are consumed in place, so each is a copy.
      this.step = { ...step };
      return;
    }
  }

  write(chunk: Buffer): Buffer[] {
    this.bytesIn += chunk.length;
    let at = 0;
    while (at < chunk.length) {
      const step = this.step;
      switch (step.kind) {
        case 'rest':
          at = chunk.length;
          break;
        case 'pass':
        case 'skip': {
          const n = Math.min(step.n, chunk.length - at);
          if (step.kind === 'pass') this.out.push(chunk.subarray(at, at + n));
          at += n;
          step.n -= n;
          if (step.n === 0) this.resume(Buffer.alloc(0));
          break;
        }
        case 'take': {
          const n = Math.min(step.n - this.takenBytes, chunk.length - at);
          // A copy: a slice would keep the whole chunk alive while waiting for the rest.
          this.taken.push(Buffer.from(chunk.subarray(at, at + n)));
          this.takenBytes += n;
          at += n;
          if (this.takenBytes === step.n) {
            const taken = Buffer.concat(this.taken);
            this.taken = [];
            this.takenBytes = 0;
            this.resume(taken);
          }
          break;
        }
        case 'scan':
          at = this.scan(chunk, at);
          break;
        case 'emit':
          // `resume` never leaves an emit as the current step.
          throw malformed('parser state');
      }
    }
    return this.flush();
  }

  /**
   * Copies entropy-coded JPEG data from `at`; returns where it stopped. Stuffed bytes (`FF 00`),
   * restart markers and fill bytes stay in the run, so a chunk gives at most two pieces however
   * hostile its data (review B1). A chunk ending in `0xFF` carries that one byte to the next.
   */
  private scan(chunk: Buffer, at: number): number {
    let start = at;
    if (this.scanFF) {
      this.scanFF = false;
      const next = chunk[at] ?? 0;
      if (isScanMarker(next)) {
        this.resume(Buffer.from([next]));
        return at + 1;
      }
      // The carried 0xFF was data after all.
      this.out.push(FF);
    }
    let i = start;
    for (;;) {
      const ff = chunk.indexOf(0xff, i);
      if (ff === -1) {
        if (start < chunk.length) this.out.push(chunk.subarray(start));
        return chunk.length;
      }
      if (ff + 1 === chunk.length) {
        if (start < ff) this.out.push(chunk.subarray(start, ff));
        this.scanFF = true;
        return chunk.length;
      }
      const next = chunk[ff + 1] ?? 0;
      if (isScanMarker(next)) {
        if (start < ff) this.out.push(chunk.subarray(start, ff));
        this.resume(Buffer.from([next]));
        return ff + 2;
      }
      // Stuffed, restart or fill: still data. A fill 0xFF is looked at again as a marker start.
      i = ff + 1;
      start = Math.min(start, ff);
    }
  }

  private flush(): Buffer[] {
    const out = this.out;
    this.out = [];
    return out;
  }

  end(): Buffer[] {
    if (!this.finished && this.step.kind !== 'rest') throw malformed('the image ended early');
    // The parser returns its patch once resumed after its last step.
    if (!this.finished) this.resume(Buffer.alloc(0));
    return this.flush();
  }

  patch(): Patch | undefined {
    return this.result;
  }

  steps(): number {
    return this.stepCount;
  }
}
