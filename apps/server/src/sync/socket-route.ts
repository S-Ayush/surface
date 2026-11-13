/**
 * `GET /sync/ws` (sync-protocol §4.3, PLAN-002 S4): the WebSocket the hub delivers deltas on.
 *
 * Answered over HTTP, before the upgrade: `503` while the server starts or stops (the client
 * retries with backoff), `403` for a foreign `Origin` or an API key (SPEC-002 Q9) and `400` for invalid
 * connect parameters. Nobody signed in is different: the upgrade is accepted and closed at once
 * with `4001`, because a browser can't read a refused upgrade's status and would retry forever
 * (SPEC-002 E10). So is a replica of another user than the session's (E14), checked before the
 * `clientId`'s owner. A client that names no user (before v0.5) is accepted and told to reload.
 */
import websocket from '@fastify/websocket';
import type { Actor } from '@surface/domain';
import {
  CloseCode,
  decodeSocketConnectParams,
  MissingUserIdError,
  ProtocolError,
  SOCKET_PATH,
  type SocketConnectParams,
} from '@surface/sync-protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { errorBody, ROUTE_ERROR_STATUS } from '../http/errors.js';
import type { ActorResolver } from '../http/ops.js';
import type { Lifecycle } from '../lifecycle.js';
import { FOREIGN_CLIENT_MESSAGE } from './client-mutations.js';
import type { TeamAccess } from './groups.js';
import type { HubConnection, SyncHub } from './hub.js';

export interface SocketRouteDeps {
  readonly hub: SyncHub;
  readonly resolveActor: ActorResolver;
  readonly lifecycle: Lifecycle;
  /**
   * The only browser origin allowed to open the socket: `SURFACE_URL`'s. Browsers don't apply CORS
   * to WebSockets, so without it any page the user visits could read their deltas with their
   * session cookie (cross-site WebSocket hijacking, SPEC-002 §4.3).
   */
  readonly allowedOrigin: string;
  /** The session a request belongs to, for `hub.closeSessions` (sessions arrive in PLAN-001 S3). */
  readonly sessionIdOf?: (request: FastifyRequest) => string | undefined;
  /**
   * Who registered a `clientId` (`client_mutations`, PLAN-002 S5), if anyone. A socket for another
   * user's client is refused: it would see that client's acks.
   */
  readonly clientOwner?: (clientId: string) => Promise<string | undefined>;
  /**
   * Whether the request's session is still live, read again (`SessionAuth.sessionLive`). Asked
   * once the hub has registered the socket: a session revoked while the upgrade was admitted
   * was closed (`hub.closeSessions`) before there was a connection to close.
   */
  readonly sessionLive?: (request: FastifyRequest) => Promise<boolean>;
  /** Which of the URL's `teams` the user may follow (SPEC-011 §5.7). */
  readonly teamAccess: TeamAccess;
}

/**
 * A client sends `pong`, `subscribe` and `unsubscribe` (at most 100 team ids, about 3.9 KiB), and
 * small `presence` messages from M4.
 */
const MAX_CLIENT_MESSAGE_BYTES = 4096;
const UNSUPPORTED_DATA = 1003;
const INTERNAL_ERROR = 1011;

type Admitted =
  | {
      readonly kind: 'client';
      readonly actor: Actor & { readonly userId: string };
      readonly params: SocketConnectParams;
      /** The teams the connection follows from the start (SPEC-011 §5.7). */
      readonly teams: readonly string[];
    }
  /** A client from before v0.5, without `userId` (SPEC-002 E14): only `resync(schema)`. */
  | { readonly kind: 'outdated' };

