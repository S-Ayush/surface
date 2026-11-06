/**
 * Internal fixture operations (PLAN-003 S4, PLAN-002 header). Hidden from the API, the
 * catalog and MCP, and callable only by user actors outside production (SPEC-003 §6 step 2).
 */
import { z } from 'zod';
import { defineOperation } from '../define.js';
import { connectionOf, listInput } from '../list.js';

export const DebugItemSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  counter: z.number().int(),
  updatedAt: z.iso.datetime(),
});

export const debugEcho = defineOperation({
  name: 'debug.echo',
  kind: 'query',
  domain: 'debug',
  summary: 'Echo the input back',
  description:
    'Returns the text it was given and the kind of actor that called it. For executor tests.',
  keywords: ['echo', 'ping the executor'],
  input: z.object({ text: z.string().max(1000).default('hello') }),
  output: z.object({ text: z.string(), actorKind: z.enum(['user', 'api', 'mcp', 'system']) }),
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ text: 'hello' }],
  internal: true,
});

export const debugTouch = defineOperation({
  name: 'debug.touch',
  kind: 'mutation',
  domain: 'debug',
  summary: 'Increment a debug item’s counter',
  description:
    'Adds one to the counter of a debug item visible to you and emits debug.touched. For executor and sync tests.',
  keywords: ['touch debug item', 'increment counter'],
  // Debug items have no reference type; an id is the only way to name one.
  input: z.object({ id: z.uuid() }),
  output: DebugItemSchema,
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ id: '0192f0c1-7e5a-7b3c-9d4e-1f2a3b4c5d6e' }],
  internal: true,
});

export const debugListItems = defineOperation({
  name: 'debug.listItems',
  kind: 'query',
  domain: 'debug',
  summary: 'List debug items',
  description:
    'Lists debug items visible to you, with a filter (title, counter, updatedAt), a sort order and cursor pagination. For list-helper tests.',
  keywords: ['list debug items', 'page through debug items'],
  input: z.object({ ...listInput }),
  output: connectionOf(DebugItemSchema),
  permission: (p) => p.any(),
  destructive: false,
  examples: [{ orderBy: { field: 'title' }, limit: 10 }],
  internal: true,
});
