import { teamUpdate } from '../fixtures.js';
import type { LintFixture } from './types.js';

export const fixture: LintFixture = {
  rule: 2,
  operation: { ...teamUpdate, examples: [{ team: 'ENG' }, { team: 'ENG', name: '' }] },
  message: /^examples\[1\] does not match the input schema at name: /,
};
