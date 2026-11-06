// AC-5: a mutation's rows, sync-log entries and outbox events commit together; a failure after
// the handler leaves none of them. (Sync-log entries arrive with PLAN-002 S2's repo; this test
// then covers them through the same flush.)
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { PostHandlerCheck } from '../src/executor/execute.js';
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

it('commits the row change and its outbox event together', async () => {
  const { executor } = testExecutor(h.pool);
  const id = await seedDebugItem(h.pool);
  expect((await executor.execute('debug.touch', { id }, actors(h.teams).engMember)).ok).toBe(true);
  expect(await counterOf(h.pool, id)).toBe(1);
  expect(await outboxFor(h.pool, id)).toHaveLength(1);
});

it('rolls back the row and the events when a check after the handler fails', async () => {
  const seen: { changes: number; events: number }[] = [];
  const failingInvariant: PostHandlerCheck = ({ changes, events }) => {
    seen.push({ changes: changes.length, events: events.length });
    return Promise.reject(new Error('invariant violated'));
  };
  const { executor } = testExecutor(h.pool, { checks: [failingInvariant] });
  const id = await seedDebugItem(h.pool);

  const result = await executor.execute('debug.touch', { id }, actors(h.teams).engMember);

  expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
  // The handler did write and emit before the failure…
  expect(seen).toEqual([{ changes: 1, events: 1 }]);
  // …and none of it survived.
  expect(await counterOf(h.pool, id)).toBe(0);
  expect(await outboxFor(h.pool, id)).toEqual([]);
});

it('returns NOT_FOUND for an item outside the actor’s groups, without touching it', async () => {
  const { executor } = testExecutor(h.pool);
  const id = await seedDebugItem(h.pool, { groups: [`team:${h.teams.sec}`] });
  const who = actors(h.teams);
  expect(await executor.execute('debug.touch', { id }, who.engMember)).toMatchObject({
    ok: false,
    error: { code: 'NOT_FOUND' },
  });
  expect((await executor.execute('debug.touch', { id }, who.secMember)).ok).toBe(true);
  expect(await counterOf(h.pool, id)).toBe(1);
});
