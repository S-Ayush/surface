/**
 * Registry lint (SPEC-003 §11): the rules every operation must pass before it ships.
 * `pnpm registry:lint` prints the problems, and a unit test fails the build on any. Running the
 * examples against the seed fixture (the other half of rule 2) is a server contract test.
 *
 * Not exported from the package index: only the scripts and tests use it.
 */
import { SURFACE_REF_KEY } from '@surface/domain';
import { z } from 'zod';
import { isPublicOperation } from './catalog.js';
import { definitionChecks, type AnyOperation } from './define.js';
import { connectionOf, listInput } from './list.js';
import { toCompactSchema, toJsonSchema, type CompactField, type JsonSchema } from './schema.js';

export type LintRule = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export const LINT_RULES: Readonly<Record<LintRule, string>> = {
  1: 'required fields',
  2: 'examples validate',
  3: 'optimistic for web mutations',
  4: 'reference types for foreign entities',
  5: 'destructive deletes and removals',
  6: 'list conventions',
  7: 'naming and summary',
  8: 'no breaking changes',
};

export interface LintProblem {
  readonly rule: LintRule;
  readonly operation: string;
  readonly message: string;
}

const MIN_BOUNDS = ['minimum', 'exclusiveMinimum', 'minLength', 'minItems'] as const;
const MAX_BOUNDS = ['maximum', 'exclusiveMaximum', 'maxLength', 'maxItems'] as const;
type Bound = (typeof MIN_BOUNDS)[number] | (typeof MAX_BOUNDS)[number];

/**
 * One field of a snapshot schema: what a breaking-change check compares. Paths are dot-paths
 * from the root (`$`); an array's items are `path[]`, so their nullability is a field of its own.
 */
export interface SnapshotField {
  /** JSON type or reference type, with `|null` when nullable: `string|null`, `array`, `TeamRef`. */
  readonly type: string;
  readonly required?: true;
  readonly enum?: readonly unknown[];
  readonly format?: string;
  /** Inputs only: limits a value must meet. */
  readonly bounds?: Readonly<Partial<Record<Bound, number>>>;
  /** Inputs only, and only without a format (a format implies its pattern). */
  readonly pattern?: string;
  /** Inputs only: the object rejects keys it doesn't name. */
  readonly closed?: true;
}

export interface SnapshotEntry {
  readonly kind: AnyOperation['kind'];
  readonly deprecated?: { readonly since: string; readonly replacedBy: string };
  readonly input: Readonly<Record<string, SnapshotField>>;
  readonly output: Readonly<Record<string, SnapshotField>>;
}

/** The released public catalog, committed as `catalog.snapshot.json` (rule 8). */
export interface CatalogSnapshot {
  readonly operations: Readonly<Record<string, SnapshotEntry>>;
}

const SnapshotFieldSchema = z.strictObject({
  type: z.string(),
  required: z.literal(true).optional(),
  enum: z.array(z.unknown()).optional(),
  format: z.string().optional(),
  bounds: z.partialRecord(z.enum([...MIN_BOUNDS, ...MAX_BOUNDS]), z.number()).optional(),
  pattern: z.string().optional(),
  closed: z.literal(true).optional(),
});
const SnapshotSchema = z.strictObject({
  operations: z.record(
    z.string(),
    z.strictObject({
      kind: z.enum(['query', 'mutation']),
      deprecated: z.strictObject({ since: z.string(), replacedBy: z.string() }).optional(),
      input: z.record(z.string(), SnapshotFieldSchema),
      output: z.record(z.string(), SnapshotFieldSchema),
    }),
  ),
});

