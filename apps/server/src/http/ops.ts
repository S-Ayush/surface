/**
 * Operations over HTTP (SPEC-003 §9): `POST /api/ops/:name` runs one through the executor,
 * `GET /api/ops` lists what the caller may run, and `GET /api/openapi.json` describes every
 * public operation. All three are generated from the registry: no per-operation code (AC-1).
 */
import type { Actor } from '@surface/domain';
import {
  catalogEntry,
  isPublicOperation,
  toOpenApi,
  type OperationRegistry,
} from '@surface/operations';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HTTP_STATUS, type OperationError } from '../executor/errors.js';
import type { ExecuteResult, Executor } from '../executor/execute.js';
import type { Lifecycle } from '../lifecycle.js';
import { errorBody, ROUTE_ERROR_STATUS } from './errors.js';

/**
 * Who sent a request, or `undefined` for nobody. Sessions (PLAN-001 S3) and API keys (M6)
 * implement this; the session one also checks the CSRF header.
 */
export type ActorResolver = (request: FastifyRequest) => Promise<Actor | undefined>;

export interface OpsRoutesDeps {
  readonly executor: Executor;
  readonly registry: OperationRegistry;
  readonly resolveActor: ActorResolver;
  readonly lifecycle: Lifecycle;
  readonly version: string;
}

const RequestBody = z.strictObject({
  input: z.unknown().default({}),
  fields: z.array(z.string()).optional(),
  clientMutationId: z.string().optional(),
});

export function registerOpsRoutes(app: FastifyInstance, deps: OpsRoutesDeps): void {
  // Public operations only, so the document is the same for everyone and safe to cache.
  let openApi: string | undefined;
  app.get('/api/openapi.json', async (_request, reply) => {
    openApi ??= JSON.stringify(
      toOpenApi(deps.registry.list().filter(isPublicOperation), { version: deps.version }),
    );
    return reply.type('application/json').send(openApi);
  });

  app.get('/api/ops', async (request, reply) => {
    const actor = await signedIn(request, reply, deps);
    if (!actor) return reply;
    const operations = deps.executor.operations(actor).map(catalogEntry);
    return reply.send({ ok: true, result: { operations } });
  });

  app.post<{ Params: { name: string } }>('/api/ops/:name', async (request, reply) => {
    const actor = await signedIn(request, reply, deps);
    if (!actor) return reply;

    const body = RequestBody.safeParse(request.body ?? {});
    if (!body.success) {
      const issues = body.error.issues.map((issue) => ({
        path: issue.path.filter((p): p is string | number => typeof p !== 'symbol'),
        message: issue.message,
      }));
      const message =
        'The request body must be { "input": {...}, "fields"?: [...], "clientMutationId"?: "..." }.';
      return reply.code(400).send({
        ok: false,
        error: { code: 'INVALID_INPUT', message, issues, correlationId: request.id },
      });
    }

    const { input, fields, clientMutationId } = body.data;
    const result = await deps.executor.execute(request.params.name, input, actor, {
      correlationId: request.id,
      ...(fields === undefined ? {} : { fields }),
      ...(clientMutationId === undefined ? {} : { clientMutationId }),
    });
    return sendResult(reply, result);
  });
}

/**
 * The actor, or `undefined` after answering 503 (starting) or 401 (nobody signed in). Shared
 * with the sync routes (`sync/routes.ts`).
 */
export async function signedIn(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: Pick<OpsRoutesDeps, 'lifecycle' | 'resolveActor'>,
): Promise<Actor | undefined> {
  // Until startup has finished, even if draining began meanwhile (a session lookup reads tables).
  if (!deps.lifecycle.everReady) {
    // Migrations may still be running; tables an operation needs may not exist yet.
    await reply
      .code(ROUTE_ERROR_STATUS.UNAVAILABLE)
      .header('retry-after', '5')
      .send(errorBody(request, 'UNAVAILABLE', 'Surface is starting. Try again in a few seconds.'));
    return undefined;
  }
  const actor = await deps.resolveActor(request);
  if (actor) return actor;
  await reply.code(401).send(errorBody(request, 'UNAUTHENTICATED', 'Sign in to use the API.'));
  return undefined;
}

function sendResult(reply: FastifyReply, result: ExecuteResult): FastifyReply {
  if (!result.ok) {
    const error: OperationError = result.error;
    if (error.retryAfter !== undefined) reply.header('retry-after', String(error.retryAfter));
    return reply.code(HTTP_STATUS[error.code]).send({ ok: false, error });
  }
  // A replay's body is the stored one exactly (AC-8); the header says it is a replay.
  const { replayed, ...body } = result;
  if (replayed) reply.header('idempotent-replayed', 'true');
  return reply.code(200).send(body);
}
