import type { ViteUserConfig } from 'vitest/config';
import type { InlineConfig } from 'vitest/node';

export type Step = 'hub' | 'client' | 'real';

/** The steps, in the order they run, one after the other. */
export declare const STEPS: readonly Step[];
/** sync-client's `PROPERTY_SEED`. */
export declare const CLIENT_SEED: number;
/** The real step's files: every `*.int.test.ts` with a generated property. */
export declare function realFiles(): string[];
/** One step at `runs` cases per generated property. */
export declare function stepPlan(
  step: Step,
  runs: number,
): {
  files: string[];
  seed: number;
  options: InlineConfig;
  overrides: ViteUserConfig;
};
