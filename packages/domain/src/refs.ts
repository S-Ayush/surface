/**
 * JSON Schema annotation that marks a field as a reference type (SPEC-003 §4, §10).
 * Reference schemas (`TeamRef`, `UserRef`, …) carry it in their Zod metadata, so the schema
 * exports and the registry lint can tell a reference apart from a plain string.
 * The reference types themselves land in PLAN-003 S2.
 */
export const SURFACE_REF_KEY = 'x-surface-ref';
