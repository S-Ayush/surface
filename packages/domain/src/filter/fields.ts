/**
 * Filterable fields of a model (SPEC-003 §7.4). The same definition drives
 * validation, the client evaluator and the server's SQL compiler.
 */

export const FILTER_OPS = [
  'eq',
  'neq',
  'in',
  'nin',
  'lt',
  'lte',
  'gt',
  'gte',
  'exists',
  'contains',
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/**
 * - `text`: free text, compared exactly; `contains` ignores case.
 * - `enum`: one of a fixed set of strings.
 * - `instant`: a point in time (`timestamptz(3)`), compared at millisecond precision.
 * - `day`: a calendar date (`YYYY-MM-DD`, SQL `date`), with no time zone.
 * - `ref`: one id (uuid). `refs`: a set of ids (`uuid[]`), e.g. labels.
 */
export const FIELD_TYPES = [
  'text',
  'enum',
  'number',
  'boolean',
  'instant',
  'day',
  'ref',
  'refs',
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

/**
 * Operators each type supports. Ordering operators exist only where the client
 * and Postgres order values identically (no text ordering: collations differ).
 */
export const OPS_BY_TYPE: Readonly<Record<FieldType, readonly FilterOp[]>> = {
  text: ['eq', 'neq', 'in', 'nin', 'contains', 'exists'],
  enum: ['eq', 'neq', 'in', 'nin', 'exists'],
  number: ['eq', 'neq', 'in', 'nin', 'lt', 'lte', 'gt', 'gte', 'exists'],
  boolean: ['eq', 'neq', 'exists'],
  instant: ['lt', 'lte', 'gt', 'gte', 'exists'],
  day: ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'exists'],
  ref: ['eq', 'neq', 'in', 'nin', 'exists'],
  refs: ['eq', 'neq', 'in', 'nin', 'exists'],
};

export type FilterField =
  | { readonly type: 'enum'; readonly values: readonly string[] }
  | { readonly type: Exclude<FieldType, 'enum'> };

/** Field name (dot-paths like `status.category` allowed) → definition. */
export type FilterFields = Readonly<Record<string, FilterField>>;

/** Declare a model's filterable fields. Throws on a definition mistake. */
export function defineFilterFields<const F extends FilterFields>(fields: F): F {
  for (const [name, field] of Object.entries(fields)) {
    if (!/^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)?$/.test(name)) {
      throw new Error(
        `Filter field name "${name}" must be camelCase, optionally one dot-path level`,
      );
    }
    if (field.type === 'enum' && field.values.length === 0) {
      throw new Error(`Enum filter field "${name}" needs at least one value`);
    }
  }
  return fields;
}

export function opsFor(field: FilterField): readonly FilterOp[] {
  return OPS_BY_TYPE[field.type];
}
