/**
 * Avatar and logo images (SPEC-001 §3.5; PLAN-001 S6; ADR-0014). The type comes from the bytes,
 * never from the browser: PNG, JPEG, GIF or WebP, and nothing else (an SVG can carry script).
 * sharp then decodes the image and re-encodes it as a 256 px square WebP, cropped from the
 * centre. That also drops its metadata (camera, location) and anything hidden after the image.
 *
 * If sharp can't load on this machine (a missing prebuilt binary), uploads are refused
 * (`ImagesUnavailable`) and the server logs an error. Storing the original instead would keep
 * its metadata, such as a photo's location, for the whole workspace to read (S6 review).
 *
 * Memory (SPEC-004 E10 and D10, measured 2026-11-12 in a 512 MB container): decoding is native
 * memory outside the JS heap, so `--max-old-space-size` doesn't bound it. 30 uploads at once of a
 * small file that decodes to 40 MP got the server OOM-killed: nothing limited how many decoded at
 * once. So:
 * - images over 25 MP are refused from their header, before any decoding (`ImageTooLarge`);
 * - at most `MAX_CONCURRENT_IMAGES` decode at once, the rest wait in arrival order, at most
 *   `MAX_WAITING_IMAGES` of them (`ImagesBusy` beyond), and one whose client has gone is skipped;
 * - one libvips thread per image, and no operation cache (a one-off avatar never hits it).
 *
 * `concurrency(1)` is load-bearing: sharp picks 1 by itself on glibc only while
 * `MALLOC_ARENA_MAX` is unset, and the image sets it (`docker/Dockerfile`), so without this call
 * every image would decode on one thread per core again.
 */
import type { FastifyBaseLogger } from 'fastify';

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

/** PNG, JPEG, GIF or WebP: the raster images that render inline and get a preview (SPEC-014 §4.8). */
export function isImageType(mimeType: string): mimeType is ImageType {
  return IMAGE_TYPES.some((type) => type === mimeType);
}

/** Avatars show at 32 px at most (design-system §5.1); 256 stays sharp on any screen. */
export const SQUARE_SIZE = 256;

/**
 * Larger images are refused before decoding: a small file can still decode to a huge bitmap. Phones
 * save 12 to 24 MP photos by default.
 */
export const MAX_INPUT_PIXELS = 25_000_000;

/** Images decoded at once; the rest wait in order. */
export const MAX_CONCURRENT_IMAGES = 2;

/**
 * Uploads waiting for a decode. Each holds its body (up to 2 MB) until its turn, so this bounds
 * that memory too; one user's rate limit (`UPLOADS_PER_MINUTE`) doesn't bound many users.
 */
export const MAX_WAITING_IMAGES = 16;

