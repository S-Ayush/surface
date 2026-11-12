/**
 * Receiving an attachment or inline upload (SPEC-014 §4.5 step 2, §4.8): the body goes from the
 * request to a temporary file in one loop, a chunk at a time. On the way it is counted against
 * `UPLOAD_MAX_MB`, its type is sniffed from its first 8 KB, and an image has its location
 * metadata stripped. The hash is of the bytes as stored.
 *
 * Memory (SPEC-014 AC-1, E13; SPEC-004 E10): between two reads from the request, the loop holds at
 * most the sniffer's head (8 KB) or the stripper's one pending unit (a JPEG EXIF segment, at most
 * 64 KB by the format). Each chunk is on disk before the next is read.
 */
import type { BlobStore, TempBlob } from './blob-store.js';
import { SNIFF_BYTES, isImageType, sniffType, type SniffedType } from './sniff.js';
import { locationStripper, type LocationStripper } from './strip-location.js';

/** The body passed the limit; reading stopped there. */
export class BodyTooLarge extends Error {}

/** The body had no bytes. */
export class EmptyBody extends Error {}

export interface ReceivedUpload {
  readonly temp: TempBlob;
  readonly mimeType: SniffedType;
}

/**
 * Streams `source` into a temporary file of `blobs`. Throws `BodyTooLarge` past `limit` bytes,
 * `EmptyBody` for no bytes, and `UnreadableImage` for an image whose structure the stripper can't
 * follow; the temporary file is removed in each case.
 */
export async function receiveUpload(
  blobs: BlobStore,
  source: AsyncIterable<Uint8Array>,
  limit: number,
): Promise<ReceivedUpload> {
  let mimeType: SniffedType | undefined;
  let stripper: LocationStripper | undefined;

  const start = (head: Buffer, complete: boolean) => {
    mimeType = sniffType(head.subarray(0, SNIFF_BYTES), complete);
    if (isImageType(mimeType)) stripper = locationStripper(mimeType);
  };
  /**
   * One buffer per chunk read, so the disk gets one write per chunk however many pieces the
   * stripper cut it into (review B1).
   */
  const joined = (pieces: Buffer[]): Buffer[] => {
    if (pieces.length <= 1) return pieces.filter((piece) => piece.length > 0);
    return [Buffer.concat(pieces)];
  };
  const process = (chunk: Buffer): Buffer[] => (stripper ? joined(stripper.write(chunk)) : [chunk]);

  async function* body(): AsyncGenerator<Uint8Array> {
    let received = 0;
    let head: Buffer[] = [];
    let headBytes = 0;
    for await (const raw of source) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      received += chunk.length;
      if (received > limit) throw new BodyTooLarge('The body is over the limit.');
      if (mimeType !== undefined) {
        yield* process(chunk);
        continue;
      }
      head.push(chunk);
      headBytes += chunk.length;
      if (headBytes < SNIFF_BYTES) continue;
      const first = Buffer.concat(head);
      head = [];
      start(first, false);
      yield* process(first);
    }
    if (mimeType === undefined) {
      if (headBytes === 0) throw new EmptyBody('The body is empty.');
      const all = Buffer.concat(head);
      start(all, true);
      yield* process(all);
    }
    if (stripper) yield* joined(stripper.end());
  }

  const temp = await blobs.putStream(body(), () => stripper?.patch());
  return { temp, mimeType: mimeType ?? 'application/octet-stream' };
}

/**
 * `source`, calling `onIdle` once if it sends nothing for `ms` (review M1). The clock runs only
 * while waiting for the source: time the consumer spends writing a chunk doesn't count. `onIdle`
 * should end the source (the route destroys the request), which ends the loop.
 */
export async function* withIdleTimeout<T>(
  source: AsyncIterable<T>,
  ms: number,
  onIdle: () => void,
): AsyncGenerator<T> {
  let timer = setTimeout(onIdle, ms);
  try {
    for await (const chunk of source) {
      clearTimeout(timer);
      yield chunk;
      timer = setTimeout(onIdle, ms);
    }
  } finally {
    clearTimeout(timer);
  }
}
