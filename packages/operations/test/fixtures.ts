import { SURFACE_REF_KEY } from '@surface/domain';
import { z } from 'zod';
import { defineOperation } from '../src/index.js';

/**
 * Stand-ins shaped like the SPEC-003 §3 example. The real reference types arrive in
 * PLAN-003 S2 and the real team operations in PLAN-001; these fixtures are not registered.
 */
export const TeamRef = z
  .string()
  .min(1)
  .meta({ [SURFACE_REF_KEY]: 'TeamRef', description: 'Team key like ENG (any case), or team id' });

const Color = z.string().regex(/^#[0-9a-f]{6}$/i);
const TimeZone = z.string().min(1);

const TeamSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  icon: z.string().nullable(),
  color: Color,
  timezone: TimeZone,
  private: z.boolean(),
  updatedAt: z.iso.datetime(),
});

export const teamUpdate = defineOperation({
  name: 'team.update',
  kind: 'mutation',
  domain: 'team',
  summary: "Update a team's name, icon, color or timezone",
  description: 'Changes general settings of a team. The team key cannot be changed.',
  keywords: ['rename team', 'team settings', 'timezone'],
  input: z.object({
    team: TeamRef,
    name: z.string().min(1).max(64).optional(),
    icon: z.string().nullable().optional(),
    color: Color.optional(),
    timezone: TimeZone.optional(),
  }),
  output: TeamSchema,
  permission: (p, { team }) => p.admin() || p.teamMember(team),
  destructive: false,
  examples: [{ team: 'ENG', name: 'Engineering' }],
  ui: { title: 'Rename team…', icon: 'pencil', contexts: ['team'], shortcut: null },
  optimistic: (store, input) => {
    const { team, ...changes } = input;
    store.patch('Team', team, changes);
  },
});

/** A `*.list` query following SPEC-003 §7.1, the largest input shape M0 will have. */
export const teamList = defineOperation({
  name: 'team.list',
  kind: 'query',
  domain: 'team',
  summary: 'List the teams you can see',
  description:
    'Lists teams visible to you, including private teams you belong to. Supports filter, ordering and cursor pagination.',
  keywords: ['list teams', 'show all teams', 'which teams exist'],
  input: z.object({
    filter: z.record(z.string(), z.unknown()).optional().describe('Filter model, domain-model §5'),
    orderBy: z.enum(['name', 'createdAt', 'updatedAt']).default('name'),
    limit: z.number().int().min(1).max(100).default(25),
    cursor: z.string().optional().describe('endCursor from the previous page'),
    includeArchived: z.boolean().default(false),
  }),
  output: z.object({
    nodes: z.array(TeamSchema.pick({ id: true, key: true, name: true, icon: true })),
    pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
    totalCount: z.number().int().optional(),
  }),
  permission: (p) => p.any(),
  destructive: false,
  examples: [{}, { limit: 10, orderBy: 'updatedAt' }],
});
