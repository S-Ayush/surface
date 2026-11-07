/**
 * `POST /sync/mutate` (SPEC-002 §4.4, sync-protocol §4.4, PLAN-002 S5): a sync client's batch of
 * mutations, each run exactly once per `(clientId, seq)` in its own transaction
 * (`Executor.executeSynced`). The CSRF check is the auth routes' `onRequest` hook.
 */
import {
  decodeMutateRequest,
  MAX_MUTATION_BATCH_BYTES,
  MUTATE_PATH,
  MutateErrorCode,
  ProtocolError,
  type MutateErrorBody,
  type MutateRequest,
  type MutateResponse,
  type MutationResult,
} from '@surface/sync-protocol';
import type { FastifyInstance } from 'fastify';
import { HTTP_STATUS } from '../executor/errors.js';
import type { Executor } from '../executor/execute.js';
import { errorBody } from '../http/errors.js';
import { signedIn, type ActorResolver } from '../http/ops.js';
import type { Lifecycle } from '../lifecycle.js';

/**
 * sync-protocol §4.4. Only this route answers it, so it is not in `ROUTE_ERROR_STATUS`, which lists
 * what the operations API answers.
 */
const SEQ_GAP_STATUS = 400;

export interface MutateRouteDeps {
  readonly executor: Executor;
  readonly resolveActor: ActorResolver;
  readonly lifecycle: Lifecycle;
  /** The server's `schemaHash` (`SyncRegistry.schemaHash`): a client with another is outdated. */
  readonly schemaHash: string;
}

export function registerMutateRoute(app: FastifyInstance, deps: MutateRouteDeps): void {
  // A larger body is answered 413 before it is read (sync-protocol §4.4, §9).
  app.post(MUTATE_PATH, { bodyLimit: MAX_MUTATION_BATCH_BYTES }, async (request, reply) => {
    // Every answer: a `SEQ_GAP`'s `lastSeq` or a replayed result is as stale as a 200's.
    reply.header('cache-control', 'no-store');
    const actor = await signedIn(request, reply, deps);
    if (!actor) return reply;
    if (actor.kind !== 'user') {
      // As for bootstrap (SPEC-002 Q7): keys write through the operations API. The executor
      // refuses them too (`executeSynced`); this answers before the body is even decoded.
      return reply
        .code(403)
        .send(
          errorBody(request, 'FORBIDDEN', 'Sync is for signed-in users. Use the operations API.'),
        );
    }

    let batch: MutateRequest;
    try {
      batch = decodeMutateRequest(request.body);
    } catch (error) {
      if (!(error instanceof ProtocolError)) throw error;
      return reply.code(400).send(errorBody(request, 'INVALID_INPUT', error.message));
    }
    if (batch.schemaHash !== deps.schemaHash) {
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

    // In seq order, one at a time: each waits for the one before it to commit.
    const results: MutationResult[] = [];
    for (const mutation of batch.mutations) {
      const outcome = await deps.executor.executeSynced(
        mutation.op,
        mutation.input,
        actor,
        { clientId: batch.clientId, seq: mutation.seq },
        { correlationId: request.id },
      );
      switch (outcome.kind) {
        case 'result':
          results.push(outcome.result);
          continue;
        case 'gap': {
          // Only the first mutation can find a gap; results already committed are replayed
          // when the client resends from `lastSeq + 1`.
          const body: MutateErrorBody = {
            ok: false,
            error: {
              ...errorBody(
                request,
                MutateErrorCode.SeqGap,
                `Expected change ${outcome.lastSeq + 1} next. Resend from there.`,
              ).error,
              lastSeq: outcome.lastSeq,
            },
          };
          return reply.code(SEQ_GAP_STATUS).send(body);
        }
        case 'refused': {
          // Mutations before it in this batch are committed, and replayed when it is resent
          // (SPEC-002 Q12): a rate limit stops the batch rather than rejecting what is left.
          const { error } = outcome;
          if (error.retryAfter !== undefined) reply.header('retry-after', String(error.retryAfter));
          return reply.code(HTTP_STATUS[error.code]).send({
            ok: false,
            error: { code: error.code, message: error.message, correlationId: error.correlationId },
          });
        }
      }
    }
    const response: MutateResponse = { results };
    return reply.send(response);
  });
}
