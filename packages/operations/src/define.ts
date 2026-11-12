import type { z } from 'zod';
import { isOperationDomain, type OperationDomain } from './domains.js';
import type { OptimisticStore } from './optimistic.js';
import type { PermissionPredicates, ResolvedRefs } from '@surface/domain';
import type { OperationUi } from './ui.js';

export type OperationKind = 'query' | 'mutation';

/** The call that undoes an operation, returned by `inverse()` (implemented in M2). */
export interface InverseCall {
  readonly op: string;
  readonly input: unknown;
}

export interface Deprecation {
  /** Release that deprecated the operation, like `0.3.0`. */
  readonly since: string;
  /** Name of the operation to use instead. */
  readonly replacedBy: string;
}

/**
 * An operation declaration (SPEC-003 §3.1). Generics stay on input and output only (PLAN-003
 * risks): the parsed input type flows to `permission`, `optimistic` and the server handler,
 * and the raw input type flows to `examples` and the client `dispatch`.
 *
 * Callbacks use method syntax so a concrete operation is assignable to `AnyOperation`.
 */
export interface OperationDef<
  Name extends string = string,
  Kind extends OperationKind = OperationKind,
  In extends z.ZodType = z.ZodType,
  Out extends z.ZodType = z.ZodType,
> {
  /** `<domain>.<verb>`, camelCase verb. Immutable once released. */
  readonly name: Name;
  readonly kind: Kind;
  readonly domain: OperationDomain;
  /** ≤ 80 characters, imperative, sentence case ("Update a team's name…"). */
  readonly summary: string;
  /** ≤ 400 characters. Mentions accepted reference formats and side effects. */
  readonly description: string;
  /** At least 2 natural-language phrasings a user or AI might use (registry lint rule 1). */
  readonly keywords: readonly string[];
  /** Uses reference types for every foreign entity (SPEC-003 §4). */
  readonly input: In;
  readonly output: Out;
  /** Runs after references are resolved and visibility-checked (SPEC-003 §5). */
  permission(p: PermissionPredicates, refs: ResolvedRefs, input: z.output<In>): boolean;
  /** `true` for deletes, purges, member removal, role changes and deactivation. */
  readonly destructive: boolean;
  /** At least one; each must validate against `input` and run against the seed fixture. */
  readonly examples: readonly z.input<In>[];
  /** Command-menu metadata, for mutations used in the UI. */
  readonly ui?: OperationUi;
  /** Client-side prediction over the overlay. Mutations only; pure and deterministic (§8). */
  optimistic?(store: OptimisticStore, input: z.output<In>): void;
  /** Returns the call that undoes this one, given the pre-state (M2). */
  inverse?(input: z.output<In>, pre: unknown): InverseCall | null;
  /**
   * The output holds a secret shown once, such as a link whose hash alone is stored. The executor
   * never stores it for an idempotent replay, and a repeated `clientMutationId` is refused with
   * `replayMessage`, which says how to get a new one (SPEC-003 §6 step 6; PLAN-001 S9).
   */
  readonly secretOutput?: { readonly replayMessage: string };
  /** Hidden from the API, the catalog and MCP (`debug.*`). */
  readonly internal?: boolean;
  readonly deprecated?: Deprecation;
}

/** Any operation, for registries and generic code. */
export type AnyOperation = OperationDef;

/** What a caller passes (client `dispatch`, HTTP body `input`): the schema's input side. */
export type InputOf<Op extends AnyOperation> = z.input<Op['input']>;
/** What `permission`, `optimistic` and the server handler receive: the parsed input. */
export type ParsedInputOf<Op extends AnyOperation> = z.output<Op['input']>;
/** What a successful call returns before `fields` shaping. */
export type OutputOf<Op extends AnyOperation> = z.output<Op['output']>;

/** Queries never write, so a query with `optimistic` is a type error as well as a runtime one. */
type KindRules<Kind extends OperationKind> = Kind extends 'query'
  ? { readonly optimistic?: never }
  : unknown;

