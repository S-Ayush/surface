/**
 * `GET /sync/bootstrap` frames (sync-protocol.md §4.1). The body is NDJSON:
 * one `meta`, then any number of `row`, then one `end`.
 */
import { z } from 'zod';
import { decodeWith } from './errors.js';
import {
  modelNameSchema,
  rowSchema,
  schemaHashSchema,
  syncGroupSchema,
  syncIdSchema,
} from './scalars.js';

export const BOOTSTRAP_PATH = '/sync/bootstrap';
export const NDJSON_CONTENT_TYPE = 'application/x-ndjson';

/** First frame. The rows that follow are consistent with `lastSyncId` (one REPEATABLE READ snapshot). */
export const bootstrapMetaSchema = z.object({
  t: z.literal('meta'),
  schemaHash: schemaHashSchema,
  lastSyncId: syncIdSchema,
  groups: z.array(syncGroupSchema),
  serverTime: z.iso.datetime({ offset: true }),
});

export const bootstrapRowSchema = z.object({
  t: z.literal('row'),
  m: modelNameSchema,
  d: rowSchema,
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
