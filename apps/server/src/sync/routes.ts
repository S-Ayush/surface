/**
 * Sync HTTP routes (SPEC-002 §4, sync-protocol §4). PLAN-002 S3: `GET /sync/bootstrap`; S4: the
 * WebSocket (`socket-route.ts`); S5: `POST /sync/mutate` (`mutate.ts`). PLAN-011 S5a:
 * `GET /sync/content` (`content.ts`).
 */
import { pipeline, Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import { teamGroup } from '@surface/domain';
import {
  BOOTSTRAP_PATH,
  CONTENT_PATH,
  decodeBootstrapQuery,
  decodeContentQuery,
  encodeNdjsonLine,
  MissingUserIdError,
  NDJSON_CONTENT_TYPE,
  ProtocolError,
  type BootstrapQuery,
  type ContentFrame,
  type ContentQuery,
} from '@surface/sync-protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { errorBody } from '../http/errors.js';
import { signedIn, type ActorResolver } from '../http/ops.js';
import type { Lifecycle } from '../lifecycle.js';
import { bootstrapFrames, type BootstrapPool } from './bootstrap.js';
import { contentFrames } from './content.js';
import { acceptedTeams, connectionGroups, memberGroups, type TeamAccess } from './groups.js';
import type { Executor } from '../executor/execute.js';
import type { SyncHub } from './hub.js';
import { sendClientOutdated, sendOtherUser } from './identity.js';
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
  readonly sessionLive?: SocketRouteDeps['sessionLive'];
  /** Runs `POST /sync/mutate`; without it there is no such route (tests without operations). */
  readonly executor?: Executor;
  /**
   * Which teams a user may follow (SPEC-011 §5.7), for the partial bootstrap and the socket URL's
   * `teams`; `serve()` passes the hub's. Default (tests): `acceptedTeams` over `pool`.
   */
  readonly teamAccess?: TeamAccess;
}

/** `acceptedTeams` on a connection of the bootstrap pool. */
export function poolTeamAccess(pool: BootstrapPool): TeamAccess {
  return async (userId, teamIds) => {
    if (teamIds.length === 0) return [];
    const client = await pool.connect();
    try {
      return await acceptedTeams(client, userId, teamIds);
    } finally {
      client.release();
    }
  };
}

export function registerSyncRoutes(
  app: FastifyInstance,
  deps: SyncRoutesDeps & Pick<SocketRouteDeps, 'allowedOrigin'>,
): void {
  const teamAccess = deps.teamAccess ?? poolTeamAccess(deps.pool);
  if (deps.hub) registerSocketRoute(app, { ...deps, hub: deps.hub, teamAccess });
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
    let query: BootstrapQuery;
    try {
      query = decodeBootstrapQuery(request.query);
    } catch (error) {
      if (error instanceof MissingUserIdError) return sendClientOutdated(request, reply);
      if (!(error instanceof ProtocolError)) throw error;
      return reply.code(400).send(errorBody(request, 'INVALID_INPUT', error.message));
    }
    // SPEC-002 E14: another user's replica never receives this user's rows.
    if (query.userId !== actor.userId) return sendOtherUser(request, reply);
    // A client with another schema hash is outdated, before the first frame (a partial
    // bootstrap must send one: the codec refuses `groups` without it, SPEC-011 §5.7).
    if (query.schemaHash !== undefined && query.schemaHash !== deps.registry.schemaHash) {
      return sendClientOutdated(request, reply);
    }
    // The partial bootstrap (v0.8, SPEC-011 §5.7): the Issue rows of the teams the user may
    // follow. An unknown team and a private team the user isn't in are dropped alike, so their
    // answers are the same empty stream (AC-28, E32), never an error.
    // Rows are cut to the connection's groups (home plus the accepted teams), so a public issue
    // keeps the user's own `user:<id>` group and stays theirs after an unsubscribe.
    const accepted =
      query.groups === undefined
        ? undefined
        : await teamAccess(
            actor.userId,
            query.groups.map((group) => group.slice(teamGroup('').length)),
          );
    const frames = bootstrapFrames({
      pool: deps.pool,
      registry: deps.registry,
      now: deps.now ?? (() => new Date()),
      ...(accepted === undefined
        ? { groups: memberGroups(actor) }
        : {
            groups: accepted.map(teamGroup),
            cutTo: connectionGroups(actor, accepted),
            partial: true,
          }),
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

    return sendNdjson(request, reply, lines);
  });

  // SPEC-011 §5.2 (PLAN-011 S5a): content per issue. The same checks as bootstrap, in the same
  // order, plus the schema hash, all before the first frame.
  app.get(CONTENT_PATH, async (request, reply) => {
    const actor = await signedIn(request, reply, deps);
    if (!actor) return reply;
    if (actor.kind !== 'user') {
      return reply
        .code(403)
        .send(
          errorBody(
            request,
            'FORBIDDEN',
            'Sync is for signed-in users. Use issue.get in the operations API.',
          ),
        );
    }
    let query: ContentQuery;
    try {
      query = decodeContentQuery(request.query);
    } catch (error) {
      if (error instanceof MissingUserIdError) return sendClientOutdated(request, reply);
      if (!(error instanceof ProtocolError)) throw error;
      return reply.code(400).send(errorBody(request, 'INVALID_INPUT', error.message));
    }
    if (query.userId !== actor.userId) return sendOtherUser(request, reply);
    if (query.schemaHash !== deps.registry.schemaHash) return sendClientOutdated(request, reply);
    // Read whole before answering, so a database error is a 500, not a 200 with a cut-off body.
    const frames = await contentFrames({
      pool: deps.pool,
      registry: deps.registry,
      actor,
      parents: query.parents,
    });
    // Encoded one line at a time as the stream pulls, so the rows and their JSON aren't held
    // twice. The answer itself is unbounded until S6 sets a budget (PLAN-011 S5a As built).
    return sendNdjson(request, reply, Readable.from(encodeLines(frames)));
  });
}

function* encodeLines(frames: readonly ContentFrame[]): Generator<string> {
  for (const frame of frames) yield encodeNdjsonLine(frame);
}

/** Sends NDJSON lines, gzip-encoded when the client accepts it (sync-protocol §4.1, §4.2). */
function sendNdjson(request: FastifyRequest, reply: FastifyReply, lines: Readable): FastifyReply {
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
