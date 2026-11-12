/**
 * Whose replica and queue a sync request is for (SPEC-002 E14, sync-protocol v0.5). The client
 * names its user (`userId`) on bootstrap, mutate and the socket; the server compares it with the
 * session's user before anything is streamed, run or registered. Otherwise a tab could carry on
 * under whoever signs in next on the browser: its queue committed as them, their rows streamed
 * into its replica (a leak, permissions.md §5).
 */
import { MutateErrorCode } from '@surface/sync-protocol';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HTTP_STATUS } from '../executor/errors.js';
import { errorBody } from '../http/errors.js';

/**
 * `426 CLIENT_OUTDATED`: another schema hash, or no `userId` (a client from before v0.5). The client
 * acts on the code and shows the reload banner, keeping its queue.
 */
export function sendClientOutdated(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply
    .code(HTTP_STATUS.CLIENT_OUTDATED)
    .send(
      errorBody(
        request,
        MutateErrorCode.ClientOutdated,
        'Surface was updated. Reload the page to continue.',
      ),
    );
}

/**
 * `401`: the session belongs to a user other than the client's. Answered like a signed-out session,
 * so the client keeps its queue and the app checks who is signed in (SPEC-001 E14).
 */
export function sendOtherUser(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply
    .code(401)
    .send(
      errorBody(
        request,
        'UNAUTHENTICATED',
        'Someone else is signed in on this browser now. Reload the page to continue.',
      ),
    );
}
