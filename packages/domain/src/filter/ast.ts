/**
 * The Filter tree shared by views, `*.list`, and MCP (domain-model §5,
 * SPEC-003 §7.4). This schema checks structure only; `resolveFilter` checks it
 * against a model's fields.
 */
import { z } from 'zod';
import { FILTER_OPS, type FilterOp } from './fields.js';

/** Bounds that keep validation and SQL small whatever a client sends. */
export const FILTER_LIMITS = {
  /** Levels of `and`/`or` nesting. */
  maxDepth: 8,
  /** Conditions plus groups in one filter. */
  maxNodes: 200,
  maxListLength: 500,
  maxStringLength: 1_000,
} as const;

export type FilterScalar = string | number | boolean;
export type FilterValue = FilterScalar | (string | number)[];

export interface FilterCondition {
  field: string;
  op: FilterOp;
  value: FilterValue;
}
export type Filter = { and: Filter[] } | { or: Filter[] } | FilterCondition;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

// Postgres text can hold neither NUL nor unpaired surrogates; the driver would
// alter them, so the client and the server would compare different strings.
const filterString = z
  .string()
  .max(FILTER_LIMITS.maxStringLength)
  .refine((s) => !s.includes('\u0000') && !LONE_SURROGATE.test(s), {
    message: 'Text in filters cannot contain NUL characters or broken Unicode',
  });
const filterNumber = z.number().refine(Number.isFinite, { message: 'Numbers must be finite' });

const conditionSchema = z.strictObject({
  field: z.string().min(1).max(100),
  op: z.enum(FILTER_OPS),
  value: z.union([
    filterString,
    filterNumber,
    z.boolean(),
    z.array(z.union([filterString, filterNumber])).max(FILTER_LIMITS.maxListLength),
  ]),
});

const nodeSchema: z.ZodType<Filter> = z.lazy(() =>
  z.union([
    z.strictObject({ and: z.array(nodeSchema) }),
    z.strictObject({ or: z.array(nodeSchema) }),
    conditionSchema,
  ]),
);

/**
 * Depth and size are checked iteratively before the recursive schema runs, so
 * a deeply nested payload is rejected instead of overflowing the stack.
 */
function sizeProblem(input: unknown): string | undefined {
  const stack: { node: unknown; depth: number }[] = [{ node: input, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const item = stack.pop();
    if (!item || typeof item.node !== 'object' || item.node === null) continue;
    nodes += 1;
    if (nodes > FILTER_LIMITS.maxNodes) {
      return `Filter is too large: use at most ${FILTER_LIMITS.maxNodes} conditions and groups`;
    }
    const node = item.node;
    const kinds = (['and', 'or', 'field'] as const).filter((k) => k in node);
    // Checked here, not only by the union below: a node that is both a group and
    // something else would let the recursive schema walk an unchecked branch.
    if (kinds.length > 1) {
      return `A filter node must be exactly one of: {"and": [...]}, {"or": [...]}, or a condition (got ${kinds.join(' + ')})`;
    }
    const children = 'and' in node ? node.and : 'or' in node ? node.or : undefined;
    if (!Array.isArray(children)) continue;
    if (item.depth + 1 > FILTER_LIMITS.maxDepth) {
      return `Filter is nested too deeply: use at most ${FILTER_LIMITS.maxDepth} levels of and/or`;
    }
    for (const child of children as unknown[]) stack.push({ node: child, depth: item.depth + 1 });
  }
  return undefined;
}

export const FilterSchema: z.ZodType<Filter> = z
  .unknown()
  .superRefine((value, ctx) => {
    const problem = sizeProblem(value);
    if (problem) ctx.addIssue({ code: 'custom', message: problem, abort: true });
  })
  .pipe(nodeSchema);
