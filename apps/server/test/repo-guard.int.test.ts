// AC-12 (SPEC-002), runtime half: a mutation that writes a synced table around the repo layer
// fails, and nothing it did is kept. Every executor integration test runs with this check.
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  actors,
  executorHarness,
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

it('fails a mutation that writes a synced row the repo did not log, and rolls it back', async () => {
  const { executor, logs } = testExecutor(h.pool);
  const id = await seedDebugItem(h.pool, { title: 'Original' });

  const result = await executor.execute('debug.sideWrite', { id }, actors(h.teams).engMember);

  expect(result.ok ? 'ok' : result.error.code).toBe('INTERNAL');
  expect(JSON.stringify(logs.lines)).toContain(
    'debug.sideWrite wrote synced rows outside the repo layer',
  );
  const { rows } = await h.pool.query<{ title: string }>(
    'SELECT title FROM debug_items WHERE id = $1',
    [id],
  );
  expect(rows[0]?.title).toBe('Original');
});

it('passes mutations that write only through the repo', async () => {
  const { executor } = testExecutor(h.pool);
  const id = await seedDebugItem(h.pool);
  const result = await executor.execute(
    'debug.rename',
    { id, title: 'Logged' },
    actors(h.teams).engMember,
  );
  expect(result.ok).toBe(true);
});
