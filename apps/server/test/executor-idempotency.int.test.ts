// AC-8: a `clientMutationId` repeated within 24 h returns the identical result without running
// the mutation again (SPEC-003 §9), including when the repeats arrive at the same time.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PostHandlerCheck } from '../src/executor/execute.js';
import { pruneIdempotency } from '../src/executor/idempotency.js';
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
let who: ReturnType<typeof actors>;
beforeAll(async () => {
  h = await executorHarness();
  who = actors(h.teams);
});
afterAll(async () => {
  await h.close();
});

describe('clientMutationId', () => {
  it('replays the stored result, byte for byte, without running again', async () => {
    const { executor } = testExecutor(h.pool);
    const id = await seedDebugItem(h.pool);
    const clientMutationId = randomUUID();

    const first = await executor.execute('debug.touch', { id }, who.engMember, {
      clientMutationId,
    });
    const second = await executor.execute('debug.touch', { id }, who.engMember, {
      clientMutationId,
    });

    expect(first).toMatchObject({ ok: true, result: { id, counter: 1 } });
    expect(second).toEqual({ ...first, replayed: true });
    if (!first.ok || !second.ok) return;
    expect(JSON.stringify(second.result)).toBe(JSON.stringify(first.result));
    expect(await counterOf(h.pool, id)).toBe(1);
    expect(await outboxFor(h.pool, id)).toHaveLength(1);
  });

  it('runs once when repeats arrive concurrently', async () => {
    const { executor } = testExecutor(h.pool);
    const id = await seedDebugItem(h.pool);
    const clientMutationId = randomUUID();

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        executor.execute('debug.touch', { id }, who.engMember, { clientMutationId }),
      ),
    );

    expect(results.every((r) => r.ok)).toBe(true);
    expect(results.filter((r) => r.ok && !r.replayed)).toHaveLength(1);
    // Every caller sees the one execution's result.
    expect(new Set(results.map((r) => (r.ok ? JSON.stringify(r.result) : 'failed'))).size).toBe(1);
    expect(await counterOf(h.pool, id)).toBe(1);
  });

  it('runs again when the first attempt rolled back', async () => {
    const failing: PostHandlerCheck = () => Promise.reject(new Error('invariant violated'));
    const id = await seedDebugItem(h.pool);
    const clientMutationId = randomUUID();

    const failed = await testExecutor(h.pool, { checks: [failing] }).executor.execute(
      'debug.touch',
      { id },
      who.engMember,
      { clientMutationId },
    );
    const retried = await testExecutor(h.pool).executor.execute(
      'debug.touch',
      { id },
      who.engMember,
      {
        clientMutationId,
      },
    );

    expect(failed.ok).toBe(false);
    expect(retried).toMatchObject({ ok: true, result: { counter: 1 } });
    expect(retried).not.toHaveProperty('replayed');
  });

  it('rejects an id reused for another operation', async () => {
    const { executor } = testExecutor(h.pool);
    const clientMutationId = randomUUID();
    await executor.execute('debug.createItem', { id: randomUUID(), title: 'a' }, who.engMember, {
      clientMutationId,
    });
    const id = await seedDebugItem(h.pool);
    expect(
      await executor.execute('debug.touch', { id }, who.engMember, { clientMutationId }),
    ).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: `clientMutationId "${clientMutationId}" was already used for debug.createItem. Use a new id for each change.`,
        issues: [{ path: ['clientMutationId'] }],
      },
    });
    expect(await counterOf(h.pool, id)).toBe(0);
  });

  it('scopes ids to who sent them', async () => {
    const { executor } = testExecutor(h.pool);
    const id = await seedDebugItem(h.pool);
    const clientMutationId = randomUUID();
    await executor.execute('debug.touch', { id }, who.engMember, { clientMutationId });
    const other = await executor.execute('debug.touch', { id }, who.secMember, {
      clientMutationId,
    });
    expect(other).toMatchObject({ ok: true, result: { counter: 2 } });
  });

  it('forgets ids after 24 hours, and the prune job deletes only expired ones', async () => {
    const { executor } = testExecutor(h.pool);
    const id = await seedDebugItem(h.pool);
    const old = randomUUID();
    const fresh = randomUUID();
    await executor.execute('debug.touch', { id }, who.engMember, { clientMutationId: old });
    await executor.execute('debug.touch', { id }, who.engMember, { clientMutationId: fresh });
    await h.pool.query(
      `UPDATE api_idempotency SET created_at = now() - interval '24 hours 1 second'
        WHERE client_mutation_id = $1`,
      [old],
    );

    const again = await executor.execute('debug.touch', { id }, who.engMember, {
      clientMutationId: old,
    });
    expect(again).toMatchObject({ ok: true, result: { counter: 3 } });
    expect(again).not.toHaveProperty('replayed');

    await h.pool.query(
      `UPDATE api_idempotency SET created_at = now() - interval '25 hours'
        WHERE client_mutation_id = $1`,
      [old],
    );
    expect(await pruneIdempotency(h.pool)).toBe(1);
    const { rows } = await h.pool.query<{ client_mutation_id: string }>(
      'SELECT client_mutation_id FROM api_idempotency WHERE client_mutation_id = ANY($1)',
      [[old, fresh]],
    );
    expect(rows.map((r) => r.client_mutation_id)).toEqual([fresh]);
  });

  it('ignores the id for queries, and checks its length', async () => {
    const { executor } = testExecutor(h.pool);
    const clientMutationId = randomUUID();
    expect((await executor.execute('debug.echo', {}, who.engMember, { clientMutationId })).ok).toBe(
      true,
    );
    const { rowCount } = await h.pool.query(
      'SELECT 1 FROM api_idempotency WHERE client_mutation_id = $1',
      [clientMutationId],
    );
    expect(rowCount).toBe(0);

    const id = await seedDebugItem(h.pool);
    expect(
      await executor.execute('debug.touch', { id }, who.engMember, {
        clientMutationId: 'x'.repeat(201),
      }),
    ).toMatchObject({
      ok: false,
      error: { code: 'INVALID_INPUT', issues: [{ path: ['clientMutationId'] }] },
    });
  });
});
