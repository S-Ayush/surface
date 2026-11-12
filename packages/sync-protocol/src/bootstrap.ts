/**
 * `GET /sync/bootstrap` frames (sync-protocol.md §4.1). The body is NDJSON:
 * one `meta`, then any number of `row`, then one `end`.
 */
import { z } from 'zod';
import { decodeWith } from './errors.js';
import { requireUserId } from './user-id.js';
import {
  modelNameSchema,
  rowSchema,
  schemaHashSchema,
  syncGroupSchema,
  syncIdSchema,
  userIdSchema,
} from './scalars.js';

export const BOOTSTRAP_PATH = '/sync/bootstrap';
export const NDJSON_CONTENT_TYPE = 'application/x-ndjson';

/**
 * Query string of `GET /sync/bootstrap`. `userId` is the user the client's
 * replica belongs to; the session must be the same user (SPEC-002 E14). Other
 * parameters are dropped here and judged by the server (`groups`, say).
 */
export const bootstrapQuerySchema = z.object({ userId: userIdSchema });
export type BootstrapQuery = z.infer<typeof bootstrapQuerySchema>;

/** Build the query string (without `?`) for `GET /sync/bootstrap`. */
export function encodeBootstrapQuery(query: BootstrapQuery): string {
  return new URLSearchParams({ userId: query.userId }).toString();
}

/**
 * Validate the parsed query of `GET /sync/bootstrap`. Throws `MissingUserIdError`
 * (answer `426`) when it has no `userId`, else `ProtocolError` (answer `400`).
 */
export function decodeBootstrapQuery(query: unknown): BootstrapQuery {
  requireUserId(query, 'bootstrap query');
  return decodeWith(bootstrapQuerySchema, query, 'bootstrap query');
}

/** First frame. The rows that follow are consistent with `lastSyncId` (one REPEATABLE READ snapshot). */
export const bootstrapMetaSchema = z.object({
  t: z.literal('meta'),
  schemaHash: schemaHashSchema,
  lastSyncId: syncIdSchema,
  groups: z.array(syncGroupSchema),
  serverTime: z.iso.datetime({ offset: true }),
  /** Exact number of `row` frames that follow (same snapshot), for the progress bar (SPEC-002 §7). */
  rows: z.int().nonnegative(),
});

/**
 * `archived: true` marks a row the server has archived; absent or `false`
 * means live. Clients keep archived rows, because a later `V` packet
 * (unarchive) carries only the id.
 */
export const bootstrapRowSchema = z.object({
  t: z.literal('row'),
  m: modelNameSchema,
  d: rowSchema,
  archived: z.boolean().optional(),
});

/** Last frame. `rows` is the number of `row` frames sent, so a truncated stream is detectable. */
export const bootstrapEndSchema = z.object({
  t: z.literal('end'),
  rows: z.int().nonnegative(),
});

export const bootstrapFrameSchema = z.discriminatedUnion('t', [
  bootstrapMetaSchema,
  bootstrapRowSchema,
  bootstrapEndSchema,
]);

export type BootstrapMeta = z.infer<typeof bootstrapMetaSchema>;
export type BootstrapRow = z.infer<typeof bootstrapRowSchema>;
export type BootstrapEnd = z.infer<typeof bootstrapEndSchema>;
export type BootstrapFrame = z.infer<typeof bootstrapFrameSchema>;

/** Validate one decoded NDJSON value as a bootstrap frame. Throws `ProtocolError`. */
export function decodeBootstrapFrame(value: unknown): BootstrapFrame {
  return decodeWith(bootstrapFrameSchema, value, 'bootstrap frame');
}
