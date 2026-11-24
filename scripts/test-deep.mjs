#!/usr/bin/env node
// `pnpm test:deep [turbo options]` (plans README §6, "Test tiers"; SPEC-004 D12): what the gate
// leaves out, in two phases.
// 1. `turbo run test:deep`: every property at its full case count, all with one fresh seed,
//    printed before and after the run so a failure can be replayed; and the full ordering stress
//    (`sync-ordering.stress.int.test.ts`, 20 × 500). The server's part needs Docker.
// 2. `turbo run test:timing --concurrency=1`: the wall-clock budgets (`*.perf.test.ts`, the
//    server's `*.perf.int.test.ts`), one package at a time with one worker, after everything else
//    has finished, so the machine's load is the budgets' own.
//
// Replay a run:    SURFACE_PROPERTY_SEED=<seed> pnpm test:deep
// One package:     SURFACE_PROPERTY_SEED=<seed> pnpm test:deep --filter @surface/sync-client
// fast-check also prints the seed and `path` of a failing case.
// The 1,000-case sync suite stays `pnpm sim:deep`.
import { spawn } from 'node:child_process';

/** The whole run stops after this long, so a hung test can't keep workers alive. */
const HARD_TIMEOUT_MS = 30 * 60_000;
/** Vitest workers per package: Turbo runs up to 10 tasks at once, one worker each fits 10 cores. */
const WORKERS = '1';

const given = process.env.SURFACE_PROPERTY_SEED;
const seed =
  given === undefined || given === '' ? Math.floor(Math.random() * 2 ** 31) : Number(given);
if (!Number.isSafeInteger(seed)) {
  process.stderr.write(`SURFACE_PROPERTY_SEED must be an integer, like 123456 (got "${given}").\n`);
  process.exit(2);
}
const replay = `SURFACE_PROPERTY_SEED=${seed} pnpm test:deep`;
process.stdout.write(`\ntest:deep: property seed ${seed} (replay: ${replay})\n\n`);

const env = {
  ...process.env,
  SURFACE_PROPERTY_SEED: String(seed),
  SURFACE_VITEST_WORKERS: process.env.SURFACE_VITEST_WORKERS || WORKERS,
};
const extra = process.argv.slice(2);

let child;
let stopping = false;

/**
 * Sends `signal` to the running phase's whole process group: Turbo, pnpm, Vitest and its
 * workers. The child leads its own group (`detached`), so nothing it started outlives the run.
 */
function signalGroup(signal) {
  if (child?.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group has already gone.
  }
}

/** Runs one phase; resolves with whether it passed. */
function phase(args) {
  return new Promise((resolve) => {
    child = spawn('turbo', args, { stdio: 'inherit', env, detached: true });
    child.on('error', (error) => {
      process.stderr.write(`test:deep: couldn't start turbo: ${error.message}\n`);
      resolve(false);
    });
    child.on('exit', (code) => resolve(code === 0));
  });
}

function finish(ok, why) {
  const outcome = ok ? 'passed' : `FAILED (${why})`;
  process.stdout.write(`\ntest:deep: ${outcome}, property seed ${seed} (replay: ${replay})\n`);
  process.exit(ok ? 0 : 1);
}

const timer = setTimeout(() => {
  stopping = true;
  process.stderr.write(`\ntest:deep: stopped after ${HARD_TIMEOUT_MS / 60_000} minutes.\n`);
  signalGroup('SIGINT');
  setTimeout(() => signalGroup('SIGKILL'), 15_000).unref();
}, HARD_TIMEOUT_MS);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    signalGroup(signal);
    setTimeout(() => signalGroup('SIGKILL'), 15_000).unref();
  });
}

// `--continue`: one package's failure doesn't hide the others' with the same seed.
const properties = await phase(['run', 'test:deep', '--continue', ...extra]);
if (stopping) finish(false, 'stopped');
const timing = await phase(['run', 'test:timing', '--concurrency=1', '--continue', ...extra]);
clearTimeout(timer);
if (stopping) finish(false, 'stopped');
finish(
  properties && timing,
  [!properties && 'properties phase', !timing && 'timing phase'].filter(Boolean).join(', '),
);
