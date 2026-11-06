// AC-4 / E3: queries run in read-only transactions; a write attempt fails as INTERNAL and is logged.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { actors, executorHarness, testExecutor, type ExecutorHarness } from './executor.js';

let h: ExecutorHarness;
beforeAll(async () => {
  h = await executorHarness();
});
afterAll(async () => {
  await h.close();
});

it('stops a query that writes, leaves nothing behind, and logs the bug', async () => {
  const { executor, logs } = testExecutor(h.pool);
  const id = randomUUID();
  const result = await executor.execute('debug.sneakyWrite', { id }, actors(h.teams).engMember);

  expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
  const { rowCount } = await h.pool.query('SELECT 1 FROM debug_items WHERE id = $1', [id]);
  expect(rowCount).toBe(0);
  const logged = JSON.stringify(logs.lines.find((l) => l.msg === 'operation failed'));
  // 25006 read_only_sql_transaction
  expect(logged).toContain('"code":"25006"');
  expect(logged).toContain('insert into \\"debug_items\\"');
  // Query parameters can be secrets: none of the bound values reach the log (CLAUDE.md rule 6).
  expect(logged).not.toContain(id);
  expect(logged).not.toContain('canary-title-7f3a');
});

it('keeps the value out of the log when Postgres rejects it in a cast', async () => {
  const { executor, logs } = testExecutor(h.pool);
  // Class 22 errors quote the offending value in their message ("invalid input syntax for
  // type uuid: \"…\""), and that value can be user input or a secret.
  const canary = 'canary-cast-91bd';
  const result = await executor.execute(
    'debug.badCast',
    { value: canary },
    actors(h.teams).engMember,
  );

  expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
  const logged = JSON.stringify(logs.lines.find((l) => l.msg === 'operation failed'));
  expect(logged).toContain('"code":"22P02"');
  expect(logged).not.toContain(canary);
});

it('lets queries read normally', async () => {
  const { executor } = testExecutor(h.pool);
  expect(await executor.execute('debug.echo', { text: 'ro' }, actors(h.teams).engMember)).toEqual({
    ok: true,
    result: { text: 'ro', actorKind: 'user' },
  });
});
