/**
 * `POST /sync/mutate` (sync-protocol.md §4.4, SPEC-002 §4.4): ordered,
 * idempotent batches of operations keyed by `(clientId, seq)`.
 */
import { z } from 'zod';
import { decodeWith } from './errors.js';
import { requireUserId } from './user-id.js';
import {
  clientIdSchema,
  errorCodeSchema,
  operationNameSchema,
  schemaHashSchema,
  seqSchema,
  syncIdSchema,
  userIdSchema,
} from './scalars.js';

export const MUTATE_PATH = '/sync/mutate';

/** sync-protocol.md §9. The byte limit is enforced by the server's body limit. */
export const MAX_MUTATIONS_PER_BATCH = 100;
export const MAX_MUTATION_BATCH_BYTES = 1_048_576;

/** Error codes specific to the mutate endpoint (on top of the SPEC-003 §9 codes). */
export const MutateErrorCode = {
  /** HTTP 426: the client's `schemaHash` differs from the server's; reload (SPEC-002 E7). */
  ClientOutdated: 'CLIENT_OUTDATED',
  /** HTTP 400: the batch starts after `lastSeq + 1`; resend from `lastSeq + 1`. */
  SeqGap: 'SEQ_GAP',
} as const;

/** Rejects a list of seqs that is not strictly consecutive and ascending. */
function checkConsecutiveSeqs(seqs: readonly number[], field: string, ctx: z.RefinementCtx): void {
  seqs.forEach((seq, index) => {
    const previous = seqs[index - 1];
    if (previous !== undefined && seq !== previous + 1) {
      ctx.addIssue({
        code: 'custom',
        path: [field, index, 'seq'],
        message: 'seqs in a batch must be consecutive and ascending',
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Request

/** One operation call. `at` is informational only; ordering comes from the server (SPEC-002 E11). */
export const mutationSchema = z.object({
  seq: seqSchema,
  op: operationNameSchema,
  input: z.json(),
  at: z.iso.datetime({ offset: true }).optional(),
});
export type Mutation = z.infer<typeof mutationSchema>;

export const mutateRequestSchema = z
  .object({
    clientId: clientIdSchema,
    /** The user the client's queue belongs to; the session must be the same user (SPEC-002 E14). */
    userId: userIdSchema,
    schemaHash: schemaHashSchema,
    mutations: z.array(mutationSchema).min(1).max(MAX_MUTATIONS_PER_BATCH),
  })
  .superRefine((request, ctx) => {
    checkConsecutiveSeqs(
      request.mutations.map((m) => m.seq),
      'mutations',
      ctx,
    );
  });
export type MutateRequest = z.infer<typeof mutateRequestSchema>;

// ---------------------------------------------------------------------------
// Response (HTTP 200)

/**
 * The mutation committed. The client treats it as confirmed once its own
 * `lastSyncId` reaches `lastSyncId`, or an `ack` for its seq arrives.
 */
export const mutationOkSchema = z.object({
  seq: seqSchema,
  status: z.literal('ok'),
  lastSyncId: syncIdSchema,
});

/**
 * One problem with a field of the input, as the operations API reports it
 * (SPEC-003 §9): `path` names the field, so a form can show it there.
 */
export const mutationIssueSchema = z.object({
  path: z.array(z.union([z.string(), z.number().int().nonnegative()])),
  message: z.string(),
  hint: z.string().optional(),
});

/**
 * The server rejected the mutation; the client drops it and rolls back (SPEC-002 §3.5).
 * `issues` (v0.6) are the ones the operations API returns for the same error; older
 * servers send none.
 */
export const mutationErrorSchema = z.object({
  seq: seqSchema,
  status: z.literal('error'),
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    issues: z.array(mutationIssueSchema).optional(),
  }),
});

export const mutationResultSchema = z.discriminatedUnion('status', [
  mutationOkSchema,
  mutationErrorSchema,
]);

/** One result per mutation in the request, in seq order. Replayed seqs get their stored result. */
export const mutateResponseSchema = z
  .object({ results: z.array(mutationResultSchema) })
  .superRefine((response, ctx) => {
    checkConsecutiveSeqs(
      response.results.map((r) => r.seq),
      'results',
      ctx,
    );
  });

export type MutationOk = z.infer<typeof mutationOkSchema>;
export type MutationIssue = z.infer<typeof mutationIssueSchema>;
export type MutationError = z.infer<typeof mutationErrorSchema>;
export type MutationResult = z.infer<typeof mutationResultSchema>;
export type MutateResponse = z.infer<typeof mutateResponseSchema>;

// ---------------------------------------------------------------------------
// Whole-request failure (HTTP 4xx/5xx), in the SPEC-003 §9 error shape

/** `lastSeq` is set on `SEQ_GAP`: the last seq the server has processed for this client. */
export const mutateErrorBodySchema = z.object({
  ok: z.literal(false),
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    correlationId: z.string(),
    lastSeq: z.int().nonnegative().optional(),
  }),
});
export type MutateErrorBody = z.infer<typeof mutateErrorBodySchema>;

/**
 * Validate a `POST /sync/mutate` body on the server. Throws `MissingUserIdError`
 * (answer `426`) when it has no `userId`, else `ProtocolError` (answer `400`).
 */
export function decodeMutateRequest(body: unknown): MutateRequest {
  requireUserId(body, 'mutate request');
  return decodeWith(mutateRequestSchema, body, 'mutate request');
}

/** Validate a 200 response on the client. Throws `ProtocolError`. */
export function decodeMutateResponse(body: unknown): MutateResponse {
  return decodeWith(mutateResponseSchema, body, 'mutate response');
}

/** Validate an error response on the client. Throws `ProtocolError`. */
export function decodeMutateErrorBody(body: unknown): MutateErrorBody {
  return decodeWith(mutateErrorBodySchema, body, 'mutate error');
}
