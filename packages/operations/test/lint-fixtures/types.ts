import type { AnyOperation } from '../../src/index.js';
import type { CatalogSnapshot, LintRule } from '../../src/lint.js';

/** One deliberately broken operation; linting it reports `rule`, and only `rule` (AC-9). */
export interface LintFixture {
  readonly rule: LintRule;
  readonly operation: AnyOperation;
  /** The released catalog, for rule 8. */
  readonly snapshot?: CatalogSnapshot;
  /** Every problem's message matches this. */
  readonly message: RegExp;
}
