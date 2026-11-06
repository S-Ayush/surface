import { z } from 'zod';
import { catalogSnapshot } from '../../src/lint.js';
import { teamUpdate } from '../fixtures.js';
import type { LintFixture } from './types.js';

// Released with an optional name; now the name is required.
export const fixture: LintFixture = {
  rule: 8,
  snapshot: catalogSnapshot([teamUpdate]),
  operation: { ...teamUpdate, input: teamUpdate.input.extend({ name: z.string().min(1) }) },
  message: /^input name is now required\. Add a new operation instead/,
};
