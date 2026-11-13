/**
 * Where an operation's input holds references, and in which order to resolve them
 * (SPEC-003 §4: scoped refs after their scope). Read from the input's JSON Schema, where every
 * reference type carries `x-surface-ref`, and cached per operation.
 */
import {
  isRefType,
  SURFACE_REF_ALLOW_INACTIVE_KEY,
  SURFACE_REF_KEY,
  SURFACE_REF_SCOPE_KEY,
  type RefType,
} from '@surface/domain';
import { toJsonSchema, type AnyOperation, type JsonSchema } from '@surface/operations';

/** Reference types that are always resolved within a team. */
const TEAM_SCOPED: ReadonlySet<RefType> = new Set(['StatusRef', 'CycleRef']);
/** Reference types that use a team scope when the input has one (LabelRef: team, then workspace). */
const OPTIONALLY_SCOPED: ReadonlySet<RefType> = new Set(['LabelRef']);
/** What a scope field may be: a team, or an issue whose team is the scope (PLAN-011 S4). */
const SCOPE_TYPES: ReadonlySet<RefType> = new Set(['TeamRef', 'IssueRef']);

export interface RefLocation {
  /** Field path in the parsed input, like `['owner', 'team']`. */
  readonly path: readonly string[];
  /** Dot-joined path; the key in `ResolvedRefs`. */
  readonly key: string;
  readonly type: RefType;
  /** An array of references (`labels: LabelRef[]`). */
  readonly many: boolean;
  /** Key of the `TeamRef` (or `IssueRef`: its team) location this reference resolves within. */
  readonly scope?: string;
  /** The scope's reference type: `TeamRef`, or `IssueRef` for the issue's team. */
  readonly scopeType?: RefType;
  /** `UserRef` only: deactivated users resolve too. */
  readonly allowInactive: boolean;
}

/** A definition bug, found the first time the operation runs (and in its tests). */
export class RefPlanError extends Error {
  override readonly name = 'RefPlanError';
}

const cache = new WeakMap<AnyOperation, readonly RefLocation[]>();

/** Reference locations of `def.input`, with every scope before the references that use it. */
export function refPlan(def: AnyOperation): readonly RefLocation[] {
  let plan = cache.get(def);
  if (!plan) {
    plan = buildPlan(def.name, toJsonSchema(def.input, 'input'));
    cache.set(def, plan);
  }
  return plan;
}

interface Found {
  path: string[];
  type: RefType;
  many: boolean;
  scopeField?: string;
  allowInactive: boolean;
}

export function buildPlan(opName: string, root: JsonSchema): readonly RefLocation[] {
  const found: Found[] = [];
  const consumed = new Set<JsonSchema>();
  collect(root, [], found, consumed, opName);
  assertAllConsumed(root, consumed, opName);

  const byKey = new Map(found.map((f) => [f.path.join('.'), f]));
  const locations = found.map((f): RefLocation => {
    const key = f.path.join('.');
    const base = { path: f.path, key, type: f.type, many: f.many, allowInactive: f.allowInactive };
    if (!f.scopeField) return base;

    const scope = byKey.get(f.scopeField);
    if (!scope) {
      if (OPTIONALLY_SCOPED.has(f.type)) return base;
      throw new RefPlanError(
        `${opName}: ${key} is a ${f.type}, which needs a TeamRef field "${f.scopeField}" in the input. Add it, or point the scope elsewhere with scopedTo().`,
      );
    }
    // An IssueRef scope means the issue's team (SPEC-003 §4: "the issue's or target team").
    if (!SCOPE_TYPES.has(scope.type) || scope.many) {
      throw new RefPlanError(
        `${opName}: ${key} is scoped to "${f.scopeField}", which must be a single TeamRef or IssueRef.`,
      );
    }
    return { ...base, scope: f.scopeField, scopeType: scope.type };
  });

  // Scopes are unscoped TeamRefs, so one pass ordering unscoped first is a valid topological order.
  return [...locations.filter((l) => !l.scope), ...locations.filter((l) => l.scope)];
}

