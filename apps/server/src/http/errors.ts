/**
 * HTTP error bodies follow the operation error model (SPEC-003 §9):
 * `{ ok: false, error: { code, message, correlationId } }`.
 */
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface ErrorBody {
  ok: false;
  error: { code: string; message: string; correlationId: string };
}

export function errorBody(request: FastifyRequest, code: string, message: string): ErrorBody {
  return { ok: false, error: { code, message, correlationId: request.id } };
}

export function sendNotFound(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply
    .code(404)
    .send(
      errorBody(
        request,
        'NOT_FOUND',
        `No route for ${request.method} ${request.url.split('?')[0]}`,
      ),
    );
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;
    if (status >= 500) {
      // Never leak internals: log the details, return a generic message.
      request.log.error({ err: error }, 'request failed');
      return reply
        .code(500)
        .send(errorBody(request, 'INTERNAL', 'Something went wrong. The error has been logged.'));
    }
    return reply.code(status).send(errorBody(request, 'INVALID_REQUEST', error.message));
  });
}
