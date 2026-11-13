/**
 * Field builders for synced model definitions (SPEC-002 §5.3). Each field knows
 * its wire schema (Zod), a canonical type name that feeds `schemaHash`
 * (sync-protocol.md §8), and whether it can back a secondary index.
 *
 * Changing a canonical `type` string changes every schema hash and forces all
 * clients to re-bootstrap, so treat them as part of the wire contract.
 */
import { z } from 'zod';

export type FieldKind =
  'uuid' | 'string' | 'int' | 'bool' | 'timestamp' | 'day' | 'enum' | 'json' | 'array';

/** A field as stored in a model definition. Satisfies `SchemaHashField` (sync-protocol). */
export interface FieldDef<T = unknown> {
  readonly kind: FieldKind;
  /** Canonical type name, e.g. `string`, `enum<backlog|done>`, `array<uuid>`. */
  readonly type: string;
  readonly nullable: boolean;
  /** Validates the field's JSON value as it arrives from the server. */
  readonly schema: z.ZodType<T>;
  /** Only scalar values can key a secondary index. */
  readonly indexable: boolean;
  /**
   * Value equality used to skip no-op updates (structural for json and arrays).
   * Method syntax on purpose: it makes `FieldDef<string>` assignable to `FieldDef<unknown>`.
   */
  equals(a: T, b: T): boolean;
}

/** A field builder, as written in `defineModel` (`str().nullable()`, SPEC-002 §5.3). */
export class Field<T> {
  constructor(
    readonly kind: FieldKind,
    readonly type: string,
    readonly schema: z.ZodType<T>,
    readonly indexable: boolean,
    readonly equals: (a: T, b: T) => boolean,
    readonly isNullable: boolean = false,
  ) {}

  /** Also accept `null`. */
  nullable(): Field<T | null> {
    return new Field<T | null>(
      this.kind,
      this.type,
      this.schema.nullable(),
      this.indexable,
      (a, b) => (a === null || b === null ? a === b : this.equals(a, b)),
      true,
    );
  }

  /** The plain definition stored in the model. */
  toDef(): FieldDef<T> {
    const { kind, type, schema, indexable, equals } = this;
    return { kind, type, nullable: this.isNullable, schema, indexable, equals };
  }
}

const same = (a: unknown, b: unknown): boolean => Object.is(a, b);

export type JsonValue = z.core.util.JSONType;

/** Deep equality for JSON values. */
export function jsonEquals(a: JsonValue, b: JsonValue): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => {
        const other = b[i];
        return other !== undefined && jsonEquals(item, other);
      })
    );
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => {
    const left = a[key];
    const right = b[key];
    return left !== undefined && right !== undefined && jsonEquals(left, right);
  });
}

const sameItems = <T>(a: readonly T[], b: readonly T[]): boolean =>
  a.length === b.length && a.every((item, i) => Object.is(item, b[i]));

export const uuid = (): Field<string> => new Field('uuid', 'uuid', z.uuid(), true, same);

export const str = (): Field<string> => new Field('string', 'string', z.string(), true, same);

/** Safe integers only: JSON numbers are exact up to 2^53 − 1. */
export const int = (): Field<number> => new Field('int', 'int', z.int(), true, same);

export const bool = (): Field<boolean> => new Field('bool', 'bool', z.boolean(), true, same);

/** An ISO 8601 timestamp, kept as a string on the client (timezone-safe, cheap to compare). */
export const timestamp = (): Field<string> =>
  new Field('timestamp', 'timestamp', z.iso.datetime({ offset: true }), true, same);

/**
 * A calendar date, `YYYY-MM-DD`, with no time zone (domain-model §1: due dates). Stored as SQL
 * `date`, which the server sends as text, never as an instant (a `Date` would shift it by the
 * server's offset). Equal dates compare equal as strings, and in order.
 */
export const day = (): Field<string> => new Field('day', 'day', z.iso.date(), true, same);

/** One of a fixed set of string values. The members are part of the type name, so adding one changes the schema hash. */
export const enumOf = <const V extends readonly [string, ...string[]]>(
  values: V,
): Field<V[number]> => {
  for (const value of values) {
    // The type string feeds the schema hash; these characters would make it ambiguous.
    if (/[|<>]/.test(value)) throw new Error(`Enum member ${value} cannot contain |, < or >`);
  }
  if (new Set(values).size !== values.length) throw new Error('An enum member is listed twice');
  // Sorted, so reordering members does not change the schema hash.
  const type = `enum<${[...values].sort().join('|')}>`;
  return new Field<V[number]>('enum', type, z.enum(values), true, same);
};

/** Any JSON value (e.g. settings blobs). Not indexable. */
export const json = (): Field<JsonValue> => new Field('json', 'json', z.json(), false, jsonEquals);

/** An array of a non-nullable scalar field type. Not indexable. */
export const array = <T>(item: Field<T>): Field<T[]> => {
  if (item.isNullable || item.kind === 'array' || item.kind === 'json') {
    throw new Error(`array() takes a non-nullable scalar field, not ${item.type}`);
  }
  return new Field<T[]>('array', `array<${item.type}>`, z.array(item.schema), false, sameItems);
};
