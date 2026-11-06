// SPEC-002 §10: the sync-log lock is held for p95 < 2 ms, from taking it to commit, read from
// the `surface_sync_lock_hold_seconds` metric the executor records. 8 concurrent writers on 4
// rows is well above small-team write rates (sync-protocol §3). The machine is shared, so each
// case keeps the best of up to 3 rounds, like AC-11: a real regression slows every round.
// Runs alone (vitest.perf.config.js).
import { randomUUID } from 'node:crypto';
import { Registry } from 'prom-client';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { actors, executorHarness, testExecutor, type ExecutorHarness } from './executor.js';

let h: ExecutorHarness;
beforeAll(async () => {
  h = await executorHarness();
});
afterAll(async () => {
  await h.close();
});

const WRITERS = 8;
const MUTATIONS = 1000;
const BUDGET_SECONDS = 0.002;
const ROUNDS = 3;

/** The share of lock holds at or under the budget, which must be a histogram bucket. */
async function shareWithinBudget(): Promise<number> {
  const registry = new Registry();
  const { executor } = testExecutor(h.pool, { metrics: registry });
  const actor = actors(h.teams).engMember;
  const ids = Array.from({ length: 4 }, () => randomUUID());
  for (const id of ids) await executor.execute('debug.create', { id, title: 'hot' }, actor);
  await Promise.all(
    Array.from({ length: WRITERS }, async (_, w) => {
      for (let i = 0; i < MUTATIONS / WRITERS; i++) {
        await executor.execute('debug.touch', { id: ids[(w + i) % ids.length] }, actor);
      }
    }),
  );
  const metric = await registry.getSingleMetric('surface_sync_lock_hold_seconds')?.get();
  const values = metric?.values ?? [];
  const named = (v: object, suffix: string) => {
    const name: unknown = Reflect.get(v, 'metricName');
    return typeof name === 'string' && name.endsWith(suffix);
  };
  const count = values.find((v) => named(v, '_count'))?.value ?? 0;
  const within = values.find((v) => named(v, '_bucket') && Number(v.labels.le) === BUDGET_SECONDS);
  if (!within) throw new Error(`no ${BUDGET_SECONDS} s bucket on the lock-hold histogram`);
  expect(count).toBe(MUTATIONS + ids.length);
  return within.value / count;
}

it('holds the sync lock for under 2 ms at p95', { timeout: 120_000 }, async () => {
  let best = 0;
  for (let round = 0; round < ROUNDS && best < 0.95; round++) {
    best = Math.max(best, await shareWithinBudget());
  }
  expect(best).toBeGreaterThanOrEqual(0.95);
});
