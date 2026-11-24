declare module 'vitest' {
  export interface ProvidedContext {
    /**
     * Which tier runs: the gate (`pnpm test`), `pnpm test:deep`'s properties and sizes, or its
     * timing phase. Set by `vitest.js`.
     */
    testTier: 'gate' | 'deep' | 'timing';
    /** Share of each property's full case count to run (gate < 1, deep 1). */
    propertyScale: number;
    /** One seed for every property of a `pnpm test:deep` run; unset in the gate. */
    propertySeed?: number;
    /** Exact cases per property, overriding the scale (`pnpm sim:deep`). */
    propertyRuns?: number;
  }
}

/** Options of a property's case count. */
export interface PropertyRunOptions {
  /** Every case in every tier: the private-team leak and permission properties. */
  readonly full?: boolean;
}

/** The fewest cases the gate runs of a property (all of them when it has fewer). */
export declare const GATE_FLOOR: number;
/** Cases to run for a property whose full count is `fullRuns`. */
export declare function propertyRuns(fullRuns: number, options?: PropertyRunOptions): number;
/** The seed of a property: `seed`, unless the run rotates seeds (`pnpm test:deep`). */
export declare function propertySeed<S extends number | undefined>(seed: S): number | S;
/** fast-check `seed` and `numRuns` (100 when unset) for this tier; other fields pass through. */
export declare function propertyParameters<
  P extends { readonly seed?: number; readonly numRuns?: number },
>(params?: P, options?: PropertyRunOptions): P & { numRuns: number };
/** Whether this is a `pnpm test:deep` run (full sizes). */
export declare function isDeepRun(): boolean;