/** Parses a snapshot file's JSON; throws with the problem when it is malformed. */
export function parseSnapshot(json: unknown): CatalogSnapshot {
  const parsed = SnapshotSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`catalog.snapshot.json is malformed: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

/**
 * The snapshot of the public operations (internal and `systemOnly` ones are never released),
 * sorted by name.
 */
export function catalogSnapshot(operations: readonly AnyOperation[]): CatalogSnapshot {
  const entries = operations
    .filter(isPublicOperation)
    .map((op): [string, SnapshotEntry] => [op.name, snapshotEntry(op)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { operations: Object.fromEntries(entries) };
}

export interface LintOptions {
  /** The last released catalog; without one, rule 8 is skipped. */
  readonly snapshot?: CatalogSnapshot;
}

/** Every problem with `operations`, in operation order, then rule order. */
export function lintOperations(
  operations: readonly AnyOperation[],
  options: LintOptions = {},
): LintProblem[] {
  const problems: LintProblem[] = [];
  const seen = new Set<string>();
  for (const op of operations) {
    const add = (rule: LintRule, message: string) =>
      problems.push({ rule, operation: String(op.name), message });
    for (const check of definitionChecks(op)) add(check.rule, check.message);
    if (seen.has(op.name)) add(7, 'name is used by another operation. Names must be unique');
    seen.add(op.name);

    requiredFields(op, add);
    examplesValidate(op, add);
    optimisticForUi(op, add);
    referenceTypes(op, add);
    destructive(op, add);
    listConventions(op, add);
  }
  if (options.snapshot) problems.push(...breakingChanges(operations, options.snapshot));
  return problems.sort(
    (a, b) =>
      operationIndex(operations, a.operation) - operationIndex(operations, b.operation) ||
      a.rule - b.rule,
  );
}

// ---------------------------------------------------------------------------------------------
// Rules 1–6

type Add = (rule: LintRule, message: string) => void;

function requiredFields(op: AnyOperation, add: Add): void {
  const keywords: unknown = op.keywords;
  const phrases = Array.isArray(keywords)
    ? keywords.filter((k): k is string => typeof k === 'string' && k.trim() !== '')
    : [];
  if (new Set(phrases.map((k) => k.trim().toLowerCase())).size < 2) {
    add(1, 'keywords needs at least 2 different phrasings a user or AI might use');
  }
  const examples: unknown = op.examples;
  if (!Array.isArray(examples) || examples.length === 0) {
    add(1, 'examples needs at least 1 input, like { team: "ENG" }');
  }
  // Read as a property, not called: `this` doesn't matter here.
  if (typeof Reflect.get(op, 'permission') !== 'function') {
    add(1, 'permission is required, like (p) => p.admin()');
  }
}

function examplesValidate(op: AnyOperation, add: Add): void {
  const examples: unknown = op.examples;
  if (!Array.isArray(examples)) return;
  examples.forEach((example: unknown, i) => {
    const parsed = op.input.safeParse(example);
    if (parsed.success) return;
    const [issue] = parsed.error.issues;
    const where = issue && issue.path.length > 0 ? ` at ${issue.path.join('.')}` : '';
    add(2, `examples[${i}] does not match the input schema${where}: ${issue?.message ?? ''}`);
  });
}

/** SPEC-003 §3.1: mutations used in the UI declare `ui`, and client-dispatched ones need `optimistic`. */
function optimisticForUi(op: AnyOperation, add: Add): void {
  if (op.kind === 'mutation' && op.ui !== undefined && op.optimistic === undefined) {
    add(3, 'is used in the UI (it has ui) but has no optimistic(): add one (SPEC-003 §8)');
  }
}

/**
 * A raw uuid names another entity in a form people and AI can't type; reference types accept
 * keys, identifiers and "me" too (§4). Exempt: a `create*` op's own top-level `id` (a
 * client-generated id, E7), internal ops, which only tests call, and `systemOnly` ops, which
 * only jobs call (SPEC-003 §11).
 */
function referenceTypes(op: AnyOperation, add: Add): void {
  if (!isPublicOperation(op)) return;
  const ownId = verbOf(op).startsWith('create') ? 'id' : undefined;
  const opaque = new Set(op.opaqueIds ?? []);
  const paths = rawUuidPaths(toJsonSchema(op.input, 'input'));
  for (const path of paths) {
    if (path === ownId || opaque.has(path)) continue;
    add(4, `input ${path} is a raw uuid. Use a reference type, like TeamRef or IssueRef (§4)`);
  }
  // SPEC-012 D23: the exemption names real uuid paths only, so a stale entry can't hide a new one.
  for (const path of opaque) {
    if (!paths.includes(path)) {
      add(4, `opaqueIds names ${path}, which is not a uuid in the input. Remove it`);
    }
  }
}

const DESTRUCTIVE_VERB = /^(delete|remove|purge|deactivate)(?![a-z])/;

function destructive(op: AnyOperation, add: Add): void {
  if (DESTRUCTIVE_VERB.test(verbOf(op)) && op.destructive !== true) {
    add(5, `${verbOf(op)} removes data or access, so set destructive: true`);
  }
}

const LIST_INPUT = toJsonSchema(z.object(listInput), 'input');
const CONNECTION = toCompactSchema(connectionOf(z.object({})), 'output');

/** §7.1: `*.list` queries spread `listInput` and return `connectionOf(node)`. */
function listConventions(op: AnyOperation, add: Add): void {
  if (!/^list(?![a-z])/.test(verbOf(op))) return;
  const fix = 'spread listInput into the input and wrap the node schema with connectionOf (§7.1)';
  if (op.kind !== 'query') add(6, 'a list must be a query');
  // The exported JSON Schema keeps bounds and defaults (limit 1–100, default 25), so compare it.
  const input = toJsonSchema(op.input, 'input');
  const required = new Set(input.required ?? []);
  for (const [key, want] of Object.entries(LIST_INPUT.properties ?? {})) {
    const have = input.properties?.[key];
    if (required.has(key) || JSON.stringify(have) !== JSON.stringify(want)) {
      add(6, `input ${key} differs from a list's: ${fix}`);
    }
  }
  const output = toCompactSchema(op.output, 'output');
  for (const [path, want] of Object.entries(CONNECTION)) {
    const have = output[path];
    const ok =
      path === 'nodes'
        ? have?.required === true && have.type.endsWith('[]')
        : sameField(have, want);
    if (!ok) add(6, `output ${path} differs from a list's: ${fix}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Rule 8

function breakingChanges(
  operations: readonly AnyOperation[],
  snapshot: CatalogSnapshot,
): LintProblem[] {
  const current = catalogSnapshot(operations).operations;
  const problems: LintProblem[] = [];
  const add = (operation: string, message: string) =>
    problems.push({ rule: 8, operation, message });
  const fix = 'Add a new operation instead and mark this one deprecated (Decision Q3)';

  for (const [name, entry] of Object.entries(current)) {
    const replacedBy = entry.deprecated?.replacedBy;
    if (replacedBy !== undefined && current[replacedBy] === undefined) {
      add(name, `is deprecated in favour of ${replacedBy}, which is not a public operation`);
    }
  }
  for (const [name, released] of Object.entries(snapshot.operations)) {
    const now = current[name];
    if (now === undefined) {
      const replacedBy = released.deprecated?.replacedBy;
      if (replacedBy === undefined || current[replacedBy] === undefined) {
        add(name, `was released and is now gone. Keep it, deprecated, until a release replaces it`);
      }
      continue;
    }
    const changes = [
      ...(now.kind === released.kind ? [] : [`kind changed from ${released.kind} to ${now.kind}`]),
      ...inputBreaks(released.input, now.input),
      ...outputBreaks(released.output, now.output),
    ];
    for (const change of changes) add(name, `${change}. ${fix}`);
  }
  return problems;
}

type Fields = Readonly<Record<string, SnapshotField>>;

/** Callers' old inputs must stay valid: nothing removed, newly required or narrowed. */
function inputBreaks(before: Fields, after: Fields): string[] {
  const out: string[] = [];
  for (const [path, was] of Object.entries(before)) {
    const now = after[path];
    if (now === undefined) {
      if (!removedWithParent(path, before, after)) out.push(`input ${path} was removed`);
      continue;
    }
    const lost = types(was.type).filter((t) => !covers(types(now.type), t));
    if (lost.length > 0) out.push(`input ${path} no longer accepts ${lost.join(', ')}`);
    // A narrowed type brings its own bounds (an int's safe range); one message is enough.
    if (lost.length === 0) out.push(...tighterBounds(path, was, now));
    if (now.pattern !== undefined && now.pattern !== was.pattern) {
      out.push(`input ${path} must now match the pattern ${now.pattern}`);
    }
    if (now.closed && !was.closed) {
      const what = path === ROOT ? 'input' : `input ${path}`;
      out.push(`${what} now rejects fields it does not name`);
    }
    if (now.enum && (!was.enum || was.enum.some((v) => !now.enum?.includes(v)))) {
      const gone = was.enum?.filter((v) => !now.enum?.includes(v)) ?? [];
      out.push(
        gone.length > 0
          ? `input ${path} no longer accepts ${gone.map((v) => JSON.stringify(v)).join(', ')}`
          : `input ${path} now accepts only ${now.enum.map((v) => JSON.stringify(v)).join(', ')}`,
      );
    }
    if (now.format !== undefined && now.format !== was.format) {
      out.push(`input ${path} now requires format ${now.format}`);
    }
  }
  for (const [path, now] of Object.entries(after)) {
    if (now.required !== true || before[path]?.required === true) continue;
    // A required child of a new optional parent breaks nobody: old inputs leave the parent out.
    if (path === ROOT) continue;
    const parent = parentOf(path);
    if (before[parent] !== undefined) out.push(`input ${path} is now required`);
  }
  return out;
}

function tighterBounds(path: string, was: SnapshotField, now: SnapshotField): string[] {
  const out: string[] = [];
  const check = (bound: Bound, tighter: (n: number, w: number) => boolean) => {
    const n = now.bounds?.[bound];
    const w = was.bounds?.[bound];
    if (n === undefined || (w !== undefined && !tighter(n, w))) return;
    out.push(`input ${path} now has ${bound} ${n}${w === undefined ? '' : ` (was ${w})`}`);
  };
  for (const bound of MIN_BOUNDS) check(bound, (n, w) => n > w);
  for (const bound of MAX_BOUNDS) check(bound, (n, w) => n < w);
  return out;
}

/** Callers' reads of old outputs must keep working: nothing removed, made optional or widened. */
function outputBreaks(before: Fields, after: Fields): string[] {
  const out: string[] = [];
  for (const [path, was] of Object.entries(before)) {
    const now = after[path];
    if (now === undefined) {
      if (!removedWithParent(path, before, after)) out.push(`output ${path} was removed`);
      continue;
    }
    if (was.required === true && now.required !== true) {
      out.push(`output ${path} is no longer always present`);
    }
    const added = types(now.type).filter((t) => !covers(types(was.type), t));
    if (added.length > 0) out.push(`output ${path} can now be ${added.join(', ')}`);
    // New enum values are additive (a new status category): consumers must handle unknown ones.
    if (was.enum && !now.enum) out.push(`output ${path} is no longer limited to its values`);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------

function snapshotEntry(op: AnyOperation): SnapshotEntry {
  return {
    kind: op.kind,
    ...(op.deprecated ? { deprecated: { ...op.deprecated } } : {}),
    input: snapshotFields(toJsonSchema(op.input, 'input'), 'input'),
    output: snapshotFields(toJsonSchema(op.output, 'output'), 'output'),
  };
}

const ROOT = '$';
/** Relations embed one level (§7.2), so real schemas are shallow; this stops recursive ones. */
const MAX_SNAPSHOT_DEPTH = 8;

/**
 * Every field of a schema, from its JSON Schema rather than the compact one: the compact schema
 * is written for readers (it folds item nullability into `string[]` and drops bounds), while a
 * breaking-change check needs both. Descriptions and defaults are left out: rewording is not a
 * schema change, and a removed default shows up as a newly required field.
 */
function snapshotFields(root: JsonSchema, io: 'input' | 'output'): Record<string, SnapshotField> {
  const out: Record<string, SnapshotField> = {};
  const visit = (
    node: JsonSchema,
    path: string,
    required: boolean,
    depth: number,
    refs: ReadonlySet<string>,
  ): void => {
    const ref = node.$ref;
    if (ref !== undefined) {
      const target = ref === '#' ? root : root.$defs?.[/^#\/\$defs\/([^/]+)$/.exec(ref)?.[1] ?? ''];
      if (refs.has(ref) || !isSchema(target)) {
        out[path] = { type: 'object', ...(required ? { required: true as const } : {}) };
        return;
      }
      visit({ ...target, ...withoutRef(node) }, path, required, depth, new Set([...refs, ref]));
      return;
    }
    const { inner, nullable } = splitNull(node);
    const isRef =
      typeof node[SURFACE_REF_KEY] === 'string' || typeof inner[SURFACE_REF_KEY] === 'string';
    out[path] = {
      type: snapshotType(inner) + (nullable ? '|null' : ''),
      ...(required ? { required: true as const } : {}),
      ...(isRef ? {} : valueRules(inner, io)),
    };
    if (isRef || depth >= MAX_SNAPSHOT_DEPTH) return;
    const keys = new Set(Array.isArray(inner.required) ? inner.required : []);
    for (const [key, child] of Object.entries(inner.properties ?? {})) {
      if (!isSchema(child)) continue;
      visit(child, path === ROOT ? key : `${path}.${key}`, keys.has(key), depth + 1, refs);
    }
    if (inner.type === 'array' && isSchema(inner.items)) {
      // An element is always present; whether it can be null is its own type.
      visit(inner.items, `${path}[]`, true, depth + 1, refs);
    }
  };
  visit(root, ROOT, true, 0, new Set());
  return out;
}

function valueRules(node: JsonSchema, io: 'input' | 'output'): Partial<SnapshotField> {
  const rules: { -readonly [K in keyof SnapshotField]?: SnapshotField[K] } = {};
  if (Array.isArray(node.enum)) rules.enum = node.enum;
  else if (node.const !== undefined) rules.enum = [node.const];
  if (typeof node.format === 'string') rules.format = node.format;
  if (io === 'output') return rules;
  const bounds: Partial<Record<Bound, number>> = {};
  for (const bound of [...MIN_BOUNDS, ...MAX_BOUNDS]) {
    const value = node[bound];
    if (typeof value === 'number') bounds[bound] = value;
  }
  if (Object.keys(bounds).length > 0) rules.bounds = bounds;
  if (typeof node.pattern === 'string' && rules.format === undefined) rules.pattern = node.pattern;
  if (node.type === 'object' && node.additionalProperties === false) rules.closed = true;
  return rules;
}

function snapshotType(node: JsonSchema): string {
  const ref = node[SURFACE_REF_KEY];
  if (typeof ref === 'string') return ref;
  if (typeof node.$ref === 'string') return 'object';
  if (typeof node.type === 'string') return node.type;
  if (Array.isArray(node.type)) return node.type.join('|');
  const variants = node.anyOf ?? node.oneOf;
  if (Array.isArray(variants)) {
    return [
      ...new Set(
        variants
          .filter(isSchema)
          .map((v) => splitNull(v).inner)
          .map(snapshotType),
      ),
    ].join('|');
  }
  return 'any';
}

/** `type: [x, "null"]` or `anyOf: [x, {type: "null"}]` as the non-null part and a flag. */
function splitNull(node: JsonSchema): { inner: JsonSchema; nullable: boolean } {
  if (Array.isArray(node.type) && node.type.includes('null')) {
    const rest = node.type.filter((t) => t !== 'null');
    return { inner: { ...node, type: rest.length === 1 ? rest[0] : rest }, nullable: true };
  }
  const variants = node.anyOf;
  if (Array.isArray(variants)) {
    const rest = variants.filter((v) => !(isSchema(v) && v.type === 'null'));
    if (rest.length < variants.length) {
      const [only] = rest;
      const inner =
        rest.length === 1 && isSchema(only)
          ? { ...withoutVariants(node), ...only }
          : { ...node, anyOf: rest };
      return { inner, nullable: true };
    }
  }
  return { inner: node, nullable: false };
}

function withoutRef(node: JsonSchema): JsonSchema {
  const { $ref: _ref, ...rest } = node;
  return rest;
}

function withoutVariants(node: JsonSchema): JsonSchema {
  const { anyOf: _anyOf, ...rest } = node;
  return rest;
}

/** Whether two compact fields agree on what a list convention fixes (type, required, values). */
function sameField(have: CompactField | undefined, want: CompactField): boolean {
  if (have === undefined) return false;
  const core = (f: CompactField) =>
    JSON.stringify([f.type, f.required ?? false, f.enum ?? null, f.format ?? null]);
  return core(have) === core(want);
}

/** Paths of uuid-formatted strings outside reference types, as dot-paths (`[]` for items). */
function rawUuidPaths(root: JsonSchema): string[] {
  const found = new Set<string>();
  const visit = (node: unknown, path: string, depth: number): void => {
    if (depth > 8 || !isSchema(node)) return;
    const schema = node;
    if (schema[SURFACE_REF_KEY] !== undefined) return;
    if (schema.format === 'uuid') found.add(path === '' ? '$' : path);
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      visit(child, path === '' ? key : `${path}.${key}`, depth + 1);
    }
    visit(schema.items, `${path}[]`, depth + 1);
    for (const variant of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) {
      visit(variant, path, depth + 1);
    }
    const name = /^#\/\$defs\/([^/]+)$/.exec(schema.$ref ?? '')?.[1];
    if (name !== undefined) visit(root.$defs?.[name], path, depth + 1);
  };
  visit(root, '', 0);
  return [...found];
}

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function types(type: string): string[] {
  return type.split('|');
}

function covers(set: readonly string[], type: string): boolean {
  return (
    set.includes(type) || set.includes('any') || (type === 'integer' && set.includes('number'))
  );
}

/** `a.b` → `a`, `a[]` → `a`, `a[].b` → `a[]`, a top-level field → the root, the root → ''. */
function parentOf(path: string): string {
  if (path === ROOT) return '';
  if (path.endsWith('[]')) return path.slice(0, -2);
  const dot = path.lastIndexOf('.');
  return dot < 0 ? ROOT : path.slice(0, dot);
}

/** Only the outermost removed field is reported. */
function removedWithParent(path: string, before: Fields, after: Fields): boolean {
  const parent = parentOf(path);
  return parent !== '' && before[parent] !== undefined && after[parent] === undefined;
}

function verbOf(op: AnyOperation): string {
  const name: unknown = op.name;
  return typeof name === 'string' ? (name.split('.')[1] ?? '') : '';
}

function operationIndex(operations: readonly AnyOperation[], name: string): number {
  const i = operations.findIndex((op) => op.name === name);
  return i < 0 ? operations.length : i;
}
