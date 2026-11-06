/**
 * Client-side filter evaluation against replica rows (SPEC-003 §7.4). Must give
 * exactly the same answer as the server's SQL compiler; the conformance test
 * (`apps/server/test/filter-conformance.int.test.ts`) checks this.
 *
 * Logic is two-valued: a condition on a missing value is simply false, except
 * the negations `neq`/`nin` (true) and `exists: false` (true).
 */
import type { FieldType } from './fields.js';
import type { ResolvedCondition, ResolvedFilter, ResolvedScalar } from './resolve.js';

/** Reads a field (possibly a dot-path like `status.category`) from a row. */
export type FieldGetter<Row> = (row: Row, field: string) => unknown;

export function matches<Row>(filter: ResolvedFilter, row: Row, get: FieldGetter<Row>): boolean {
  switch (filter.kind) {
    case 'and':
      return filter.children.every((c) => matches(c, row, get));
    case 'or':
      return filter.children.some((c) => matches(c, row, get));
    case 'cond':
      return matchesCondition(filter, get(row, filter.field));
  }
}

/** Row values arrive as the wire sends them; bring them to the resolved form. */
function normalizeScalar(type: Exclude<FieldType, 'refs'>, raw: unknown): ResolvedScalar | null {
  switch (type) {
    case 'text':
    case 'enum':
    case 'ref':
    case 'day':
      return typeof raw === 'string' ? raw : null;
    case 'number':
      return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    case 'boolean':
      return typeof raw === 'boolean' ? raw : null;
    case 'instant': {
      const ms =
        raw instanceof Date ? raw.getTime() : typeof raw === 'string' ? Date.parse(raw) : raw;
      return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
    }
  }
}

function matchesCondition(cond: ResolvedCondition, raw: unknown): boolean {
  return cond.type === 'refs'
    ? matchesSet(cond, Array.isArray(raw) ? raw : [])
    : matchesScalar(cond, normalizeScalar(cond.type, raw));
}

/** A set of ids: eq/neq = has / lacks the id; in/nin = has any / none of them. */
function matchesSet(cond: ResolvedCondition, ids: readonly unknown[]): boolean {
  const has = (id: ResolvedScalar) => ids.includes(id);
  switch (cond.op) {
    case 'exists':
      return ids.length > 0 === cond.value;
    case 'eq':
      return has(cond.value);
    case 'neq':
      return !has(cond.value);
    case 'in':
      return cond.value.some(has);
    case 'nin':
      return !cond.value.some(has);
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
    case 'contains':
      return false; // resolveFilter rejects these for sets (OPS_BY_TYPE.refs)
  }
}

function matchesScalar(cond: ResolvedCondition, value: ResolvedScalar | null): boolean {
  switch (cond.op) {
    case 'exists':
      return (value !== null) === cond.value;
    case 'eq':
      return value !== null && value === cond.value;
    case 'neq':
      return value === null || value !== cond.value;
    case 'in':
      return value !== null && cond.value.includes(value);
    case 'nin':
      return value === null || !cond.value.includes(value);
    case 'lt':
      return value !== null && value < cond.value;
    case 'lte':
      return value !== null && value <= cond.value;
    case 'gt':
      return value !== null && value > cond.value;
    case 'gte':
      return value !== null && value >= cond.value;
    case 'contains':
      // Full Unicode lowercasing; the server uses the ICU root collation, which matches.
      return (
        typeof value === 'string' &&
        typeof cond.value === 'string' &&
        value.toLowerCase().includes(cond.value.toLowerCase())
      );
  }
}
