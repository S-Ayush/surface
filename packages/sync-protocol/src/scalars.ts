/**
 * Scalar wire types shared by every message (sync-protocol.md §4).
 * Codecs strip unknown keys rather than rejecting them, so additive protocol
 * changes stay compatible (sync-protocol.md §8).
 */
import { z } from 'zod';

/**
 * A position in the global `sync_log` (sync-protocol.md §3). Postgres stores a
 * bigint; the wire uses a JSON number, which is exact up to 2^53 − 1.
 */
export const syncIdSchema = z.int().nonnegative();
export type SyncId = z.infer<typeof syncIdSchema>;

/** Row and client identifiers are UUIDs (client-generated UUIDv7 for new rows, SPEC-003 §8). */
export const uuidSchema = z.uuid();

/** A client's per-tab identity for exactly-once delivery (SPEC-002 §4.4, E5). */
export const clientIdSchema = uuidSchema;

/** Mutation sequence numbers start at 1 and are gap-free per client (SPEC-002 §3.3). */
export const seqSchema = z.int().positive();

/** Synced model names are PascalCase (`Team`, `IssueLabel`, `DebugItem`). */
export const modelNameSchema = z.string().regex(/^[A-Z][A-Za-z0-9]*$/, {
  message: 'Model name must be PascalCase, like IssueLabel',
});

/** Operation names are dotted camelCase (`team.update`, `debug.touch`), SPEC-003. */
export const operationNameSchema = z.string().regex(/^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/, {
  message: 'Operation name must be dotted camelCase, like team.update',
});

/** The output of `computeSchemaHash`: lowercase hex SHA-256. */
export const schemaHashSchema = z.string().regex(/^[0-9a-f]{64}$/, {
  message: 'Schema hash must be 64 lowercase hex characters',
});

/** Sync groups (permissions.md §2): `workspace`, `team:<id>` (private teams), `user:<id>`. */
export const syncGroupSchema = z.union([
  z.literal('workspace'),
  z.templateLiteral(['team:', z.uuid()]),
  z.templateLiteral(['user:', z.uuid()]),
]);
export type SyncGroup = z.infer<typeof syncGroupSchema>;

/** Error codes are SCREAMING_SNAKE_CASE (SPEC-003 §9). Unknown codes are accepted, so the server can add new ones. */
export const errorCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]*$/);

/**
 * A synced row as it travels on the wire: a JSON object with a UUID `id`.
 * Field-level validation against the model definition happens in the client store.
 */
export const rowSchema = z.looseObject({ id: uuidSchema });
export type Row = z.infer<typeof rowSchema>;
