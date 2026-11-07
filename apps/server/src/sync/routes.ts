/**
 * Sync HTTP routes (SPEC-002 §4, sync-protocol §4). PLAN-002 S3: `GET /sync/bootstrap`; S4: the
 * WebSocket (`socket-route.ts`); S5: `POST /sync/mutate` (`mutate.ts`).
 */
import { pipeline, Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { BOOTSTRAP_PATH, encodeNdjsonLine, NDJSON_CONTENT_TYPE } from '@surface/sync-protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { errorBody } from '../http/errors.js';
import { signedIn, type ActorResolver } from '../http/ops.js';
import type { Lifecycle } from '../lifecycle.js';
import { bootstrapFrames, type BootstrapPool } from './bootstrap.js';
import type { Executor } from '../executor/execute.js';
import type { SyncHub } from './hub.js';
import { registerMutateRoute } from './mutate.js';
import type { SyncRegistry } from './registry.js';
import { registerSocketRoute, type SocketRouteDeps } from './socket-route.js';

export interface SyncRoutesDeps {
  readonly pool: BootstrapPool;
  readonly registry: SyncRegistry;
  readonly resolveActor: ActorResolver;
  readonly lifecycle: Lifecycle;
  readonly now?: () => Date;
  /** The live-delta hub; without it there is no `/sync/ws` (e.g. the `worker` role). */
  readonly hub?: SyncHub;
  readonly sessionIdOf?: SocketRouteDeps['sessionIdOf'];
  readonly clientOwner?: SocketRouteDeps['clientOwner'];
  /** Runs `POST /sync/mutate`; without it there is no such route (tests without operations). */
  readonly executor?: Executor;
}

export function registerSyncRoutes(
  app: FastifyInstance,
  deps: SyncRoutesDeps & Pick<SocketRouteDeps, 'allowedOrigin'>,
): void {
  if (deps.hub) registerSocketRoute(app, { ...deps, hub: deps.hub });
  if (deps.executor) {
    registerMutateRoute(app, {
      ...deps,
      executor: deps.executor,
      schemaHash: deps.registry.schemaHash,
    });
  }
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
    // However early the client goes away (even while rows were being counted, before the stream
    // below has started), end the snapshot and release its connection. Once the stream has run to
    // its end this is a no-op.
    const stop = () => {
      frames.return(undefined).catch((err: unknown) => {
        request.log.error({ err }, 'bootstrap cleanup failed');
      });
    };
    reply.raw.once('close', stop);
    if (request.raw.destroyed || reply.raw.destroyed) {
      stop();
      return reply;
    }
    const lines = Readable.from(
      (async function* () {
        try {
          if (!first.done) yield encodeNdjsonLine(first.value);
          for await (const frame of frames) yield encodeNdjsonLine(frame);
        } finally {
          stop();
        }
      })(),
    );

    reply
      .header('content-type', NDJSON_CONTENT_TYPE)
      .header('cache-control', 'no-store')
      .header('vary', 'accept-encoding');
    // A stream that fails after the headers went out is logged by Fastify; the client sees a
    // stream without `end` and starts over.
    if (!acceptsGzip(request.headers['accept-encoding'])) return reply.send(lines);
    reply.header('content-encoding', 'gzip');
    // `pipeline` passes an error on to the gzip stream, where Fastify sees it.
    return reply.send(pipeline(lines, createGzip(), () => {}));
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
