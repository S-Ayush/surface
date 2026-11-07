/**
 * `GET /sync/ws` (sync-protocol §4.3, PLAN-002 S4): the WebSocket the hub delivers deltas on.
 *
 * Answered over HTTP, before the upgrade: `503` while the server starts or stops (the client
 * retries with backoff), `403` for a foreign `Origin` or an API key (SPEC-002 Q9) and `400` for invalid
 * connect parameters. Nobody signed in is different: the upgrade is accepted and closed at once
 * with `4001`, because a browser can't read a refused upgrade's status and would retry forever
 * (SPEC-002 E10).
 */
import websocket from '@fastify/websocket';
import type { Actor } from '@surface/domain';
import {
  CloseCode,
  decodeSocketConnectParams,
  ProtocolError,
  SOCKET_PATH,
  type SocketConnectParams,
} from '@surface/sync-protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { errorBody, ROUTE_ERROR_STATUS } from '../http/errors.js';
import type { ActorResolver } from '../http/ops.js';
import type { Lifecycle } from '../lifecycle.js';
import type { SyncHub } from './hub.js';

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
}

/** A client sends only `pong` (and small `presence` messages from M4). */
const MAX_CLIENT_MESSAGE_BYTES = 4096;
const UNSUPPORTED_DATA = 1003;

interface Admitted {
  readonly actor: Actor & { readonly userId: string };
  readonly params: SocketConnectParams;
}

export function registerSocketRoute(app: FastifyInstance, deps: SocketRouteDeps): void {
  // What the upgrade check decided, for the handler. Undefined: nobody signed in (→ 4001).
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
            if (!(error instanceof ProtocolError)) throw error;
            return reply.code(400).send(errorBody(request, 'INVALID_INPUT', error.message));
          }
          const owner = await deps.clientOwner?.(params.clientId);
          if (owner !== undefined && owner !== actor.userId) {
            return reply
              .code(403)
              .send(
                errorBody(
                  request,
                  'FORBIDDEN',
                  'This clientId belongs to another user. Start a new queue with a new clientId.',
                ),
              );
          }
          admitted.set(request, { actor: { ...actor, userId: actor.userId }, params });
        },
      },
      (socket, request) => {
        const entry = admitted.get(request);
        if (!entry) {
          socket.close(CloseCode.SessionRevoked, 'Sign in again');
          return;
        }
        const { actor, params } = entry;
        const sessionId = deps.sessionIdOf?.(request);
        const connection = deps.hub.connect(socket, {
          userId: actor.userId,
          ...(sessionId === undefined ? {} : { sessionId }),
          clientId: params.clientId,
          groups: actor.groups,
          since: params.since,
          schemaHash: params.schemaHash,
        });
        socket.on('message', (data, isBinary) => {
          if (isBinary) socket.close(UNSUPPORTED_DATA, 'Text messages only');
          else connection.receive(textOf(data));
        });
        socket.on('close', () => connection.closed());
        socket.on('error', (error) => request.log.warn({ err: error }, 'sync socket error'));
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
