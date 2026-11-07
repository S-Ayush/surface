import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    /** fast-check seed for the property suite (`pnpm sim --seed`). */
    simSeed: number;
    /** Cases per property (200 on PRs, 1,000 on `main`). */
    simRuns: number;
    /** fast-check path of one failing case to replay, or `''`. */
    simPath: string;
  }
}

/** fast-check parameters for a property, from `vitest.config.js` or `pnpm sim`. */
export function simParameters(): { seed: number; numRuns: number; path?: string } {
  const path = inject('simPath');
  return {
    seed: inject('simSeed'),
    numRuns: inject('simRuns'),
    ...(path === '' ? {} : { path }),
  };
}
