/**
 * `schemaHash` (sync-protocol.md §8): a stable hash of the synced model
 * definitions. Server and client compute it from the same shared definitions;
 * a mismatch forces `resync(schema)` / `CLIENT_OUTDATED`.
 *
 * The input is structural, so the declarative `defineModel` output (PLAN-002 S6)
 * can be passed directly. Only what changes the meaning of synced rows is
 * hashed: model name, load strategy, a content model's parent, and each field's
 * name, type and nullability, plus `DOC_SCHEMA_VERSION` (SPEC-013 §4.4). Client-only metadata (refs, indexes) is not, so changing it does
 * not force every client to re-bootstrap.
 */
import { DOC_SCHEMA_VERSION } from '@surface/domain';
import { ProtocolError } from './errors.js';
import { sha256Hex } from './sha256.js';

/**
 * Bump when the wire format changes incompatibly: it is part of every schema hash, so every
 * client re-bootstraps once (SPEC-002 E7). 2: `A` and `V` carry the full row (v0.7, SPEC-011 §5.5).
 * 3: partial issue loading (v0.8, SPEC-011 §5.7): issue groups, team subscriptions, and no archived
 * or deleted issue in a bootstrap.
 */
export const SYNC_PROTOCOL_VERSION = 3;

export interface SchemaHashField {
  /** Canonical type name, including anything that narrows it (e.g. enum members). */
  readonly type: string;
  readonly nullable: boolean;
}

export interface SchemaHashModel {
  readonly name: string;
  /** `eager` or `content` (sync-protocol.md §2). */
  readonly load: string;
  /**
   * A content model's parent (sync-protocol §2, v0.7): clients load and drop its rows per parent,
   * so a change to it changes what a replica holds. Absent for eager models.
   */
  readonly parent?: { readonly model: string; readonly field: string };
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
    // An eager model's canonical form is unchanged from before parents existed, so adding the
    // field changed no hash but the content models' (PLAN-011 S5a).
    const shape =
      model.parent === undefined
        ? [model.load, fields]
        : [model.load, fields, [model.parent.model, model.parent.field]];
    return [model.name, shape] as const;
  }).sort(byKey);
  return sha256Hex(JSON.stringify([SYNC_PROTOCOL_VERSION, docSchemaVersion, canonical]));
}
