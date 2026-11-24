// `pnpm sim:deep [--runs <k>] [--file <name> ...] [hub|client|real ...]` is the deep run of the
// sync property suite (PLAN-011 S8, AC-8): `<k>` cases (1,000 by default) of every generated
// property, in three steps that run in this order, one after the other, never two at once:
// 1. hub: the fake hub's properties (`pnpm sim --runs <k>`), seed `SIM_DEFAULTS.simSeed`;
// 2. client: sync-client's `content.prop` and `partial.prop`, seed `PROPERTY_SEED`;
// 3. real: every real-server file with a generated property (`realFiles()`: lifecycle, comments,
//    reactions, attachments, workflow, drafts, convergence, archive, exactly-once, issues with
//    cascades and the HTTP races), one file at a time, seed `SIM_DEFAULTS.simSeed`. Fixed
//    examples in those files run once. Needs Docker and `pnpm build`. Hours at 1,000.
// With no step named, all three run. `--file` limits the real step to the files whose name
// contains it, to resume a run that stopped. Each step prints its seed and files before it
// starts. Exits 1 when a step fails; fast-check prints the seed and path of a failing case,
// which `pnpm sim --seed <s> --path <p>` (hub) replays. Below about 20 runs the real step's
// coverage checks (each operation confirmed at least once) can fail.
import { parseArgs } from 'node:util';
import { startVitest } from 'vitest/node';
import { STEPS, stepPlan } from './sim-deep-plan.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { runs: { type: 'string' }, file: { type: 'string', multiple: true } },
});
const runs = values.runs === undefined ? 1000 : Number(values.runs);
if (!Number.isSafeInteger(runs) || runs < 1) {
  process.stderr.write('--runs must be a positive integer, like --runs 1000\n');
  process.exit(2);
}
const steps = positionals.length > 0 ? STEPS.filter((step) => positionals.includes(step)) : STEPS;
const unknown = positionals.filter((step) => !STEPS.includes(step));
if (unknown.length > 0) {
  process.stderr.write(`Unknown step ${unknown.join(', ')}. Use hub, client or real.\n`);
  process.exit(2);
}

let failed = 0;
for (const [index, step] of steps.entries()) {
  const plan = stepPlan(step, runs);
  const files =
    step === 'real' && values.file !== undefined
      ? plan.files.filter((file) => values.file.some((name) => file.includes(name)))
      : plan.files;
  if (files.length === 0) {
    process.stderr.write(`No real-server file matches --file ${values.file.join(', ')}.\n`);
    process.exit(2);
  }
  process.stdout.write(
    `\nsim:deep step ${index + 1}/${steps.length} ${step}: ${runs} runs, seed ${plan.seed}\n` +
      files.map((file) => `  ${file}\n`).join(''),
  );
  const started = Date.now();
  const vitest = await startVitest(
    'test',
    files,
    // `verbose`: each test and its time as it ends, also in a log, so a run that stops can
    // resume with the files that hadn't finished (`--file`).
    { run: true, watch: false, reporters: ['verbose'], ...plan.options },
    plan.overrides,
  );
  const failures = vitest?.state.getCountOfFailedTests() ?? 1;
  await vitest?.close();
  const minutes = ((Date.now() - started) / 60_000).toFixed(1);
  const outcome = failures === 0 ? 'passed' : 'FAILED';
  process.stdout.write(
    `\nsim:deep ${step}: ${runs} runs, seed ${plan.seed}, ${minutes} min, ${outcome}\n`,
  );
  failed += failures;
}
process.exit(failed === 0 ? 0 : 1);