const startsWith = (bytes: Uint8Array, prefix: readonly number[], at = 0) =>
  bytes.length >= at + prefix.length && prefix.every((byte, i) => bytes[at + i] === byte);

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/** The image type of `bytes` from their first bytes, or undefined if not an allowed image. */
export function sniffImage(bytes: Uint8Array): ImageType | undefined {
  if (startsWith(bytes, [0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(bytes, ascii('GIF87a')) || startsWith(bytes, ascii('GIF89a'))) {
    return 'image/gif';
  }
  if (startsWith(bytes, ascii('RIFF')) && startsWith(bytes, ascii('WEBP'), 8)) return 'image/webp';
  return undefined;
}

export interface StoredImage {
  readonly bytes: Buffer;
  readonly mimeType: ImageType;
}

/** The image could not be decoded: a damaged file, or a type that only looks like an image. */
export class UnreadableImage extends Error {}

/** sharp couldn't load on this machine, so no image can be processed. */
export class ImagesUnavailable extends Error {}

/** More pixels than `MAX_INPUT_PIXELS`, read from the header: nothing was decoded. */
export class ImageTooLarge extends Error {}

/** `MAX_WAITING_IMAGES` uploads are already waiting for a decode. */
export class ImagesBusy extends Error {}

/** The upload's client went away while it waited, so it wasn't decoded. */
export class UploadAbandoned extends Error {}

/** The part of sharp this file uses; tests pass a fake. */
export type SharpFactory = ((
  /** The bytes, or a file's path (an attachment's header is read from disk, SPEC-014 §4.8). */
  input: Buffer | string,
  options: { limitInputPixels: number | false; failOn: 'error' },
) => {
  rotate(): ReturnType<SharpFactory>;
  resize(
    width: number,
    height: number,
    options:
      | { fit: 'cover'; position: 'centre' }
      // A preview (SPEC-014 §4.4): the longer side at most the box, never enlarged.
      | { fit: 'inside'; withoutEnlargement: true },
  ): ReturnType<SharpFactory>;
  webp(options: { quality: number }): ReturnType<SharpFactory>;
  toBuffer(): Promise<Buffer>;
  /** The header only: no pixels are decoded. */
  metadata(): Promise<{ width?: number | undefined; height?: number | undefined }>;
}) & {
  /** `false` turns libvips' operation cache off. */
  cache(options: boolean): unknown;
  /** libvips threads per image. */
  concurrency(threads: number): unknown;
};

export type LoadSharp = () => Promise<SharpFactory>;

const loadSharp: LoadSharp = async () => {
  const module = await import('sharp');
  return module.default;
};

/** Runs a decode when a slot is free (`decodeSlots`). */
export type DecodeSlots = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * Runs at most `max` tasks at once; up to `queue` others wait and start in arrival order as slots
 * free up. Throws `ImagesBusy` when the queue is full.
 */
export function decodeSlots(max = MAX_CONCURRENT_IMAGES, queue = MAX_WAITING_IMAGES): DecodeSlots {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (running < max) running += 1;
    else if (waiting.length >= queue) throw new ImagesBusy('Too many images are waiting.');
    // A finishing task hands its slot straight to the next waiter, so `running` stays the same.
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running -= 1;
    }
  };
}

/**
 * The process's one decode limiter, shared by avatar and logo uploads and the `files-preview` job
 * (SPEC-014 §4.4, SPEC-004 E10): the memory budget is per process, so two limiters of 2 would let
 * 4 images decode at once.
 */
export const IMAGE_DECODES: DecodeSlots = decodeSlots();

/**
 * Turns an upload into what is stored. Throws `ImageTooLarge` over 25 MP, `ImagesBusy` when too
 * many are waiting, `UploadAbandoned` if `gone()` turns true while it waits, `UnreadableImage`
 * if sharp can't decode it, and `ImagesUnavailable` if sharp can't load.
 */
