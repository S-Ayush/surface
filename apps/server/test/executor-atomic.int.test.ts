// AC-5: a mutation's rows, sync-log entries and outbox events commit together; a failure after
// the handler leaves none of them. (Sync-log entries arrive with PLAN-002 S2's repo; this test
// then covers them through the same flush.)
import { randomUUID } from 'node:crypto';
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
  // Fails the transaction at COMMIT, after the outbox insert, for marked subjects. Only a
  // single transaction around rows and events keeps the row change from surviving that.
  await h.pool.query(`
    CREATE TABLE exec_fixture.reject_subjects (id text PRIMARY KEY);
    CREATE FUNCTION exec_fixture.reject_marked() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF EXISTS (SELECT 1 FROM exec_fixture.reject_subjects WHERE id = NEW.subject->>'id') THEN
        RAISE EXCEPTION 'rejected at commit';
      END IF;
      RETURN NULL;
    END $$;
    CREATE CONSTRAINT TRIGGER reject_marked AFTER INSERT ON event_outbox
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION exec_fixture.reject_marked();
  `);
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

it('leaves neither the row change nor the event when the commit itself fails', async () => {
  const { executor } = testExecutor(h.pool);
  const id = await seedDebugItem(h.pool);
  await h.pool.query('INSERT INTO exec_fixture.reject_subjects VALUES ($1)', [id]);

  const result = await executor.execute('debug.touch', { id }, actors(h.teams).engMember);

  expect(result).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
  expect(await counterOf(h.pool, id)).toBe(0);
  expect(await outboxFor(h.pool, id)).toEqual([]);
});

it('reports a reference deleted before the handler used it as CONFLICT, not INTERNAL', async () => {
  // SPEC-003 Q6: mutations run READ COMMITTED, so a row resolved at step 7 can be gone by the
  // time the handler points at it. A team id that never existed gives the same 23503.
  const { executor } = testExecutor(h.pool);
  const result = await executor.execute(
    'debug.orphanNote',
    { teamId: randomUUID() },
    actors(h.teams).engMember,
  );
  expect(result).toMatchObject({
    ok: false,
    error: {
      code: 'CONFLICT',
      message:
        'Something this change refers to was changed or deleted meanwhile. Reload and try again.',
    },
  });
});
