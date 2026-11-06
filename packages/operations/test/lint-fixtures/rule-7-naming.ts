import { teamUpdate } from '../fixtures.js';
import type { LintFixture } from './types.js';

// A plain object: defineOperation would throw on these.
export const fixture: LintFixture = {
  rule: 7,
  operation: { ...teamUpdate, name: 'team.Update', summary: `Update ${'a team '.repeat(15)}` },
  message: /^(name must be <domain>\.<verb>|summary must be 80 characters or fewer)/,
};
