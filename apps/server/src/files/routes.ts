/**
 * Uploading and serving files (ADR-0014; PLAN-001 S6: avatars and the workspace logo only).
 *
 * - `POST /files/upload?purpose=avatar|logo`, the image as the raw body (any `Content-Type`: the type
 *   comes from the bytes). At most 2 MB, refused with `413` before it is read when the size is
 *   declared. The image is stored as a 256 px square (`image.ts`) with a server-only `files` row,
 *   and the answer is its id: setting it as the avatar or logo is an operation
 *   (`user.updateProfile`, `workspace.update`), so synced rows change only through the repo.
 *   A logo needs an Admin. CSRF is the app-wide check for cookie-authenticated POSTs (Q7).
 * - `GET /files/:id` answers the bytes to a signed-in user who may see them (`store.ts`): a file
 *   anyone else can't see is `404`, like a missing one. Every request is checked; the browser
 *   revalidates with the ETag (`no-cache`), and the bytes of an id never change.
 *
 * Both need a session, and answer `503` until setup is done (SPEC-001 Q5, the setup guard).
 */
import type {
  FastifyBaseLogger,
  FastifyError,
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { z } from 'zod';
import type { SessionAuth } from '../auth/sessions.js';
import { FILE_PURPOSES } from '../db/schema/index.js';
import { uuidv7 } from '../db/uuidv7.js';
import { tokenBucket } from '../executor/rate-limit.js';
import type { WithTransaction } from '../executor/transaction.js';
import { errorBody } from '../http/errors.js';
import type { Lifecycle } from '../lifecycle.js';
import { unavailable } from '../handlers/account/sign-in.js';
import type { BlobStore } from './blob-store.js';
import {
  imageProcessor,
  ImagesUnavailable,
  sniffImage,
  UnreadableImage,
  type LoadSharp,
} from './image.js';
import { PG_FILE_STORE, type FileStore } from './store.js';

export const FILES_PATH = '/files';
/**
 * Under `/files/`, like the downloads: the setup guard, the SPA fallback, the dev proxy and the
 * offline cache all treat that prefix as the server's (PLAN-001 S6 deviation from `POST /files`).
 */
export const UPLOAD_PATH = '/files/upload';
export const FILE_PATH = '/files/:id';

/** SPEC-001 §3.5: avatars are at most 2 MB; `UPLOAD_MAX_MB` may only lower it. */
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;

export const IMAGE_TOO_LARGE_MESSAGE = 'Images must be 2 MB or smaller. Choose a smaller image.';
export const IMAGE_TYPE_MESSAGE = 'Use a PNG, JPEG, GIF or WebP image.';
export const IMAGE_UNREADABLE_MESSAGE =
  'That image could not be read. Try saving it again as a PNG or JPEG.';
/**
 * Uploads per user per minute. Each costs a sharp decode and a stored file, and the route isn't an
 * operation, so the executor's limit doesn't apply (S9 security review L3). Setting an avatar or
 * logo takes one; a few retries fit.
 */
export const UPLOADS_PER_MINUTE = 10;

export const IMAGES_UNAVAILABLE_MESSAGE =
  'Image uploads are unavailable on this server. Ask an Admin to check the server log.';

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
  readonly store?: FileStore;
  readonly loadSharp?: LoadSharp;
}

const Query = z.object({ purpose: z.enum(FILE_PURPOSES) });
const Params = z.object({ id: z.uuid() });

const EXTENSIONS: Record<string, string> = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
};

export function registerFileRoutes(app: FastifyInstance, deps: FileRouteDeps): void {
  const store = deps.store ?? PG_FILE_STORE;
  const process = imageProcessor(deps.log, deps.loadSharp);
  const limit = Math.min(IMAGE_MAX_BYTES, deps.uploadMaxMb * 1024 * 1024);
  // In memory, per process: like the executor's limiter, several replicas each allow the rate.
  const uploads = tokenBucket({ queriesPerMinute: 0, mutationsPerMinute: UPLOADS_PER_MINUTE });

  const refuse = (
    request: FastifyRequest,
    reply: FastifyReply,
    status: number,
    code: string,
    message: string,
  ) => reply.code(status).send(errorBody(request, code, message));

  const signedOut = (request: FastifyRequest, reply: FastifyReply, upload = false) =>
    refuse(
      request,
      reply,
      401,
      'UNAUTHENTICATED',
      upload ? 'Log in to upload an image.' : 'Log in to see this file.',
    );

  const notFound = (request: FastifyRequest, reply: FastifyReply) =>
    refuse(request, reply, 404, 'NOT_FOUND', 'File not found. It may have been replaced.');

  // Its own scope, so the raw-body parser applies to these routes only.
  void app.register((scope, _options, done) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: limit }, (_req, body, next) =>
      next(null, body),
    );
    scope.setErrorHandler((error: FastifyError, request, reply) => {
      // An undeclared size that turns out too large: Fastify stops reading at the limit.
      if (error.statusCode === 413) {
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
      bodyLimit: limit,
      // A declared size over the limit is refused before a byte of the body is read.
      onRequest: async (request, reply) => {
        const declared = Number(request.headers['content-length']);
        if (Number.isFinite(declared) && declared > limit) {
          await refuse(request, reply, 413, 'INVALID_INPUT', IMAGE_TOO_LARGE_MESSAGE);
        }
      },
      handler: async (request, reply) => {
        if (!deps.lifecycle.everReady) return unavailable(request, reply);
        const session = await deps.auth.session(request);
        if (session === undefined) return signedOut(request, reply, true);
        const query = Query.safeParse(request.query);
        if (!query.success) {
          return refuse(
            request,
            reply,
            400,
            'INVALID_INPUT',
            'Say what the image is for: ?purpose=avatar or ?purpose=logo.',
          );
        }
        // Before the body is decoded, so a refused upload costs nothing.
        const rate = uploads.take(session.actor, 'mutation');
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
        const purpose = query.data.purpose;
        if (purpose === 'logo' && session.actor.role !== 'admin') {
          return refuse(
            request,
            reply,
            403,
            'FORBIDDEN',
            'Only Admins can change the workspace logo.',
          );
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
          image = await process(body);
        } catch (error) {
          if (error instanceof UnreadableImage) {
            return refuse(request, reply, 400, 'INVALID_INPUT', IMAGE_UNREADABLE_MESSAGE);
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
      },
    });

    scope.get(FILE_PATH, async (request, reply) => {
      if (!deps.lifecycle.everReady) return unavailable(request, reply);
      const session = await deps.auth.session(request);
      if (session === undefined) return signedOut(request, reply);
      const params = Params.safeParse(request.params);
      if (!params.success) return notFound(request, reply);
      const file = await deps.withTransaction((client) =>
        store.readable(client, params.data.id.toLowerCase(), session.userId),
      );
      if (file === undefined) return notFound(request, reply);
      const etag = `"${file.storageKey.slice(file.storageKey.lastIndexOf('/') + 1)}"`;
      reply
        .header('etag', etag)
        .header('cache-control', 'private, no-cache')
        .header('content-disposition', 'inline');
      if (request.headers['if-none-match'] === etag) return reply.code(304).send();
      const bytes = await deps.blobs.get(file.storageKey);
      if (bytes === undefined) {
        request.log.warn({ fileId: params.data.id }, 'file row without its bytes');
        return notFound(request, reply);
      }
      return reply.header('content-type', file.mimeType).send(bytes);
    });

    done();
  });
}
