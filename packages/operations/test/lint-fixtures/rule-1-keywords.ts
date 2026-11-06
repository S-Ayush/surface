import { teamUpdate } from '../fixtures.js';
import type { LintFixture } from './types.js';

export const fixture: LintFixture = {
  rule: 1,
  operation: { ...teamUpdate, keywords: ['rename team', 'Rename team '] },
  message: /keywords needs at least 2 different phrasings/,
};
