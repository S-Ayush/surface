// `pnpm sim:deep [--runs <k>] [hub|client|real ...]` runs the 1,000-case run of the sync
// property suite (PLAN-011 S8, AC-8), one step after the other, never two at once:
// - hub: the fake hub's properties (`pnpm sim --runs <k>`), seed `SIM_DEFAULTS.simSeed`;
// - client: sync-client's `content.prop` and `partial.prop`, `propertyRuns: <k>`, seed
//   `PROPERTY_SEED`;
// - real: the generated properties of `issues-real-server.int.test.ts` on the real server (needs
//   Docker and `pnpm build`), seed `SIM_DEFAULTS.simSeed`. About 50 minutes at 1,000.
// With no step named, all three run. Exits 1 when a step fails; fast-check prints the seed and
// path of a failing case, which `pnpm sim --seed <s> --path <p>` (hub) replays. Below about 20
// runs the real step's coverage checks (each operation confirmed at least once) can fail.
import path from 'node:path';
import { parseArgs } from 'node:util';
import { startVitest } from 'vitest/node';
import { SIM_DEFAULTS } from '../vitest.config.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { runs: { type: 'string' } },
});
const runs = values.runs === undefined ? 1000 : Number(values.runs);
if (!Number.isSafeInteger(runs) || runs < 1) {
  process.stderr.write('--runs must be a positive integer, like --runs 1000\n');
  process.exit(2);
}
const STEPS = ['hub', 'client', 'real'];
const steps = positionals.length > 0 ? positionals : STEPS;
const unknown = steps.filter((step) => !STEPS.includes(step));
if (unknown.length > 0) {
  process.stderr.write(`Unknown step ${unknown.join(', ')}. Use hub, client or real.\n`);
  process.exit(2);
}

const simRoot = path.resolve(import.meta.dirname, '..');
const clientRoot = path.resolve(simRoot, '../../packages/sync-client');
const HOURS = 3600_000;

/** One step's files, root, config and provided values. */
const PLAN = {
  hub: {
    files: ['.prop.test.ts'],
    options: {
      root: simRoot,
      provide: { simSeed: SIM_DEFAULTS.simSeed, simRuns: runs, simPath: '' },
    },
  },
  client: {
    files: ['test/content.prop.test.ts', 'test/partial.prop.test.ts'],
    options: {
      root: clientRoot,
      config: path.join(clientRoot, 'vitest.config.js'),
      provide: { propertyRuns: runs },
      testTimeout: 4 * HOURS,
    },
  },
  real: {
    files: ['test/issues-real-server.int.test.ts'],
    options: {
      root: simRoot,
      config: path.join(simRoot, 'vitest.int.config.js'),
      testNamePattern: 'after any faults|after any interleaving',
      provide: { simSeed: SIM_DEFAULTS.simSeed, simRuns: runs, simPath: '' },
      testTimeout: 6 * HOURS,
    },
  },
};

let failed = 0;
for (const step of steps) {
  const started = Date.now();
  const { files, options } = PLAN[step];
  const vitest = await startVitest('test', files, { run: true, watch: false, ...options });
  const failures = vitest?.state.getCountOfFailedTests() ?? 1;
  await vitest?.close();
  const minutes = ((Date.now() - started) / 60_000).toFixed(1);
  const outcome = failures === 0 ? 'passed' : 'FAILED';
  process.stdout.write(`\nsim:deep ${step}: ${runs} runs, ${minutes} min, ${outcome}\n`);
  failed += failures;
}
process.exit(failed === 0 ? 0 : 1);
