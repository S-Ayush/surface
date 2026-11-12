/**
 * Uploading and serving files (ADR-0021, which supersedes ADR-0014; PLAN-001 S6, PLAN-014 S2).
 *
 * - `POST /files/upload?purpose=attachment|inline` (SPEC-014 §4.6, §4.8, §6.1): any file up to
 *   `UPLOAD_MAX_MB`, as the raw body, streamed to disk (`upload-body.ts`): never more than 64 KB
 *   of it in memory. A declared size over the limit is `413` before a byte is read; an undeclared
 *   one stops at the limit. The type is sniffed from the bytes, an image loses its location
 *   metadata, and the name comes from `X-File-Name`, cleaned (`names.ts`). The answer is the
 *   file's id; the row is unclaimed (no issue) until `attachment.createFile` or a saved document
 *   claims it (PLAN-014 S4a, S4b). Limits (`limits.ts`): 30 uploads a minute and 3 at once per
 *   user, 100 unclaimed files and 1 GB unclaimed per user (`429`), a 1 GB free-space floor
 *   (`507`), and 30 s without data closes the upload (`408`).
 * - `POST /files/upload?purpose=avatar|logo` (SPEC-001 §3.5): unchanged from M0. The image is
 *   buffered (at most 2 MB), stored as a 256 px square (`image.ts`), and 10 a minute per user. A
 *   logo needs an Admin. Setting it as the avatar or logo is an operation (`user.updateProfile`,
 *   `workspace.update`), so synced rows change only through the repo.
 * - `GET /files/:id` (and `HEAD`) streams the bytes to a signed-in user who may see them
 *   (`visibleFile` in `store.ts`, SPEC-014 §4.2): a file they can't see is `404`, like a missing
 *   one. Every request is checked, before the ETag; the browser revalidates (`no-cache`), and the
 *   bytes of an id never change. Only the four raster image types (and previews) show inline;
 *   everything else, and anything with `?download=1`, downloads under its name. Every file has
 *   the `sandbox` CSP and `nosniff`.
 *
 * Both need a session (uploads with an API key come in M6, D21), CSRF is the app-wide check for
 * cookie-authenticated POSTs (Q7), and both answer `503` until setup is done (SPEC-001 Q5).
 */
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import type {
  FastifyBaseLogger,
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { z } from 'zod';
import type { ResolvedSession, SessionAuth } from '../auth/sessions.js';
import { uuidv7 } from '../db/uuidv7.js';
import { tokenBucket } from '../executor/rate-limit.js';
import type { WithTransaction } from '../executor/transaction.js';
import { errorBody, ROUTE_ERROR_STATUS } from '../http/errors.js';
import type { Lifecycle } from '../lifecycle.js';
import { unavailable } from '../handlers/account/sign-in.js';
import type { BlobStore, TempBlob } from './blob-store.js';
import {
  dimensionReader,
  imageProcessor,
  ImagesBusy,
  ImagesUnavailable,
  ImageTooLarge,
  UploadAbandoned,
  sniffImage,
  UnreadableImage,
  type LoadSharp,
} from './image.js';
import {
  belowFloor,
  FILE_UPLOADS_PER_MINUTE,
  IMAGE_UPLOADS_PER_MINUTE,
  MAX_CONCURRENT_UPLOADS,
  overCaps,
  UPLOAD_IDLE_MS,
  type DiskSpace,
} from './limits.js';
import { attachmentDisposition, cleanFileName } from './names.js';
import { isImageType } from './sniff.js';
import { fileReaderOf, PG_FILE_STORE, type FileStore } from './store.js';
import { BodyTooLarge, EmptyBody, receiveUpload, withIdleTimeout } from './upload-body.js';

export const FILES_PATH = '/files';
/**
 * Under `/files/`, like the downloads: the setup guard, the SPA fallback, the dev proxy and the
 * offline cache all treat that prefix as the server's (PLAN-001 S6 deviation from `POST /files`).
 */
export const UPLOAD_PATH = '/files/upload';
export const FILE_PATH = '/files/:id';

/** The uploader's file name, percent-encoded UTF-8 (SPEC-014 §4.8). */
export const FILE_NAME_HEADER = 'x-file-name';

/** SPEC-001 §3.5: avatars are at most 2 MB; `UPLOAD_MAX_MB` may only lower it. */
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;

export const IMAGE_TOO_LARGE_MESSAGE = 'Images must be 2 MB or smaller. Choose a smaller image.';
export const IMAGE_TYPE_MESSAGE = 'Use a PNG, JPEG, GIF or WebP image.';
export const IMAGE_UNREADABLE_MESSAGE =
  'That image could not be read. Try saving it again as a PNG or JPEG.';
/**
 * Avatar and logo uploads per user per minute. Each costs a sharp decode and a stored file, and
 * the route isn't an operation, so the executor's limit doesn't apply (S9 security review L3).
 * Setting an avatar or logo takes one; a few retries fit. Attachments and inline files have
 * their own, larger bucket (`FILE_UPLOADS_PER_MINUTE`, SPEC-014 D18).
 */
export const UPLOADS_PER_MINUTE = IMAGE_UPLOADS_PER_MINUTE;

export const IMAGES_UNAVAILABLE_MESSAGE =
  'Image uploads are unavailable on this server. Ask an Admin to check the server log.';
/** SPEC-001 §6.1: the pixel limit (`MAX_INPUT_PIXELS`), refused from the header. */
export const IMAGE_PIXELS_MESSAGE =
  'Images must be 25 megapixels or smaller, like 5000 × 5000. Choose a smaller image.';
/** SPEC-004 E10: the decode queue is full. */
export const IMAGES_BUSY_MESSAGE =
  'The server is busy with other images. Try again in a few seconds.';
const IMAGES_BUSY_RETRY_SECONDS = 5;

/** SPEC-014 §6.4. */
export const fileTooLargeMessage = (uploadMaxMb: number) =>
  `Files must be ${uploadMaxMb} MB or smaller.`;
export const EMPTY_FILE_MESSAGE = 'Choose a file to upload.';
export const DISK_FULL_MESSAGE =
  'The server is almost out of disk space. Ask an Admin to free some.';
export const UNCLAIMED_CAPS_MESSAGE =
  'You have too many unsaved uploads. Attach or save them, or wait a day.';
export const UPLOAD_IDLE_MESSAGE =
  'The upload stopped sending data. Check the connection and try again.';
export const UPLOADS_BUSY_MESSAGE = `You have ${MAX_CONCURRENT_UPLOADS} uploads in progress. Wait for one to finish, then try again.`;
export const UPLOAD_INTERRUPTED_MESSAGE = 'The upload was interrupted. Try again.';
export const PURPOSE_MESSAGE =
  'Say what the file is for: ?purpose=attachment, ?purpose=inline, ?purpose=avatar or ?purpose=logo.';

/** A file is never run as a page, even if a browser guessed its type (A's conditions, S6). */
const FILE_CSP = "default-src 'none'; sandbox";

export interface FileRouteDeps {
  readonly auth: Pick<SessionAuth, 'session'>;
  readonly lifecycle: Pick<Lifecycle, 'everReady'>;
  readonly withTransaction: WithTransaction;
  readonly blobs: BlobStore;
  readonly log: Pick<FastifyBaseLogger, 'error'>;
  /** `UPLOAD_MAX_MB` (SPEC-004 §7). */
  readonly uploadMaxMb: number;
  /** Free bytes on the uploads volume (`diskSpace` in `limits.ts`; a fake in tests). */
  readonly diskSpace: DiskSpace;
  readonly store?: FileStore;
  readonly loadSharp?: LoadSharp;
}

/**
 * What this route takes. Narrower than `FILE_PURPOSES`: a `preview` is only ever made by the
 * server (SPEC-014 §4.4), never uploaded.
 */
export const UPLOAD_PURPOSES = ['avatar', 'logo', 'attachment', 'inline'] as const;
type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];
/** The purposes that stream to disk, with `UPLOAD_MAX_MB` and the SPEC-014 §4.6 limits. */
const STREAMED_PURPOSES: readonly UploadPurpose[] = ['attachment', 'inline'];

