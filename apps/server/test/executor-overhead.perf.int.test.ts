// AC-11: executor overhead stays under 2 ms p95. Overhead is everything the executor adds to the
// database round trips a transaction needs anyway: validation, resolution, permission, output
// validation, logging and metrics. Each sample pairs one execution with a raw
// `BEGIN READ ONLY; COMMIT` on the same pool, run back to back, and the budget applies to the
// difference, so machine load moves both sides alike.
// Runs alone (vitest.perf.config.js), and is a test rather than a Vitest bench because benches
// cannot fail CI.
import { pino } from 'pino';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { actors, executorHarness, testExecutor, type ExecutorHarness } from './executor.js';

let h: ExecutorHarness;
beforeAll(async () => {
  h = await executorHarness();
});
afterAll(async () => {
  await h.close();
});

const WARMUP = 100;
const SAMPLES = 500;
const BUDGET_MS = 2;

async function baseline(): Promise<void> {
  const client = await h.pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

async function overheadOf(run: () => Promise<{ ok: boolean }>) {
  for (let i = 0; i < WARMUP; i++) {
    await run();
    await baseline();
  }
  const diffs: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const started = performance.now();
    const result = await run();
    const executed = performance.now();
    await baseline();
    const raw = performance.now() - executed;
    expect(result.ok).toBe(true);
    diffs.push(executed - started - raw);
  }
  diffs.sort((a, b) => a - b);
  return {
    p50: diffs[Math.floor(SAMPLES * 0.5)] ?? Infinity,
    p95: diffs[Math.floor(SAMPLES * 0.95)] ?? Infinity,
  };
}

function report(name: string, { p50, p95 }: { p50: number; p95: number }): void {
  // Printed so CI history shows the trend, not just pass/fail.
  process.stdout.write(`${name} overhead: p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms\n`);
}

// Logs are serialized as in production, but not parsed back like captureLogs() does.
const quiet = () => testExecutor(h.pool, { log: pino({ level: 'info' }, { write() {} }) });

it('adds under 2 ms at p95 to a query with no references', async () => {
  const { executor } = quiet();
  const actor = actors(h.teams).engMember;
  const stats = await overheadOf(() => executor.execute('debug.echo', {}, actor));
  report('debug.echo', stats);
  expect(stats.p95).toBeLessThan(BUDGET_MS);
});

it('adds under 2 ms at p95 to a query that resolves a team reference', async () => {
  // Resolution is one indexed lookup inside the same transaction, so it belongs in the budget.
  const { executor } = quiet();
  const actor = actors(h.teams).engMember;
  const stats = await overheadOf(() => executor.execute('debug.teamEcho', { team: 'ENG' }, actor));
  report('debug.teamEcho', stats);
  expect(stats.p95).toBeLessThan(BUDGET_MS);
});