function collect(
  node: JsonSchema,
  path: string[],
  out: Found[],
  consumed: Set<JsonSchema>,
  opName: string,
): void {
  const properties = node.type === 'object' ? node.properties : undefined;
  if (!properties) return;

  for (const [field, child] of Object.entries(properties)) {
    if (!isSchema(child)) continue;
    const here = [...path, field];
    const refNode = refNodeOf(child);
    if (refNode) {
      consume(child, consumed);
      out.push(found(refNode, here, false));
      continue;
    }
    const inner = nonNull(child);
    if (inner.type === 'array' && isSchema(inner.items)) {
      const itemRef = refNodeOf(inner.items);
      if (itemRef) {
        consume(inner.items, consumed);
        out.push(found(itemRef, here, true));
      }
      // Refs inside arrays of objects are left unconsumed, so assertAllConsumed reports them.
      continue;
    }
    if (inner.type === 'object') collect(inner, here, out, consumed, opName);
  }
}

/** Marks a reference field's whole subtree (wrappers, nullable branches) as handled. */
function consume(node: unknown, consumed: Set<JsonSchema>): void {
  if (Array.isArray(node)) {
    for (const item of node) consume(item, consumed);
  } else if (isSchema(node)) {
    consumed.add(node);
    for (const value of Object.values(node)) consume(value, consumed);
  }
}

function found(node: JsonSchema, path: string[], many: boolean): Found {
  const type = node[SURFACE_REF_KEY];
  if (!isRefType(type)) throw new RefPlanError(`Unknown reference type ${String(type)}`);
  const declared = node[SURFACE_REF_SCOPE_KEY];
  const scopeField =
    typeof declared === 'string' && (TEAM_SCOPED.has(type) || OPTIONALLY_SCOPED.has(type))
      ? declared
      : undefined;
  return {
    path,
    type,
    many,
    scopeField,
    allowInactive: node[SURFACE_REF_ALLOW_INACTIVE_KEY] === true,
  };
}

/** The node carrying the ref annotation: the field itself, or its non-null branch. */
function refNodeOf(node: JsonSchema): JsonSchema | undefined {
  if (node[SURFACE_REF_KEY] !== undefined) return node;
  const branches = node.anyOf ?? node.oneOf;
  if (!Array.isArray(branches)) return undefined;
  const nonNullBranches = branches.filter((b) => b.type !== 'null');
  const [only] = nonNullBranches;
  return nonNullBranches.length === 1 && only?.[SURFACE_REF_KEY] !== undefined ? only : undefined;
}

function nonNull(node: JsonSchema): JsonSchema {
  const branches = node.anyOf ?? node.oneOf;
  if (!Array.isArray(branches)) return node;
  const rest = branches.filter((b) => b.type !== 'null');
  const [only] = rest;
  return rest.length === 1 && only ? only : node;
}

/**
 * A reference the planner does not support (inside a union or an array of objects) would
 * reach the handler unresolved and unchecked for visibility, so it fails loudly instead.
 */
function assertAllConsumed(root: JsonSchema, consumed: Set<JsonSchema>, opName: string): void {
  const visit = (value: unknown, where: string): void => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => visit(v, `${where}[${i}]`));
      return;
    }
    if (!isSchema(value)) return;
    const type = value[SURFACE_REF_KEY];
    if (type !== undefined && !consumed.has(value)) {
      throw new RefPlanError(
        `${opName}: a ${isRefType(type) ? type : 'reference'} at ${where} is in a position the resolver does not support (a union or an array of objects). Use a top-level, nested-object or array-of-references field.`,
      );
    }
    for (const [k, v] of Object.entries(value)) visit(v, `${where}/${k}`);
  };
  visit(root, '#');
}

function isSchema(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
