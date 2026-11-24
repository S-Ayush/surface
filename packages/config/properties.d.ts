declare module 'vitest' {
  export interface ProvidedContext {
    /** Which tier runs: the gate (`pnpm test`) or `pnpm test:deep`. Set by `vitest.js`. */
    testTier: 'gate' | 'deep';
    /** Fraction of each property's full case count to run (gate < 1, deep 1). */
    propertyScale: number;
    /** One seed for every property of a `pnpm test:deep` run; unset in the gate. */
    propertySeed?: number;
    /** Exact cases per property, overriding the scale (`pnpm sim:deep`). */
    propertyRuns?: number;
  }
}

/** Cases to run for a property whose full count is `fullRuns`. */
export declare function propertyRuns(fullRuns: number): number;
/** The seed of a property: `seed`, unless the run rotates seeds (`pnpm test:deep`). */
export declare function propertySeed<S extends number | undefined>(seed: S): number | S;
/** fast-check `seed` and `numRuns` (100 when unset) for this tier; other fields pass through. */
export declare function propertyParameters<
  P extends { readonly seed?: number; readonly numRuns?: number },
>(params?: P): P & { numRuns: number };
/** Whether this is a `pnpm test:deep` run (full sizes, timing budgets). */
export declare function isDeepRun(): boolean;
