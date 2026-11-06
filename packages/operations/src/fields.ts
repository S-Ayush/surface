/**
 * Output shaping with `fields` (SPEC-003 §7.2): dot-paths project an operation's output.
 * Valid paths come from the output's JSON Schema. Arrays are transparent (`labels.name` picks
 * `name` from every label), and on a list (`{ nodes, pageInfo }`) paths address each node,
 * while `pageInfo` and `totalCount` are always kept.
 */
import type { AnyOperation } from './define.js';
import { toJsonSchema, type JsonSchema } from './schema.js';
import { editDistance } from './suggest.js';

/** At most this many paths per call, each at most `MAX_FIELD_LENGTH` characters. */
export const MAX_FIELDS = 50;
export const MAX_FIELD_LENGTH = 200;

/** Relations are embedded one level (§7.2), so real paths are short; this stops recursion. */
const MAX_DEPTH = 6;

export interface FieldPaths {
  /** Every requestable dot-path. */
  readonly paths: ReadonlySet<string>;
  /** Top-level fields, listed in errors. */
  readonly top: readonly string[];
  /** Whether paths address the nodes of a list rather than the output itself. */
  readonly list: boolean;
}

const cache = new WeakMap<AnyOperation, FieldPaths>();

/** The paths `fields` may name for an operation (cached per definition). */
export function fieldPaths(def: AnyOperation): FieldPaths {
  const cached = cache.get(def);
  if (cached) return cached;
  const root = toJsonSchema(def.output, 'output');
  const nodes = listNodes(root);
  const base = nodes ?? root;
  const paths = new Set<string>();
  collect(root, base, '', paths, 0);
  const top = [...paths].filter((p) => !p.includes('.')).sort();
  const result: FieldPaths = { paths, top, list: nodes !== undefined };
  cache.set(def, result);
  return result;
}

export interface FieldsProblem {
  readonly index: number;
  readonly message: string;
}

/** The first invalid entry of `fields`, or `undefined` when all are valid. */
export function fieldsProblem(
  def: AnyOperation,
  fields: readonly string[],
): FieldsProblem | undefined {
  if (fields.length > MAX_FIELDS) {
    return { index: MAX_FIELDS, message: `Request at most ${MAX_FIELDS} fields.` };
  }
  const { paths, top } = fieldPaths(def);
  for (const [index, field] of fields.entries()) {
    if (paths.has(field)) continue;
    const near = field.length > MAX_FIELD_LENGTH ? [] : nearestPaths(field, paths);
    const hint = near.length > 0 ? ` Did you mean ${near.map((p) => `"${p}"`).join(', ')}?` : '';
    const shown = field.length > 60 ? `${field.slice(0, 60)}…` : field;
    return {
      index,
      message: `${def.name} has no field "${shown}".${hint} Fields: ${top.join(', ')}.`,
    };
  }
  return undefined;
}

/** Projects `output` to `fields`. Call `fieldsProblem` first; unknown paths are ignored here. */
export function shapeOutput(
  def: AnyOperation,
  output: unknown,
  fields: readonly string[],
): unknown {
  const tree = pathTree(fields);
  if (fieldPaths(def).list && isRecord(output) && Array.isArray(output.nodes)) {
    return { ...output, nodes: output.nodes.map((node: unknown) => pick(node, tree)) };
  }
  return pick(output, tree);
}

// ---------------------------------------------------------------------------------------------

/** `true` keeps the whole value; a map keeps only the named children. */
type PathTree = Map<string, PathTree | true>;

function pathTree(fields: readonly string[]): PathTree {
  const root: PathTree = new Map();
  for (const field of fields) {
    let node = root;
    const segments = field.split('.');
    for (const [i, segment] of segments.entries()) {
      const existing = node.get(segment);
      if (existing === true) break; // a shorter path already keeps everything below
      if (i === segments.length - 1) {
        node.set(segment, true);
        break;
      }
      const child: PathTree = existing ?? new Map<string, PathTree | true>();
      node.set(segment, child);
      node = child;
    }
  }
  return root;
}

function pick(value: unknown, tree: PathTree): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => pick(item, tree));
  if (!isRecord(value)) return value; // null, or a scalar where a union allowed one
  const out: Record<string, unknown> = {};
  for (const [key, sub] of tree) {
    if (!Object.hasOwn(value, key)) continue;
    out[key] = sub === true ? value[key] : pick(value[key], sub);
  }
  return out;
}

function nearestPaths(field: string, paths: ReadonlySet<string>): string[] {
  const target = field.toLowerCase();
  const max = Math.max(2, Math.floor(target.length / 4));
  return [...paths]
    .map((path) => ({ path, distance: editDistance(target, path.toLowerCase()) }))
    .filter(({ distance }) => distance <= max)
    .sort((a, b) => a.distance - b.distance || a.path.localeCompare(b.path))
    .slice(0, 3)
    .map(({ path }) => path);
}

/** The node schema of a list output (`{ nodes: T[], pageInfo }`), if it is one. */
function listNodes(root: JsonSchema): JsonSchema | undefined {
  const props = root.properties;
  if (!props || !('pageInfo' in props)) return undefined;
  const nodes = props.nodes;
  return typeof nodes === 'object' && typeof nodes.items === 'object' && !Array.isArray(nodes.items)
    ? nodes.items
    : undefined;
}

function collect(
  root: JsonSchema,
  schema: JsonSchema,
  prefix: string,
  out: Set<string>,
  depth: number,
): void {
  if (depth > MAX_DEPTH) return;
  const target = deref(root, schema);
  if (!target) return;
  for (const variant of [
    ...(target.anyOf ?? []),
    ...(target.oneOf ?? []),
    ...(target.allOf ?? []),
  ]) {
    if (typeof variant === 'object') collect(root, variant, prefix, out, depth + 1);
  }
  const items = target.items;
  if (typeof items === 'object' && !Array.isArray(items)) {
    collect(root, items, prefix, out, depth + 1);
  }
  for (const [key, child] of Object.entries(target.properties ?? {})) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    out.add(path);
    if (typeof child === 'object') collect(root, child, path, out, depth + 1);
  }
}

/** Follows a local `$ref` (`#` or `#/$defs/Name`); other references are not followed. */
function deref(root: JsonSchema, schema: JsonSchema): JsonSchema | undefined {
  const ref = schema.$ref;
  if (ref === undefined) return schema;
  if (ref === '#') return root;
  const name = /^#\/\$defs\/([^/]+)$/.exec(ref)?.[1];
  const target = name === undefined ? undefined : root.$defs?.[name];
  return typeof target === 'object' ? target : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