export const OPERATION_NAME_PATTERN = /^[a-z][a-zA-Z]*\.[a-z][a-zA-Z]*$/;
export const SUMMARY_MAX_LENGTH = 80;
export const DESCRIPTION_MAX_LENGTH = 400;

export class OperationDefinitionError extends Error {
  override readonly name = 'OperationDefinitionError';
  constructor(
    readonly operation: string,
    readonly problems: readonly string[],
  ) {
    super(`Operation "${operation}" is invalid: ${problems.join('; ')}`);
  }
}

/**
 * The definition-time checks (PLAN-003 S1). They cover what a typo can break and the types
 * can't: name shape, domain, summary and description. The registry lint (S7) adds the rest.
 */
export function definitionProblems(def: AnyOperation): string[] {
  return definitionChecks(def).map((problem) => problem.message);
}

/**
 * A definition problem and the registry-lint rule it breaks (SPEC-003 §11): 1 for the required
 * fields (summary, description and its length), 7 for naming and the other §3.1 format checks.
 */
export interface DefinitionCheck {
  readonly rule: 1 | 7;
  readonly message: string;
}

/** The checks `defineOperation` runs, each tagged with its §11 rule for `registry:lint`. */
export function definitionChecks(def: AnyOperation): DefinitionCheck[] {
  const problems: DefinitionCheck[] = [];
  const add = (rule: 1 | 7, message: string): void => {
    problems.push({ rule, message });
  };
  // Runtime guards repeat some type-level rules because plain-JS callers and casts exist.
  const name: unknown = def.name;
  const kind: unknown = def.kind;
  const domain: unknown = def.domain;
  const summary: unknown = def.summary;
  const description: unknown = def.description;

  if (typeof name !== 'string' || !OPERATION_NAME_PATTERN.test(name)) {
    add(7, 'name must be <domain>.<verb> with a camelCase verb, like team.update');
  }
  if (kind !== 'query' && kind !== 'mutation') {
    add(7, 'kind must be "query" or "mutation"');
  }
  if (!isOperationDomain(domain)) {
    add(
      7,
      `domain "${String(domain)}" is not in domain-model §7. Use one of the listed domains, like team`,
    );
  }
  if (typeof summary !== 'string' || summary.trim() === '') {
    add(1, 'summary is required, like "Update a team\'s name"');
  } else {
    if (summary.length > SUMMARY_MAX_LENGTH) {
      add(7, `summary must be ${SUMMARY_MAX_LENGTH} characters or fewer (${summary.length})`);
    }
    if (!/^\p{Lu}/u.test(summary)) {
      add(7, 'summary must start with a capital letter, like "Update a team"');
    }
  }
  if (typeof description !== 'string' || description.trim() === '') {
    add(1, 'description is required: say what it changes and which references it accepts');
  } else if (description.length > DESCRIPTION_MAX_LENGTH) {
    add(
      1,
      `description must be ${DESCRIPTION_MAX_LENGTH} characters or fewer (${description.length})`,
    );
  }
  if (kind === 'query' && def.optimistic !== undefined) {
    add(7, 'queries cannot have optimistic(): only mutations change the store');
  }
  return problems;
}

/**
 * Declares an operation (SPEC-003 §3). Throws `OperationDefinitionError` when the definition
 * is malformed. The checks always run: they are cheap, run once at module load, and need no
 * environment flag, so a broken definition fails every test that imports it.
 */
export function defineOperation<
  const Name extends string,
  Kind extends OperationKind,
  In extends z.ZodType,
  Out extends z.ZodType,
>(def: OperationDef<Name, Kind, In, Out> & KindRules<Kind>): OperationDef<Name, Kind, In, Out> {
  const problems = definitionProblems(def);
  if (problems.length > 0) {
    throw new OperationDefinitionError(String(def.name), problems);
  }
  return Object.freeze({ ...def });
}
