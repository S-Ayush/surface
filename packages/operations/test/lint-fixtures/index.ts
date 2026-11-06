import { fixture as rule1 } from './rule-1-keywords.js';
import { fixture as rule2 } from './rule-2-example.js';
import { fixture as rule3 } from './rule-3-optimistic.js';
import { fixture as rule4 } from './rule-4-raw-uuid.js';
import { fixture as rule5 } from './rule-5-destructive.js';
import { fixture as rule6 } from './rule-6-list.js';
import { fixture as rule7 } from './rule-7-naming.js';
import { fixture as rule8 } from './rule-8-breaking.js';

export type { LintFixture } from './types.js';

/** One broken operation per SPEC-003 §11 rule, in rule order. */
export const LINT_FIXTURES = [rule1, rule2, rule3, rule4, rule5, rule6, rule7, rule8];