export function imageProcessor(
  log: Pick<FastifyBaseLogger, 'error'>,
  load: LoadSharp = loadSharp,
  decode: DecodeSlots = IMAGE_DECODES,
) {
  // Loaded once, on the first upload: a server that never sees one never loads it.
  let sharp: Promise<SharpFactory | undefined> | undefined;
  const loaded = () =>
    (sharp ??= load()
      .then((factory) => {
        factory.cache(false);
        factory.concurrency(1);
        return factory;
      })
      .catch((error: unknown) => {
        log.error({ err: error }, 'sharp could not load; image uploads are refused');
        return undefined;
      }));
  // Every stored image is a WebP sharp wrote, whatever the upload's (sniffed) type was.
  return async (bytes: Buffer, gone: () => boolean = () => false): Promise<StoredImage> => {
    const factory = await loaded();
    if (factory === undefined) throw new ImagesUnavailable('sharp could not load.');
    const open = () => factory(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' });

    let size;
    try {
      // The header only, so no limit is needed: sharp would refuse an oversized one here as a
      // generic error, and the user needs to hear the image's size is the problem.
      size = await factory(bytes, { limitInputPixels: false, failOn: 'error' }).metadata();
    } catch (error) {
      throw new UnreadableImage('The image could not be decoded.', { cause: error });
    }
    if ((size.width ?? 0) * (size.height ?? 0) > MAX_INPUT_PIXELS) {
      throw new ImageTooLarge(`The image is ${size.width} × ${size.height}.`);
    }

    const output = await decode(async () => {
      if (gone()) throw new UploadAbandoned('The client went away.');
      try {
        return await open()
          // Applies the camera's orientation before the metadata is dropped.
          .rotate()
          .resize(SQUARE_SIZE, SQUARE_SIZE, { fit: 'cover', position: 'centre' })
          .webp({ quality: 85 })
          .toBuffer();
      } catch (error) {
        throw new UnreadableImage('The image could not be decoded.', { cause: error });
      }
    });
    return { bytes: output, mimeType: 'image/webp' };
  };
}

export interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

/**
 * Reads an uploaded image's width and height from its header on disk, decoding no pixels (SPEC-014
 * §4.8: a JPEG's size can sit beyond its first 64 KB, so it is read once the body is written).
 * Undefined when the header can't be read. If sharp can't load, every answer is undefined and the
 * error is logged once (E10): uploads still work, without dimensions.
 */
export function dimensionReader(
  log: Pick<FastifyBaseLogger, 'error'>,
  load: LoadSharp = loadSharp,
): (path: string) => Promise<ImageDimensions | undefined> {
  let sharp: Promise<SharpFactory | undefined> | undefined;
  const loaded = () =>
    (sharp ??= load()
      .then((factory) => {
        factory.cache(false);
        factory.concurrency(1);
        return factory;
      })
      .catch((error: unknown) => {
        log.error({ err: error }, 'sharp could not load; image dimensions are left empty');
        return undefined;
      }));
  return async (path) => {
    const factory = await loaded();
    if (factory === undefined) return undefined;
    try {
      const { width, height } = await factory(path, {
        limitInputPixels: false,
        failOn: 'error',
      }).metadata();
      return width !== undefined && height !== undefined && width > 0 && height > 0
        ? { width, height }
        : undefined;
    } catch {
      return undefined;
    }
  };
}

/** A preview's longer side at most (SPEC-014 §4.4). */
export const PREVIEW_SIZE = 800;

/** Why an image gets no preview: none of these is an error (§4.4, E10, E14). */
export type PreviewSkip = 'unavailable' | 'too large' | 'unreadable';

export type PreviewImage =
  | {
      readonly kind: 'made';
      /** A WebP, at most `PREVIEW_SIZE` on its longer side, with no metadata. */
      readonly bytes: Buffer;
      readonly width: number;
      readonly height: number;
    }
  | { readonly kind: 'skipped'; readonly reason: PreviewSkip };

/**
 * Makes an attachment image's preview (SPEC-014 §4.4) from its file on disk, never from a buffer
 * of the whole original: the header first (over 25 MP is skipped with nothing decoded), then the
 * decode in the process's shared limiter (`IMAGE_DECODES`) with the avatar limits (one libvips
 * thread, no cache). The camera's orientation is applied, then all metadata is dropped (sharp
 * writes none unless asked); an animated GIF gives its first frame (sharp reads one page unless
 * asked for more). If sharp can't load, every image is skipped and the error logged once (E10).
 * Throws only `ImagesBusy`, when too many decodes are waiting: the job then runs again later.
 */
export function previewMaker(
  log: { error(object: object, message: string): void },
  load: LoadSharp = loadSharp,
  decode: DecodeSlots = IMAGE_DECODES,
): (path: string) => Promise<PreviewImage> {
  let sharp: Promise<SharpFactory | undefined> | undefined;
  const loaded = () =>
    (sharp ??= load()
      .then((factory) => {
        factory.cache(false);
        factory.concurrency(1);
        return factory;
      })
      .catch((error: unknown) => {
        log.error({ err: error }, 'sharp could not load; image previews are not made');
        return undefined;
      }));
  const skipped = (reason: PreviewSkip): PreviewImage => ({ kind: 'skipped', reason });
  return async (path) => {
    const factory = await loaded();
    if (factory === undefined) return skipped('unavailable');
    let header;
    try {
      header = await factory(path, { limitInputPixels: false, failOn: 'error' }).metadata();
    } catch {
      return skipped('unreadable');
    }
    const { width = 0, height = 0 } = header;
    if (width <= 0 || height <= 0) return skipped('unreadable');
    if (width * height > MAX_INPUT_PIXELS) return skipped('too large');
    return decode(async (): Promise<PreviewImage> => {
      try {
        const bytes = await factory(path, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
          .rotate()
          .resize(PREVIEW_SIZE, PREVIEW_SIZE, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer();
        // The preview's own header: the rotation may have swapped the sides.
        const size = await factory(bytes, { limitInputPixels: false, failOn: 'error' }).metadata();
        if (size.width === undefined || size.height === undefined) return skipped('unreadable');
        return { kind: 'made', bytes, width: size.width, height: size.height };
      } catch {
        return skipped('unreadable');
      }
    });
  };
}
