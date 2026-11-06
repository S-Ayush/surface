import { z } from 'zod';
import { defineOperation } from '../../src/index.js';
import type { LintFixture } from './types.js';

export const fixture: LintFixture = {
  rule: 6,
  operation: defineOperation({
    name: 'team.list',
    kind: 'query',
    domain: 'team',
    summary: 'List the teams you can see',
    description: 'Lists teams visible to you.',
    keywords: ['list teams', 'show all teams'],
    // Neither listInput nor connectionOf: a page size alone, and a bare array.
    input: z.object({ limit: z.int().min(1).max(500).default(50) }),
    output: z.array(z.object({ key: z.string() })),
    permission: (p) => p.any(),
    destructive: false,
    examples: [{}],
  }),
  message: /^(input|output) [\w.]+ differs from a list's/,
};
