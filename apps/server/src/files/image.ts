/**
 * Avatar and logo images (SPEC-001 §3.5; PLAN-001 S6; ADR-0014). The type comes from the bytes,
 * never from the browser: PNG, JPEG, GIF or WebP, and nothing else (an SVG can carry script).
 * sharp then decodes the image and re-encodes it as a 256 px square WebP, cropped from the
 * centre. That also drops its metadata (camera, location) and anything hidden after the image.
 *
 * If sharp can't load on this machine (a missing prebuilt binary), uploads are refused
 * (`ImagesUnavailable`) and the server logs an error. Storing the original instead would keep
 * its metadata, such as a photo's location, for the whole workspace to read (S6 review).
 */
import type { FastifyBaseLogger } from 'fastify';

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

/** Avatars show at 32 px at most (design-system §5.1); 256 stays sharp on any screen. */
export const SQUARE_SIZE = 256;

/** Larger images are refused before decoding: a small file can still decode to a huge bitmap. */
const MAX_INPUT_PIXELS = 40_000_000;

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

/** The part of sharp this file uses; tests pass a fake. */
export type SharpFactory = (
  input: Buffer,
  options: { limitInputPixels: number; failOn: 'error' },
) => {
  rotate(): ReturnType<SharpFactory>;
  resize(
    width: number,
    height: number,
    options: { fit: 'cover'; position: 'centre' },
  ): ReturnType<SharpFactory>;
  webp(options: { quality: number }): ReturnType<SharpFactory>;
  toBuffer(): Promise<Buffer>;
};

export type LoadSharp = () => Promise<SharpFactory>;

const loadSharp: LoadSharp = async () => {
  const module = await import('sharp');
  return module.default;
};

/**
 * Turns an upload into what is stored. Throws `UnreadableImage` if sharp can't decode it, and
 * `ImagesUnavailable` if sharp can't load.
 */
export function imageProcessor(log: Pick<FastifyBaseLogger, 'error'>, load: LoadSharp = loadSharp) {
  // Loaded once, on the first upload: a server that never sees one never loads it.
  let sharp: Promise<SharpFactory | undefined> | undefined;
  const loaded = () =>
    (sharp ??= load().catch((error: unknown) => {
      log.error({ err: error }, 'sharp could not load; image uploads are refused');
      return undefined;
    }));

  // Every stored image is a WebP sharp wrote, whatever the upload's (sniffed) type was.
  return async (bytes: Buffer): Promise<StoredImage> => {
    const factory = await loaded();
    if (factory === undefined) throw new ImagesUnavailable('sharp could not load.');
    try {
      const output = await factory(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
        // Applies the camera's orientation before the metadata is dropped.
        .rotate()
        .resize(SQUARE_SIZE, SQUARE_SIZE, { fit: 'cover', position: 'centre' })
        .webp({ quality: 85 })
        .toBuffer();
      return { bytes: output, mimeType: 'image/webp' };
    } catch (error) {
      throw new UnreadableImage('The image could not be decoded.', { cause: error });
    }
  };
}
