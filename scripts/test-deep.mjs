#!/usr/bin/env node
// `pnpm test:deep [turbo options]` (plans README §6, "Test tiers"): what the gate leaves out.
// - every property at its full case count, all with one fresh seed, printed before and after
//   the run so a failure can be replayed;
// - the wall-clock budgets (`*.perf.test.ts`, the server's `*.perf.int.test.ts`) and the full
//   ordering stress (`sync-ordering.stress.int.test.ts`, 20 × 500). The server's part needs Docker.
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

const child = spawn('turbo', ['run', 'test:deep', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    SURFACE_PROPERTY_SEED: String(seed),
    SURFACE_VITEST_WORKERS: process.env.SURFACE_VITEST_WORKERS || WORKERS,
  },
});

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  process.stderr.write(`\ntest:deep: stopped after ${HARD_TIMEOUT_MS / 60_000} minutes.\n`);
  // Turbo passes SIGINT on to the tasks; SIGKILL follows if they don't stop.
  child.kill('SIGINT');
  setTimeout(() => child.kill('SIGKILL'), 15_000).unref();
}, HARD_TIMEOUT_MS);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  const ok = code === 0 && !timedOut;
  const outcome = ok ? 'passed' : `FAILED (${signal ?? `exit ${code}`})`;
  process.stdout.write(`\ntest:deep: ${outcome}, property seed ${seed} (replay: ${replay})\n`);
  process.exit(ok ? 0 : 1);
});
