/**
 * Declarative synced-model definitions (SPEC-002 §5.3), shared by the client
 * store (PLAN-002 S6) and the server's sync registry (PLAN-002 S3), so the two
 * sides cannot drift. A definition satisfies `SchemaHashModel`, so the list of
 * models feeds `computeSchemaHash` directly.
 */
import { z } from 'zod';
import type { FieldDef, FieldKind } from './fields.js';
import { uuid } from './fields.js';

export type LoadStrategy = 'eager' | 'content';

/**
 * Any field builder. `toDef` uses method syntax in `FieldDef`, so a builder of
 * any value type fits here without `any`.
 */
export interface AnyField {
  readonly kind: FieldKind;
  readonly type: string;
  readonly isNullable: boolean;
  readonly indexable: boolean;
  toDef(): FieldDef;
}

/** The value type a field builder produces. */
export type FieldValue<F> = F extends { toDef(): FieldDef<infer T> } ? T : never;

/** `ref`: this row's `field` holds the id of a `model` row. `backRef`: `model` rows whose `field` holds this row's id. */
export interface RefDef {
  readonly kind: 'ref' | 'backRef';
  readonly model: string;
  readonly field: string;
}

export const ref = (model: string, field: string): RefDef => ({ kind: 'ref', model, field });
export const backRef = (model: string, field: string): RefDef => ({
  kind: 'backRef',
  model,
  field,
});

type Simplify<T> = { [K in keyof T]: T[K] } & {};

/** The row type of a model with fields `F`: an `id` plus every field. */
export type RowOf<F> = Simplify<
  { readonly id: string } & { readonly [K in keyof F]: FieldValue<F[K]> }
>;

export interface ModelDef<Name extends string = string, Row extends ModelRow = ModelRow> {
  readonly name: Name;
  readonly load: LoadStrategy;
  /** Every field, including the implicit `id`. */
  readonly fields: Readonly<Record<string, FieldDef>>;
  readonly refs: Readonly<Record<string, RefDef>>;
  /**
   * Fields declared as indexed. The client pool also indexes any field that a
   * `backRef` on another model points at; those are not listed here.
   */
  readonly indexes: readonly string[];
  /** Validates a wire row and strips columns the model does not declare. */
  readonly rowSchema: z.ZodType<Row>;
}

export interface ModelRow {
  readonly id: string;
  readonly [field: string]: unknown;
}

/** The row type of a model definition. */
export type RowOfModel<M> = M extends ModelDef<string, infer Row> ? Row : never;

export interface ModelSpec<F extends Record<string, AnyField>> {
  readonly load: LoadStrategy;
  readonly fields: F;
  readonly refs?: Readonly<Record<string, RefDef>>;
  readonly indexes?: readonly (keyof F & string)[];
}

const MODEL_NAME = /^[A-Z][A-Za-z0-9]*$/;
const MEMBER_NAME = /^[a-z][A-Za-z0-9]*$/;
/**
 * Names a field would shadow on every client instance: `Object.prototype`
 * members and `toJSON`, plus `then`, which would make instances thenables.
 */
const RESERVED = new Set([...Object.getOwnPropertyNames(Object.prototype), 'toJSON', 'then']);

export function defineModel<const Name extends string, F extends Record<string, AnyField>>(
  name: Name,
  spec: ModelSpec<F>,
): ModelDef<Name, RowOf<F>> {
  const problem = (message: string) => new Error(`Model ${name}: ${message}`);
  if (!MODEL_NAME.test(name)) throw problem('name must be PascalCase, like IssueLabel');

  const fields: Record<string, FieldDef> = { id: Object.freeze(uuid().toDef()) };
  const shape: Record<string, z.ZodType> = { id: z.uuid() };
  for (const [fieldName, builder] of Object.entries(spec.fields)) {
    if (fieldName === 'id') throw problem('id is implicit; do not declare it');
    if (RESERVED.has(fieldName))
      throw problem(`${fieldName} is reserved; choose another field name`);
    if (!MEMBER_NAME.test(fieldName)) {
      throw problem(`field ${fieldName} must be camelCase, like teamId`);
    }
    const def = builder.toDef();
    fields[fieldName] = Object.freeze(def);
    shape[fieldName] = def.schema;
  }

  const refs: Record<string, RefDef> = {};
  for (const [refName, refDef] of Object.entries(spec.refs ?? {})) {
    if (!MEMBER_NAME.test(refName)) throw problem(`ref ${refName} must be camelCase`);
    if (RESERVED.has(refName)) throw problem(`${refName} is reserved; choose another ref name`);
    if (refName in fields) throw problem(`ref ${refName} has the same name as a field`);
    if (!MODEL_NAME.test(refDef.model)) throw problem(`ref ${refName} names an invalid model`);
    if (refDef.kind === 'ref' && fields[refDef.field]?.kind !== 'uuid') {
      throw problem(`ref ${refName} needs a uuid field ${refDef.field} on this model`);
    }
    refs[refName] = Object.freeze({ ...refDef });
  }

  const indexes = [...new Set(spec.indexes ?? [])];
  for (const field of indexes) {
    if (!fields[field]?.indexable) throw problem(`index on ${field} needs a scalar field`);
  }

  // The generic row type cannot be derived from a runtime-built shape; the
  // shape above is built from exactly the fields that `RowOf<F>` maps.
  const rowSchema = z.object(shape) as unknown as z.ZodType<RowOf<F>>;

  // Frozen all the way down except the Zod schemas, which keep internal caches.
  return Object.freeze({
    name,
    load: spec.load,
    fields: Object.freeze(fields),
    refs: Object.freeze(refs),
    indexes: Object.freeze(indexes),
    rowSchema,
  });
}
