// AC-12: concurrent updates of one row all succeed or return CONFLICT; none return INTERNAL.
// SPEC-003 names `team.update`; teams arrive in PLAN-001, so this uses `debug.touch` on one row.
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  actors,
  counterOf,
  executorHarness,
  outboxFor,
  seedDebugItem,
  testExecutor,
  type ExecutorHarness,
} from './executor.js';

let h: ExecutorHarness;
beforeAll(async () => {
  h = await executorHarness();
});
afterAll(async () => {
  await h.close();
});

it('handles 50 concurrent touches of one row without INTERNAL or lost updates', async () => {
  const { executor } = testExecutor(h.pool);
  const id = await seedDebugItem(h.pool);
  const actor = actors(h.teams).engMember;

  const results = await Promise.all(
    Array.from({ length: 50 }, () => executor.execute('debug.touch', { id }, actor)),
  );

  const codes = results.map((r) => (r.ok ? 'ok' : r.error.code));
  expect(codes.filter((c) => c !== 'ok' && c !== 'CONFLICT')).toEqual([]);
  const succeeded = codes.filter((c) => c === 'ok').length;
  // Every success is counted exactly once, and the outbox agrees.
  expect(await counterOf(h.pool, id)).toBe(succeeded);
  const events = await outboxFor(h.pool, id);
  expect(events).toHaveLength(succeeded);
  // Each event records its own increment: from n-1 to n, once for every n.
  const steps = events.map((e) => e.changes as { counter: { from: number; to: number } });
  expect(steps.every(({ counter }) => counter.to === counter.from + 1)).toBe(true);
  expect(steps.map(({ counter }) => counter.to).sort((a, b) => a - b)).toEqual(
    Array.from({ length: succeeded }, (_, i) => i + 1),
  );
  // READ COMMITTED serialises on the row lock, so in practice none conflict.
  expect(succeeded).toBe(50);
});
