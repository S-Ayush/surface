import { z } from 'zod';
import { defineOperation } from '../../src/index.js';
import { TeamRef } from '../fixtures.js';
import type { LintFixture } from './types.js';

export const fixture: LintFixture = {
  rule: 4,
  operation: defineOperation({
    name: 'team.addMember',
    kind: 'mutation',
    domain: 'team',
    summary: 'Add a member to a team',
    description: 'Adds a user to a team. Accepts a team key or id.',
    keywords: ['add to team', 'invite to team'],
    input: z.object({ team: TeamRef, user: z.uuid() }),
    output: z.object({ ok: z.boolean() }),
    permission: (p) => p.admin(),
    destructive: false,
    examples: [{ team: 'ENG', user: '0192f0c1-7e5a-7b3c-9d4e-1f2a3b4c5d6e' }],
  }),
  message: /^input user is a raw uuid/,
};
