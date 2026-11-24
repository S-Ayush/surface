/**
 * Property tests use a fixed seed so a run is reproducible; fast-check prints
 * the seed and counterexample path of any failure. `pnpm test:deep` rotates the
 * seed and runs every case; the gate runs a share of them
 * (`@surface/config/properties`, plans README §6). `pnpm sim:deep` provides
 * `propertyRuns` for its 1,000-case run (PLAN-011 S8).
 */
export { propertyParameters, propertyRuns, propertySeed } from '@surface/config/properties';

export const PROPERTY_SEED = 20261106;
export const PROPERTY_RUNS = 300;
