/**
 * Property tests use a fixed seed so a run is reproducible; fast-check prints
 * the seed and counterexample path of any failure. To explore other cases,
 * change the seed locally.
 */
import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    /**
     * Cases per sync property, for a deeper run than `pnpm test` (PLAN-011 S8: the 1,000-case
     * run provides it through `startVitest`); unset, each property keeps its own count.
     */
    propertyRuns?: number;
  }
}

export const PROPERTY_SEED = 20261106;
export const PROPERTY_RUNS = 300;

/** `numRuns` of a sync property: `fallback`, unless a run provides `propertyRuns`. */
export function propertyRuns(fallback: number): number {
  return inject('propertyRuns') ?? fallback;
}
