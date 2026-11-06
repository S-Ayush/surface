/**
 * Shared shapes of list, count and groupBy queries (SPEC-003 §7.1, §7.3). Each `*.list`
 * spreads `listInput` into its input and wraps its node schema with `connectionOf`.
 */
import { FilterSchema } from '@surface/domain';
import { z } from 'zod';

export const LIST_LIMIT_DEFAULT = 25;
export const LIST_LIMIT_MAX = 100;

const filter = FilterSchema.meta({
  description:
    'Filter tree: {"and": [...]}, {"or": [...]}, or {"field", "op", "value"} (SPEC-003 §7.4)',
}).optional();

/** One sort key; ties are broken by id, so pages never overlap (SPEC-003 Decision Q7). */
export const OrderBySchema = z.object({
  field: z.string().min(1).max(100),
  direction: z.enum(['asc', 'desc']).default('asc'),
});
export type OrderBy = z.output<typeof OrderBySchema>;

/** Input fields of every `*.list`: `z.object({ ...listInput, team: TeamRef })`. */
export const listInput = {
  filter,
  orderBy: OrderBySchema.optional(),
  limit: z.int().min(1).max(LIST_LIMIT_MAX).default(LIST_LIMIT_DEFAULT),
  /** `pageInfo.endCursor` of the previous page, as returned. */
  cursor: z.string().min(1).max(1_000).optional(),
  includeArchived: z.boolean().default(false),
};

/** Input fields of every `*.count`. */
export const countInput = { filter, includeArchived: z.boolean().default(false) };

/** Input fields of every `*.groupBy`: the grouping, by name, plus the count's fields. */
export const groupByInput = { ...countInput, groupBy: z.string().min(1).max(100) };

/** A page of a list: `{ nodes, pageInfo, totalCount? }`. */
export function connectionOf<T extends z.ZodType>(node: T) {
  return z.object({
    nodes: z.array(node),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
    totalCount: z.int().min(0).optional(),
  });
}

export const CountOutput = z.object({ count: z.int().min(0) });

/** `*.groupBy` output: one entry per group, largest first. `key` is null for "none". */
export const GroupByOutput = z.array(
  z.object({
    key: z.string().nullable(),
    label: z.string(),
    count: z.int().min(0),
    estimateSum: z.number().optional(),
  }),
);