export function registerSocketRoute(app: FastifyInstance, deps: SocketRouteDeps): void {
  // What the upgrade check decided, for the handler. Undefined: nobody signed in, or a session of
  // another user than the replica's (→ 4001).
  const admitted = new WeakMap<FastifyRequest, Admitted>();

  void app.register(websocket, { options: { maxPayload: MAX_CLIENT_MESSAGE_BYTES } });
  void app.register((scope, _options, done) => {
    scope.get(
      SOCKET_PATH,
      {
        websocket: true,
        preValidation: async (request, reply) => {
          if (deps.lifecycle.state !== 'ready' || !deps.hub.started) {
            return reply
              .code(ROUTE_ERROR_STATUS.UNAVAILABLE)
              .header('retry-after', '5')
              .send(
                errorBody(
                  request,
                  'UNAVAILABLE',
                  'Sync is not available yet. Try again in a few seconds.',
                ),
              );
          }
          // Checked before the session: a foreign page learns nothing, not even whether the
          // user is signed in. Non-browser clients send no Origin and are judged by their actor.
          const { origin } = request.headers;
          if (origin !== undefined && origin !== deps.allowedOrigin) {
            return reply
              .code(403)
              .send(
                errorBody(
                  request,
                  'FORBIDDEN',
                  'Sync accepts connections only from this server’s own address (SURFACE_URL).',
                ),
              );
          }
          const actor = await deps.resolveActor(request);
          if (actor === undefined) return; // accepted, then closed with 4001
          if (actor.kind !== 'user' || actor.userId === undefined) {
            return reply
              .code(403)
              .send(
                errorBody(
                  request,
                  'FORBIDDEN',
                  'Sync is for signed-in users. Use the operations API.',
                ),
              );
          }
          let params: SocketConnectParams;
          try {
            params = decodeSocketConnectParams(request.query);
          } catch (error) {
            if (error instanceof MissingUserIdError) {
              // Its clientId is neither checked nor registered: it only learns to reload.
              admitted.set(request, { kind: 'outdated' });
              return;
            }
            if (!(error instanceof ProtocolError)) throw error;
            return reply.code(400).send(errorBody(request, 'INVALID_INPUT', error.message));
          }
          // SPEC-002 E14, before the owner: a tab whose own user registered its clientId, opened
          // under another user's cookie, must re-check the session (4001), not get a 403 it can't
          // read and retries forever.
          if (params.userId !== actor.userId) return; // accepted, then closed with 4001
          const owner = await deps.clientOwner?.(params.clientId);
          if (owner !== undefined && owner !== actor.userId) {
            return reply.code(403).send(errorBody(request, 'FORBIDDEN', FOREIGN_CLIENT_MESSAGE));
          }
          // v0.8 (SPEC-011 §5.7): the URL's `teams`, checked now (so a team that turned private
          // can't be followed again), and answered with `subscribed`. Without them, the user's
          // member teams: what the full bootstrap holds (private ones are home groups anyway).
          const teams =
            params.teams === undefined
              ? actor.memberOf
              : await deps.teamAccess(actor.userId, params.teams);
          admitted.set(request, {
            kind: 'client',
            actor: { ...actor, userId: actor.userId },
            params,
            teams,
          });
        },
      },
      (socket, request) => {
        const entry = admitted.get(request);
        if (!entry) {
          socket.close(CloseCode.SessionRevoked, 'Sign in again');
          return;
        }
        const listen = (connection: HubConnection) => {
          socket.on('message', (data, isBinary) => {
            if (isBinary) socket.close(UNSUPPORTED_DATA, 'Text messages only');
            else connection.receive(textOf(data));
          });
          socket.on('close', () => connection.closed());
          socket.on('error', (error) => request.log.warn({ err: error }, 'sync socket error'));
        };
        const sessionId = deps.sessionIdOf?.(request);
        if (entry.kind === 'outdated') {
          listen(deps.hub.connectOutdated(socket, sessionId));
        } else {
          const { actor, params, teams } = entry;
          listen(
            deps.hub.connect(socket, {
              userId: actor.userId,
              ...(sessionId === undefined ? {} : { sessionId }),
              clientId: params.clientId,
              groups: actor.groups,
              teams,
              ackTeams: params.teams !== undefined,
              since: params.since,
              schemaHash: params.schemaHash,
            }),
          );
        }
        // PLAN-001 S9, security review L2. Every revocation commits, then calls `closeSessions`:
        // either this read sees it, or `closeSessions` runs after `connect` and finds the socket.
        const sessionLive = deps.sessionLive;
        if (sessionId !== undefined && sessionLive) {
          sessionLive(request).then(
            (live) => {
              if (!live) socket.close(CloseCode.SessionRevoked, 'Session revoked');
            },
            (error: unknown) => {
              request.log.error({ err: error }, 'could not check the sync socket’s session');
              socket.close(INTERNAL_ERROR, 'Try again');
            },
          );
        }
      },
    );
    done();
  });
}

/** A text frame's payload, however `ws` hands it over (one buffer, fragments, or an ArrayBuffer). */
function textOf(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return new TextDecoder().decode(data);
}