const Query = z.object({ purpose: z.enum(UPLOAD_PURPOSES) });
const Params = z.object({ id: z.uuid() });
const Download = z.object({ download: z.literal('1') });

const EXTENSIONS: Record<string, string> = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
};

const purposeOf = (request: FastifyRequest): UploadPurpose | undefined => {
  const query = Query.safeParse(request.query);
  return query.success ? query.data.purpose : undefined;
};
const isStreamed = (purpose: UploadPurpose | undefined) =>
  purpose !== undefined && STREAMED_PURPOSES.includes(purpose);

const declaredLength = (request: FastifyRequest): number | undefined => {
  const header = request.headers['content-length'];
  const declared = header === undefined ? Number.NaN : Number(header);
  return Number.isFinite(declared) && declared >= 0 ? declared : undefined;
};

/** Whether an error is the disk filling up while writing (E9). */
const isDiskFull = (error: unknown) => {
  const code: unknown =
    typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
  return code === 'ENOSPC' || code === 'EDQUOT';
};

const tooLarge = () => Object.assign(new Error('The body is over the limit.'), { statusCode: 413 });

/** A whole (small) body, stopping at `limit`. The request isn't destroyed, so `413` still goes out. */
async function collect(payload: Readable, limit: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of payload.iterator({ destroyOnReturn: false })) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += part.length;
    if (size > limit) throw tooLarge();
    parts.push(part);
  }
  return Buffer.concat(parts);
}

