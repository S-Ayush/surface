import { z } from 'zod';
import { defineOperation } from '../../src/index.js';
import { TeamRef } from '../fixtures.js';
import type { LintFixture } from './types.js';

export const fixture: LintFixture = {
  rule: 5,
  operation: defineOperation({
    name: 'team.removeMember',
    kind: 'mutation',
    domain: 'team',
    summary: 'Remove a member from a team',
    description: 'Removes a user from a team. Accepts a team key or id.',
    keywords: ['remove from team', 'kick from team'],
    input: z.object({ team: TeamRef }),
    output: z.object({ ok: z.boolean() }),
    permission: (p) => p.admin(),
    destructive: false,
    examples: [{ team: 'ENG' }],
  }),
  message: /removeMember removes data or access, so set destructive: true/,
};
