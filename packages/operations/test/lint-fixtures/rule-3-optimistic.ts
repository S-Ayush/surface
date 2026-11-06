import { z } from 'zod';
import { defineOperation } from '../../src/index.js';
import { TeamRef } from '../fixtures.js';
import type { LintFixture } from './types.js';

export const fixture: LintFixture = {
  rule: 3,
  // Shown in the UI (it has `ui`), so the client dispatches it, but it has no optimistic().
  operation: defineOperation({
    name: 'team.archive',
    kind: 'mutation',
    domain: 'team',
    summary: 'Archive a team',
    description: 'Hides a team from lists. Accepts a team key or id.',
    keywords: ['archive team', 'hide team'],
    input: z.object({ team: TeamRef }),
    output: z.object({ ok: z.boolean() }),
    permission: (p) => p.admin(),
    destructive: false,
    examples: [{ team: 'ENG' }],
    ui: { title: 'Archive team…', icon: 'archive', contexts: ['team'], shortcut: null },
  }),
  message: /has no optimistic\(\)/,
};