export function registerFileRoutes(app: FastifyInstance, deps: FileRouteDeps): void {
  const store = deps.store ?? PG_FILE_STORE;
  const process = imageProcessor(deps.log, deps.loadSharp);
  const dimensions = dimensionReader(deps.log, deps.loadSharp);
  const imageLimit = Math.min(IMAGE_MAX_BYTES, deps.uploadMaxMb * 1024 * 1024);
  const fileLimit = deps.uploadMaxMb * 1024 * 1024;
  const limitOf = (purpose: UploadPurpose) => (isStreamed(purpose) ? fileLimit : imageLimit);
  // In memory, per process: like the executor's limiter, several replicas each allow the rate.
  // Two buckets, so dropping 30 screenshots doesn't use up the avatar's 10 (SPEC-014 D18).
  const imageUploads = tokenBucket({
    queriesPerMinute: 0,
    mutationsPerMinute: IMAGE_UPLOADS_PER_MINUTE,
  });
  const fileUploads = tokenBucket({
    queriesPerMinute: 0,
    mutationsPerMinute: FILE_UPLOADS_PER_MINUTE,
  });
  /** Streamed uploads in progress per user (review M1); in memory, per process, like the buckets. */
  const inProgress = new Map<string, number>();

  const refuse = (
    request: FastifyRequest,
    reply: FastifyReply,
    status: number,
    code: string,
    message: string,
  ) => reply.code(status).send(errorBody(request, code, message));

  /**
   * A streamed upload refused with its body (partly) unread: the connection closes after the
   * answer, so the rest isn't read just to be thrown away.
   */
  const refuseUpload = (
    request: FastifyRequest,
    reply: FastifyReply,
    status: number,
    code: string,
    message: string,
    reason?: 'floor' | 'caps' | 'rate' | 'busy' | 'idle',
  ) => {
    // SPEC-014 §10: the reason only, never the file's name or contents.
    if (reason !== undefined) request.log.info({ reason }, 'upload refused');
    void reply.header('connection', 'close');
    return refuse(request, reply, status, code, message);
  };

  const rateLimited = (request: FastifyRequest, reply: FastifyReply, retryAfter: number) => {
    void reply.header('retry-after', String(retryAfter));
    return refuseUpload(
      request,
      reply,
      429,
      'RATE_LIMITED',
      `Too many uploads. Try again in ${retryAfter} second${retryAfter === 1 ? '' : 's'}.`,
      'rate',
    );
  };

  const signedOut = (request: FastifyRequest, reply: FastifyReply, what?: 'image' | 'file') =>
    refuse(
      request,
      reply,
      401,
      'UNAUTHENTICATED',
      what === undefined
        ? 'Log in to see this file.'
        : `Log in to upload ${what === 'image' ? 'an image' : 'a file'}.`,
    );

  const notFound = (request: FastifyRequest, reply: FastifyReply) =>
    refuse(request, reply, 404, 'NOT_FOUND', 'File not found. It may have been replaced.');

  /** `attachment` and `inline` (SPEC-014 §4.6, §4.8, §6.1). */
  async function uploadFile(
    request: FastifyRequest,
    reply: FastifyReply,
    session: ResolvedSession,
    purpose: UploadPurpose,
  ) {
    const running = inProgress.get(session.userId) ?? 0;
    if (running >= MAX_CONCURRENT_UPLOADS) {
      return refuseUpload(request, reply, 429, 'RATE_LIMITED', UPLOADS_BUSY_MESSAGE, 'busy');
    }
    inProgress.set(session.userId, running + 1);
    try {
      return await receiveFile(request, reply, session, purpose);
    } catch (error) {
      // The error answer goes out with the body maybe unread too: close rather than read it
      // (review m6).
      void reply.header('connection', 'close');
      throw error;
    } finally {
      const left = (inProgress.get(session.userId) ?? 1) - 1;
      if (left > 0) inProgress.set(session.userId, left);
      else inProgress.delete(session.userId);
    }
  }

  async function receiveFile(
    request: FastifyRequest,
    reply: FastifyReply,
    session: ResolvedSession,
    purpose: UploadPurpose,
  ) {
    // Every check that needs no byte of the body comes before reading it.
    const rate = fileUploads.take(session.actor, 'mutation');
    if (!rate.allowed) return rateLimited(request, reply, rate.retryAfterSeconds);
    const declared = declaredLength(request);
    const usage = await deps.withTransaction((client) =>
      store.unclaimedUsage(client, session.userId),
    );
    if (overCaps(usage, declared ?? 0)) {
      return refuseUpload(request, reply, 429, 'RATE_LIMITED', UNCLAIMED_CAPS_MESSAGE, 'caps');
    }
    // Without a declared length, the worst case is the limit.
    if (belowFloor(await deps.diskSpace(), declared ?? fileLimit)) {
      return refuseUpload(
        request,
        reply,
        ROUTE_ERROR_STATUS.INSUFFICIENT_STORAGE,
        'INSUFFICIENT_STORAGE',
        DISK_FULL_MESSAGE,
        'floor',
      );
    }
    const body = request.body;
    if (!(body instanceof Readable)) {
      return refuse(request, reply, 400, 'INVALID_INPUT', EMPTY_FILE_MESSAGE);
    }

    let received;
    let idle = false;
    try {
      // `destroyOnReturn: false`: stopping at the limit must not reset the connection before the
      // `413` is sent. A client that goes quiet is cut off (review M1).
      const source = withIdleTimeout(
        body.iterator({ destroyOnReturn: false }),
        UPLOAD_IDLE_MS,
        () => {
          idle = true;
          request.raw.destroy();
        },
      );
      received = await receiveUpload(deps.blobs, source, fileLimit);
    } catch (error) {
      if (idle) {
        return refuseUpload(request, reply, 408, 'INVALID_INPUT', UPLOAD_IDLE_MESSAGE, 'idle');
      }
      if (error instanceof BodyTooLarge) {
        return refuseUpload(
          request,
          reply,
          413,
          'INVALID_INPUT',
          fileTooLargeMessage(deps.uploadMaxMb),
        );
      }
      if (error instanceof EmptyBody) {
        return refuse(request, reply, 400, 'INVALID_INPUT', EMPTY_FILE_MESSAGE);
      }
      if (error instanceof UnreadableImage) {
        // E25: never stored with its location metadata.
        return refuseUpload(request, reply, 400, 'INVALID_INPUT', IMAGE_UNREADABLE_MESSAGE);
      }
      if (isDiskFull(error)) {
        return refuseUpload(
          request,
          reply,
          ROUTE_ERROR_STATUS.INSUFFICIENT_STORAGE,
          'INSUFFICIENT_STORAGE',
          DISK_FULL_MESSAGE,
          'floor',
        );
      }
      // `destroyed` too: light-my-request's socket has no `destroyed`, and a destroyed request
      // may not be marked aborted.
      if (request.raw.aborted || request.raw.destroyed || request.raw.socket.destroyed) {
        // Nobody reads this answer; it isn't a server error either.
        return refuseUpload(request, reply, 400, 'INVALID_INPUT', UPLOAD_INTERRUPTED_MESSAGE);
      }
      throw error;
    }
    const { temp, mimeType } = received;
    try {
      return await storeUpload(request, reply, session, purpose, temp, mimeType, usage);
    } catch (error) {
      // A failed transaction (§4.5 step 2). Bytes already renamed under their key are the
      // sweep's (PLAN-014 S3); a temporary file still here is removed now.
      await deps.blobs.discard(temp.tempPath);
      throw error;
    }
  }

  async function storeUpload(
    request: FastifyRequest,
    reply: FastifyReply,
    session: ResolvedSession,
    purpose: UploadPurpose,
    temp: TempBlob,
    mimeType: string,
    usage: { readonly files: number; readonly bytes: number },
  ) {
    // The declared length may have been absent: the caps again, with the real size. A refusal
    // removes the temporary file before answering. This one is cheap and spares the header read;
    // the one that counts is in the insert's transaction, below.
    if (overCaps(usage, temp.size)) {
      await deps.blobs.discard(temp.tempPath);
      return refuseUpload(request, reply, 429, 'RATE_LIMITED', UNCLAIMED_CAPS_MESSAGE, 'caps');
    }
    // Again before the rename (SPEC-014 §4.6): other uploads may have filled the disk meanwhile.
    if (belowFloor(await deps.diskSpace(), 0)) {
      await deps.blobs.discard(temp.tempPath);
      return refuseUpload(
        request,
        reply,
        ROUTE_ERROR_STATUS.INSUFFICIENT_STORAGE,
        'INSUFFICIENT_STORAGE',
        DISK_FULL_MESSAGE,
        'floor',
      );
    }
    const name = cleanFileName(request.headers[FILE_NAME_HEADER]);
    // The header only, from disk (§4.8); empty if sharp can't read it or can't load (E10).
    const size = isImageType(mimeType) ? await dimensions(temp.tempPath) : undefined;
    const id = uuidv7();
    const stored = await deps.withTransaction(async (client) => {
      // Parallel uploads all passed the checks above together: under the uploader's lock, each
      // counts the rows of those before it (review M2).
      if (!(await store.reserveUpload(client, session.userId, temp.size))) return false;
      // S3: `insertUpload` (files/bytes.ts) takes the key lock (SPEC-014 §4.5) before the
      // rename and the insert. Until then nothing deletes file rows or bytes, so there is no
      // delete to race. A retried transaction repeats the rename, which `commit` allows.
      await deps.blobs.commit(temp.tempPath, temp.key);
      await store.insert(client, {
        id,
        storageKey: temp.key,
        purpose,
        name,
        mimeType,
        size: temp.size,
        uploaderId: session.userId,
        width: size?.width ?? null,
        height: size?.height ?? null,
      });
      return true;
    });
    if (!stored) {
      await deps.blobs.discard(temp.tempPath);
      return refuseUpload(request, reply, 429, 'RATE_LIMITED', UNCLAIMED_CAPS_MESSAGE, 'caps');
    }
    // Ids only: the file's name and contents never reach the log.
    request.log.info({ fileId: id, purpose, size: temp.size }, 'file uploaded');
    return reply.code(201).send({
      ok: true,
      result: {
        id,
        url: `${FILES_PATH}/${id}`,
        mimeType,
        size: temp.size,
        name,
        ...(size === undefined ? {} : { width: size.width, height: size.height }),
      },
    });
  }

  /** `avatar` and `logo`: M0's buffered image path (SPEC-001 §3.5). */
  async function uploadImage(
    request: FastifyRequest,
    reply: FastifyReply,
    session: ResolvedSession,
    purpose: UploadPurpose,
  ) {
    // Before the body is decoded, so a refused upload costs nothing.
    const rate = imageUploads.take(session.actor, 'mutation');
    if (!rate.allowed) {
      void reply.header('retry-after', String(rate.retryAfterSeconds));
      return refuse(
        request,
        reply,
        429,
        'RATE_LIMITED',
        `Too many uploads. Try again in ${rate.retryAfterSeconds} second${rate.retryAfterSeconds === 1 ? '' : 's'}.`,
      );
    }
    if (purpose === 'logo' && session.actor.role !== 'admin') {
      return refuse(request, reply, 403, 'FORBIDDEN', 'Only Admins can change the workspace logo.');
    }
    const body = request.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return refuse(request, reply, 400, 'INVALID_INPUT', 'Choose an image to upload.');
    }
    const type = sniffImage(body);
    if (type === undefined) {
      return refuse(request, reply, 400, 'INVALID_INPUT', IMAGE_TYPE_MESSAGE);
    }
    let image;
    try {
      // A client that went away while waiting isn't decoded (SPEC-004 E10).
      image = await process(body, () => request.socket.destroyed);
    } catch (error) {
      if (error instanceof ImageTooLarge) {
        return refuse(request, reply, 400, 'INVALID_INPUT', IMAGE_PIXELS_MESSAGE);
      }
      if (error instanceof UnreadableImage) {
        return refuse(request, reply, 400, 'INVALID_INPUT', IMAGE_UNREADABLE_MESSAGE);
      }
      if (error instanceof ImagesBusy || error instanceof UploadAbandoned) {
        // Nobody reads the answer to an abandoned upload; the busy one says when to retry.
        void reply.header('retry-after', String(IMAGES_BUSY_RETRY_SECONDS));
        return refuse(request, reply, 503, 'UNAVAILABLE', IMAGES_BUSY_MESSAGE);
      }
      if (error instanceof ImagesUnavailable) {
        return refuse(request, reply, 503, 'UNAVAILABLE', IMAGES_UNAVAILABLE_MESSAGE);
      }
      throw error;
    }
    const storageKey = await deps.blobs.put(image.bytes);
    const id = uuidv7();
    await deps.withTransaction((client) =>
      store.insert(client, {
        id,
        storageKey,
        purpose,
        name: `${purpose}.${EXTENSIONS[image.mimeType] ?? 'img'}`,
        mimeType: image.mimeType,
        size: image.bytes.length,
        uploaderId: session.userId,
      }),
    );
    // Ids only: the uploader's file name is never read, stored or logged.
    request.log.info({ fileId: id, purpose }, 'file uploaded');
    return reply.code(201).send({
      ok: true,
      result: {
        id,
        url: `${FILES_PATH}/${id}`,
        mimeType: image.mimeType,
        size: image.bytes.length,
      },
    });
  }

  // Its own scope, so the raw-body parser applies to these routes only.
  void app.register((scope, _options, done) => {
    scope.removeAllContentTypeParsers();
    // Attachments and inline files reach the handler unread, as the request stream, so nothing is
    // read before the session and the limits are checked; avatars and logos are read whole. A
    // request without a known purpose is refused unread too.
    scope.addContentTypeParser('*', async (request: FastifyRequest, payload: IncomingMessage) => {
      const purpose = purposeOf(request);
      return purpose === undefined || isStreamed(purpose) ? payload : collect(payload, imageLimit);
    });
    scope.setErrorHandler((error: FastifyError, request, reply) => {
      // An undeclared avatar size that turns out too large: reading stopped at the limit.
      if (error.statusCode === 413) {
        void reply.header('connection', 'close');
        return refuse(request, reply, 413, 'INVALID_INPUT', IMAGE_TOO_LARGE_MESSAGE);
      }
      // Everything else is the app's error handler's (no internals in a 5xx).
      throw error;
    });
    // After the app's own headers hook, so this CSP replaces the page one for files.
    scope.addHook('onSend', async (_request, reply, payload) => {
      reply.header('content-security-policy', FILE_CSP);
      reply.header('x-content-type-options', 'nosniff');
      return payload;
    });

    scope.post(UPLOAD_PATH, {
      // A declared size over the limit is refused before a byte of the body is read.
      onRequest: async (request, reply) => {
        const purpose = purposeOf(request);
        const declared = declaredLength(request);
        // Without a purpose there is no limit to apply: the handler asks for one.
        if (purpose === undefined || declared === undefined || declared <= limitOf(purpose)) return;
        if (isStreamed(purpose)) {
          await refuseUpload(
            request,
            reply,
            413,
            'INVALID_INPUT',
            fileTooLargeMessage(deps.uploadMaxMb),
          );
        } else {
          await refuse(request, reply, 413, 'INVALID_INPUT', IMAGE_TOO_LARGE_MESSAGE);
        }
      },
      handler: async (request, reply) => {
        if (!deps.lifecycle.everReady) return unavailable(request, reply);
        const purpose = purposeOf(request);
        const session = await deps.auth.session(request);
        if (session === undefined) {
          // A streamed body is still unread: close rather than read it for nobody.
          if (purpose === undefined || isStreamed(purpose))
            void reply.header('connection', 'close');
          return signedOut(request, reply, isStreamed(purpose) ? 'file' : 'image');
        }
        if (purpose === undefined) {
          return refuseUpload(request, reply, 400, 'INVALID_INPUT', PURPOSE_MESSAGE);
        }
        return isStreamed(purpose)
          ? uploadFile(request, reply, session, purpose)
          : uploadImage(request, reply, session, purpose);
      },
    });

    scope.get(FILE_PATH, async (request, reply) => {
      if (!deps.lifecycle.everReady) return unavailable(request, reply);
      const session = await deps.auth.session(request);
      if (session === undefined) return signedOut(request, reply);
      const params = Params.safeParse(request.params);
      if (!params.success) return notFound(request, reply);
      // SPEC-014 §4.2: one rule for every read, checked before the ETag, so a 304 never
      // confirms a file the reader can't see. Sessions only in M1 (D21): no key narrowing yet.
      const reader = fileReaderOf(session.actor);
      if (reader === undefined) return notFound(request, reply);
      const file = await deps.withTransaction((client) =>
        store.visibleFile(client, params.data.id.toLowerCase(), reader),
      );
      if (file === undefined) return notFound(request, reply);
      const missingBytes = () => {
        request.log.warn({ fileId: file.id }, 'file row without its bytes');
        return notFound(request, reply);
      };
      // Checked before any file header is set, so a row without its bytes answers exactly like a
      // missing file. HEAD and a revalidation only need to know the bytes are there: nothing is
      // opened, so nothing is read.
      const found = await deps.blobs.stat(file.storageKey);
      if (found === undefined) return missingBytes();
      const etag = `"${file.storageKey.slice(file.storageKey.lastIndexOf('/') + 1)}"`;
      if (request.headers['if-none-match'] === etag) {
        reply.header('etag', etag).header('cache-control', 'private, no-cache');
        return reply.code(304).send();
      }
      let bytes: Readable;
      let size = found.size;
      if (request.method === 'HEAD') {
        // An empty stream keeps Fastify from replacing the length.
        bytes = Readable.from([]);
      } else {
        // It may have gone since the stat (S3's sweep): still no file headers.
        const blob = await deps.blobs.getStream(file.storageKey);
        if (blob === undefined) return missingBytes();
        bytes = blob.stream;
        size = blob.size;
      }
      // SPEC-014 §4.8, D17: only the four raster images (and previews, which are WebP) render;
      // everything else downloads, under its own name.
      const showInline =
        !Download.safeParse(request.query).success &&
        (file.purpose === 'preview' || isImageType(file.mimeType));
      reply
        .header('etag', etag)
        .header('cache-control', 'private, no-cache')
        .header('content-disposition', showInline ? 'inline' : attachmentDisposition(file.name))
        .header(
          'content-type',
          file.mimeType === 'text/plain' ? 'text/plain; charset=utf-8' : file.mimeType,
        )
        .header('content-length', String(size));
      return reply.send(bytes);
    });

    done();
  });
}
