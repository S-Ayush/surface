// `pnpm sim [--seed <n>] [--runs <k>] [--path <p>] [convergence|exactly-once|archive]`
// runs the sync property suite (PLAN-002 S9) with other fast-check
// parameters than `pnpm test`: 1,000 cases on `main`, or one failing case.
// fast-check prints `seed` and `path` when a property fails; pass both to
// replay that case alone.
import { parseArgs } from 'node:util';
import { startVitest } from 'vitest/node';
import { SIM_DEFAULTS } from '../vitest.config.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    seed: { type: 'string' },
    runs: { type: 'string' },
    path: { type: 'string' },
  },
});

function integer(name, text, fallback) {
  if (text === undefined) return fallback;
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    process.stderr.write(`--${name} must be an integer, like --${name} 1000\n`);
    process.exit(2);
  }
  return value;
}

const provide = {
  simSeed: integer('seed', values.seed, SIM_DEFAULTS.simSeed),
  simRuns: integer('runs', values.runs, values.path === undefined ? SIM_DEFAULTS.simRuns : 1),
  simPath: values.path ?? '',
  // Every case asked for: the gate's share (plans README §6) applies to `pnpm test` only.
  propertyScale: 1,
};
const filters = positionals.length > 0 ? positionals : ['.prop.test.ts'];

// 1,000 cases take minutes per property: more than the suite's own timeout.
const testTimeout = 4 * 3600_000;
const vitest = await startVitest('test', filters, {
  run: true,
  watch: false,
  provide,
  testTimeout,
});
await vitest?.close();
