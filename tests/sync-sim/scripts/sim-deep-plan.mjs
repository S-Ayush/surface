// What `pnpm sim:deep` runs (`sim-deep.mjs`): its steps in order, each one's files, seed and
// Vitest options. Apart from the script so `test/sim-deep.test.ts` can check that the asked
// runs reach the tests.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { SIM_DEFAULTS } from '../vitest.config.js';
import { serialConfig } from '../vitest.int.config.js';

/** The steps, in the order they run, one after the other. */
export const STEPS = ['hub', 'client', 'real'];

const simRoot = path.resolve(import.meta.dirname, '..');
const clientRoot = path.resolve(simRoot, '../../packages/sync-client');
const HOURS = 3600_000;

/** sync-client's `PROPERTY_SEED` (`test/support/fc.ts`; `test/sim-deep.test.ts` keeps them equal). */
export const CLIENT_SEED = 20261106;

/**
 * The real step's files: every `*.int.test.ts` here with a generated property (`fc.assert`), so a
 * new one joins the run without a change here. Fixed examples in them run once.
 */
export function realFiles() {
  const dir = path.join(simRoot, 'test');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.int.test.ts'))
    .filter((name) => readFileSync(path.join(dir, name), 'utf8').includes('fc.assert('))
    .sort()
    .map((name) => `test/${name}`);
}

/**
 * One step at `runs` cases per generated property: `files` (Vitest filters), `seed`, and the
 * `options` and `overrides` for `startVitest`.
 */
export function stepPlan(step, runs) {
  switch (step) {
    case 'hub':
      return {
        files: ['.prop.test.ts'],
        seed: SIM_DEFAULTS.simSeed,
        options: {
          root: simRoot,
          // `propertyScale: 1`: every case, not the gate's share (plans README §6).
          provide: { simSeed: SIM_DEFAULTS.simSeed, simRuns: runs, simPath: '', propertyScale: 1 },
          testTimeout: 4 * HOURS,
        },
        overrides: {},
      };
    case 'client':
      return {
        files: ['test/content.prop.test.ts', 'test/partial.prop.test.ts'],
        seed: CLIENT_SEED,
        options: {
          root: clientRoot,
          config: path.join(clientRoot, 'vitest.config.js'),
          provide: { propertyRuns: runs },
          testTimeout: 4 * HOURS,
        },
        overrides: {},
      };
    case 'real':
      return {
        files: realFiles(),
        seed: SIM_DEFAULTS.simSeed,
        // No config file: `vitest.int.config.js`'s phases would override these values with
        // their own (`serialConfig`). `propertyRuns` also scales the properties that state a
        // count of their own (the HTTP races in `issues-real-server.int.test.ts`).
        options: { root: simRoot, config: false },
        overrides: serialConfig({
          provide: {
            simSeed: SIM_DEFAULTS.simSeed,
            simRuns: runs,
            simPath: '',
            propertyRuns: runs,
          },
          testTimeout: 6 * HOURS,
        }),
      };
    default:
      throw new Error(`Unknown step ${step}. Use hub, client or real.`);
  }
}
