import { propertyRuns, propertySeed } from '@surface/config/properties';
import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    /** fast-check seed for the property suite (`pnpm sim --seed`). */
    simSeed: number;
    /** Full cases per property: the gate runs a share of them (plans README §6), `pnpm sim` all. */
    simRuns: number;
    /** fast-check path of one failing case to replay, or `''`. */
    simPath: string;
  }
}

/**
 * fast-check parameters for a property, from `vitest.config.js` or `pnpm sim`. The test tier
 * scales the runs and, in `pnpm test:deep`, rotates the seed (`@surface/config/properties`).
 */
export function simParameters(): { seed: number; numRuns: number; path?: string } {
  const path = inject('simPath');
  return {
    seed: propertySeed(inject('simSeed')),
    numRuns: path === '' ? propertyRuns(inject('simRuns')) : inject('simRuns'),
    ...(path === '' ? {} : { path }),
  };
}
