/**
 * `schemaHash` (sync-protocol.md §8): a stable hash of the synced model
 * definitions. Server and client compute it from the same shared definitions;
 * a mismatch forces `resync(schema)` / `CLIENT_OUTDATED`.
 *
 * The input is structural, so the declarative `defineModel` output (PLAN-002 S6)
 * can be passed directly. Only what changes the meaning of synced rows is
 * hashed: model name, load strategy, and each field's name, type and
 * nullability, plus `DOC_SCHEMA_VERSION` (SPEC-013 §4.4). Client-only metadata (refs, indexes) is not, so changing it does
 * not force every client to re-bootstrap.
 */
import { DOC_SCHEMA_VERSION } from '@surface/domain';
import { ProtocolError } from './errors.js';
import { sha256Hex } from './sha256.js';

/** Bump when the wire format changes incompatibly: it is part of every schema hash. */
export const SYNC_PROTOCOL_VERSION = 1;

export interface SchemaHashField {
  /** Canonical type name, including anything that narrows it (e.g. enum members). */
  readonly type: string;
  readonly nullable: boolean;
}

export interface SchemaHashModel {
  readonly name: string;
  /** `eager` or `content` (sync-protocol.md §2). */
  readonly load: string;
  readonly fields: Readonly<Record<string, SchemaHashField>>;
}

/** Code-unit order, so the result never depends on the runtime's locale. */
function byKey<T>(a: readonly [string, T], b: readonly [string, T]): number {
  if (a[0] < b[0]) return -1;
  return a[0] > b[0] ? 1 : 0;
}

/**
 * Hash a set of synced model definitions. Independent of model and field order. The stored
 * rich-text document version is part of the input (SPEC-013 D6), so an editor schema change
 * resyncs every client; the parameter exists for tests, callers keep the default.
 */
export function computeSchemaHash(
  models: Iterable<SchemaHashModel>,
  docSchemaVersion: number = DOC_SCHEMA_VERSION,
): string {
  const seen = new Set<string>();
  const canonical = Array.from(models, (model) => {
    if (seen.has(model.name)) {
      throw new ProtocolError(`Model ${model.name} is defined twice; model names must be unique`);
    }
    seen.add(model.name);
    const fields = Object.entries(model.fields)
      .sort(byKey)
      .map(([name, field]) => [name, field.type, field.nullable] as const);
    return [model.name, [model.load, fields]] as const;
  }).sort(byKey);
  return sha256Hex(JSON.stringify([SYNC_PROTOCOL_VERSION, docSchemaVersion, canonical]));
}
