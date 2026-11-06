/**
 * Sync HTTP routes (SPEC-002 §4, sync-protocol §4). PLAN-002 S3: `GET /sync/bootstrap`. The
 * WebSocket (S4) and `POST /sync/mutate` (S5) join here.
 */
import { pipeline, Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { BOOTSTRAP_PATH, encodeNdjsonLine, NDJSON_CONTENT_TYPE } from '@surface/sync-protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { errorBody } from '../http/errors.js';
import { signedIn, type ActorResolver } from '../http/ops.js';
import type { Lifecycle } from '../lifecycle.js';
import { bootstrapFrames } from './bootstrap.js';
import type { SyncRegistry } from './registry.js';

export interface SyncRoutesDeps {
  readonly pool: pg.Pool;
  readonly registry: SyncRegistry;
  readonly resolveActor: ActorResolver;
  readonly lifecycle: Lifecycle;
  readonly now?: () => Date;
}

export function registerSyncRoutes(app: FastifyInstance, deps: SyncRoutesDeps): void {
  app.get(BOOTSTRAP_PATH, async (request, reply) => {
    const actor = await signedIn(request, reply, deps);
    if (!actor) return reply;
    if (actor.kind !== 'user') {
      // An API key's team limits (permissions.md §3.5) aren't sync groups; it reads through
      // the operations API instead.
      return reply
        .code(403)
        .send(
          errorBody(request, 'FORBIDDEN', 'Sync is for signed-in users. Use the operations API.'),
        );
    }
    if (hasQuery(request, 'groups')) {
      // Partial bootstrap comes with group changes (`G` packets, M7: SPEC-002 §2).
      return reply
        .code(400)
        .send(
          errorBody(
            request,
            'INVALID_INPUT',
            'Partial bootstrap is not supported yet. Request /sync/bootstrap without groups.',
          ),
        );
    }

    const frames = bootstrapFrames({
      pool: deps.pool,
      registry: deps.registry,
      groups: actor.groups,
      now: deps.now ?? (() => new Date()),
    });
    // Read the first frame before answering, so a database error is a 500, not a 200 with a
    // cut-off body.
    const first = await frames.next();
    const lines = Readable.from(
      (async function* () {
        try {
          if (!first.done) yield encodeNdjsonLine(first.value);
          for await (const frame of frames) yield encodeNdjsonLine(frame);
        } finally {
          // Closed after the first frame: end the snapshot and release its connection.
          await frames.return(undefined);
        }
      })(),
    );

    reply
      .header('content-type', NDJSON_CONTENT_TYPE)
      .header('cache-control', 'no-store')
      .header('vary', 'accept-encoding');
    const onError = (error: Error | null | undefined) => {
      // The response has started: the client sees a stream without `end` and starts over.
      if (error && !isClosedEarly(error)) request.log.error({ err: error }, 'bootstrap failed');
    };
    if (!acceptsGzip(request.headers['accept-encoding'])) {
      lines.on('error', onError);
      return reply.send(lines);
    }
    reply.header('content-encoding', 'gzip');
    return reply.send(pipeline(lines, createGzip(), onError));
  });
}

function hasQuery(request: FastifyRequest, name: string): boolean {
  const query = request.query;
  return typeof query === 'object' && query !== null && Object.hasOwn(query, name);
}

/** `gzip` listed in Accept-Encoding with a non-zero quality. */
export function acceptsGzip(header: string | undefined): boolean {
  return (header ?? '').split(',').some((part) => {
    const [coding = '', ...params] = part.trim().toLowerCase().split(';');
    if (coding.trim() !== 'gzip') return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

/** The client went away mid-stream: not an error worth logging. */
function isClosedEarly(error: Error): boolean {
  return Reflect.get(error, 'code') === 'ERR_STREAM_PREMATURE_CLOSE';
}
