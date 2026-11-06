import { SURFACE_REF_KEY } from '@surface/domain';
import { z } from 'zod';

/** Which side of a schema to export: what callers send (`input`) or what they get (`output`). */
export type SchemaIo = 'input' | 'output';

export type JsonSchema = z.core.JSONSchema.BaseSchema;

/**
 * JSON Schema (draft 2020-12, as OpenAPI 3.1 uses) for an operation schema (SPEC-003 §10).
 * Reference types keep their `x-surface-ref` annotation and format description, which they
 * carry as Zod metadata. Parts JSON Schema can't express (transforms) export as `{}`.
 */
export function toJsonSchema(schema: z.ZodType, io: SchemaIo = 'input'): JsonSchema {
  return z.toJSONSchema(schema, { target: 'draft-2020-12', io, unrepresentable: 'any' });
}

/** One field of a compact schema. Absent keys mean "not applicable", to save tokens. */
export interface CompactField {
  /** JSON type (`string`, `integer`, `string[]`, `string|null`) or a reference type (`TeamRef`). */
  type: string;
  /** Required whenever its parent object is present. */
  required?: true;
  enum?: readonly unknown[];
  format?: string;
  default?: unknown;
  description?: string;
}

/** Flat field map keyed by dot-path; array elements use `[]` (`labels[].name`). */
export type CompactSchema = Record<string, CompactField>;

/** Key used when the schema root is not an object. */
export const COMPACT_ROOT_KEY = '$';

/**
 * Flat field map for MCP and `GET /api/ops` (SPEC-003 §10). It drops validation detail
 * (patterns, lengths) that JSON Schema spells out, so a typical operation stays under the
 * 400-token budget (AC-10). Nested objects flatten to dot-paths, and each object or array
 * also gets its own entry so an optional parent is visible.
 */
export function toCompactSchema(schema: z.ZodType, io: SchemaIo = 'input'): CompactSchema {
  const root = toJsonSchema(schema, io);
  const out: CompactSchema = {};
  if (objectProperties(root)) {
    flatten(root, '', out);
  } else {
    out[COMPACT_ROOT_KEY] = compactField(root, true);
  }
  return out;
}

/**
 * Token estimate for budgets (AC-10) without shipping a tokenizer. Tokenizers average about
 * 4 characters per token on English and fewer on JSON punctuation, so 3 errs on the high side.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

function flatten(node: JsonSchema, prefix: string, out: CompactSchema): void {
  const properties = objectProperties(node) ?? {};
  const required = new Set(Array.isArray(node.required) ? node.required : []);
  for (const [key, child] of Object.entries(properties)) {
    if (!isSchema(child)) continue;
    const path = prefix === '' ? key : `${prefix}.${key}`;
    out[path] = compactField(child, required.has(key));

    if (child[SURFACE_REF_KEY] !== undefined) continue;
    const inner = withoutNull(child);
    if (objectProperties(inner)) {
      flatten(inner, path, out);
    } else if (inner.type === 'array' && isSchema(inner.items) && objectProperties(inner.items)) {
      flatten(inner.items, `${path}[]`, out);
    }
  }
}

function compactField(node: JsonSchema, required: boolean): CompactField {
  const inner = withoutNull(node);
  const nullable = inner !== node;
  const field: CompactField = { type: typeName(inner) + (nullable ? '|null' : '') };
  if (required) field.required = true;

  const ref = node[SURFACE_REF_KEY] ?? inner[SURFACE_REF_KEY];
  if (typeof ref !== 'string') {
    if (Array.isArray(inner.enum)) field.enum = inner.enum;
    else if (inner.const !== undefined) field.enum = [inner.const];
    if (typeof inner.format === 'string') field.format = inner.format;
  }
  const fallback = node.default ?? inner.default;
  if (fallback !== undefined) field.default = fallback;
  const description = node.description ?? inner.description;
  if (typeof description === 'string') field.description = description;
  return field;
}

function typeName(node: JsonSchema): string {
  const ref = node[SURFACE_REF_KEY];
  if (typeof ref === 'string') return ref;
  if (typeof node.$ref === 'string') return 'object';
  if (node.type === 'array') {
    return `${isSchema(node.items) ? typeName(withoutNull(node.items)) : 'any'}[]`;
  }
  if (typeof node.type === 'string') return node.type;
  if (Array.isArray(node.type)) return node.type.join('|');
  const variants = node.anyOf ?? node.oneOf;
  if (Array.isArray(variants)) {
    return [...new Set(variants.filter(isSchema).map(typeName))].join('|');
  }
  return 'any';
}

/** Strips `null` from `type: [x, "null"]` or `anyOf: [x, {type: "null"}]`; returns the node itself if not nullable. */
function withoutNull(node: JsonSchema): JsonSchema {
  if (Array.isArray(node.type) && node.type.includes('null')) {
    const rest = node.type.filter((t) => t !== 'null');
    return { ...node, type: rest.length === 1 ? rest[0] : rest };
  }
  if (Array.isArray(node.anyOf)) {
    const rest = node.anyOf.filter((v) => !(isSchema(v) && v.type === 'null'));
    if (rest.length < node.anyOf.length) {
      const [only] = rest;
      return rest.length === 1 && isSchema(only)
        ? { ...only, ...annotations(node) }
        : { ...node, anyOf: rest };
    }
  }
  return node;
}

/** Annotations on a wrapper (`description`, `default`, the ref key) that must survive unwrapping. */
function annotations(node: JsonSchema): JsonSchema {
  const kept: JsonSchema = {};
  if (node.description !== undefined) kept.description = node.description;
  if (node.default !== undefined) kept.default = node.default;
  if (node[SURFACE_REF_KEY] !== undefined) kept[SURFACE_REF_KEY] = node[SURFACE_REF_KEY];
  return kept;
}

function objectProperties(
  node: JsonSchema,
): Record<string, z.core.JSONSchema._JSONSchema> | undefined {
  if (node.type !== 'object' || node[SURFACE_REF_KEY] !== undefined) return undefined;
  return node.properties;
}

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
