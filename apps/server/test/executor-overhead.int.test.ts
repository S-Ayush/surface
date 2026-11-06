// AC-11: executor overhead (everything but the handler) stays under 2 ms p95. `debug.echo`'s
// handler does no I/O, so its end-to-end time is the overhead: pool checkout, BEGIN READ ONLY,
// validation, permission, output validation, COMMIT, logging and metrics.
// A test rather than a Vitest bench, because benches cannot fail CI.
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

it('runs a no-op query in under 2 ms at p95', async () => {
  const { executor } = testExecutor(h.pool);
  const actor = actors(h.teams).engMember;
  for (let i = 0; i < WARMUP; i++) await executor.execute('debug.echo', {}, actor);

  const durations: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const started = performance.now();
    const result = await executor.execute('debug.echo', {}, actor);
    durations.push(performance.now() - started);
    expect(result.ok).toBe(true);
  }
  durations.sort((a, b) => a - b);
  const p95 = durations[Math.floor(SAMPLES * 0.95)] ?? Infinity;
  const p50 = durations[Math.floor(SAMPLES * 0.5)] ?? Infinity;
  // Printed so CI history shows the trend, not just pass/fail.
  process.stdout.write(`executor overhead: p50 ${p50.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms\n`);
  expect(p95).toBeLessThan(2);
});
