// PLAN-002 S5 review (M2): the exactly-once ledger behind `POST /sync/mutate` against Postgres
// (SPEC-002 §4.4, Q11). Part of the sync property suite (SPEC-002 AC-3), which the testing hold
// exempts (plans README §6): the unit tests in `sync-mutate.test.ts` run over a stand-in that
// can't see the SQL, so the row lock, first-use registration, replay lookup, the 100-result trim
// and the visible head are checked here.
import { randomUUID } from 'node:crypto';
import type { MutationResult } from '@surface/sync-protocol';
import { drizzle } from 'drizzle-orm/node-postgres';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  claimSeq,
  KEPT_RESULTS,
  recordResult,
  visibleHead,
  type SeqClaim,
} from '../src/sync/client-mutations.js';
import { syncRepo } from '../src/sync/repo.js';
import { createTestDatabase, type TestDatabase } from './db.js';

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
});
afterAll(async () => {
  await db.drop();
});

/** A transaction held open on its own connection, so two can interleave. */
async function begin() {
  const client = await db.pool.connect();
  await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  let open = true;
  const end = async (how: 'COMMIT' | 'ROLLBACK') => {
    if (!open) return;
    open = false;
    try {
      await client.query(how);
    } finally {
      client.release();
    }
  };
  return { client, commit: () => end('COMMIT'), rollback: () => end('ROLLBACK') };
}

/** One mutation's ledger work, as the executor does it: claim, and record when it runs. */
async function runSeq(
  origin: { clientId: string; userId: string; seq: number },
  outcome: (seq: number) => MutationResult,
): Promise<SeqClaim> {
  const tx = await begin();
  try {
    const claimed = await claimSeq(tx.client, origin);
    if (claimed.kind === 'next')
      await recordResult(tx.client, origin.clientId, outcome(origin.seq));
    await tx.commit();
    return claimed;
  } finally {
    await tx.rollback();
  }
}

const ok = (seq: number): MutationResult => ({ seq, status: 'ok', lastSyncId: seq * 7 });
const rejected = (seq: number): MutationResult => ({
  seq,
  status: 'error',
  error: { code: 'NOT_FOUND', message: `Item ${seq} was not found.` },
});

async function ledger(clientId: string) {
  const { rows } = await db.pool.query<{ user_id: string; last_seq: string; seqs: number[] }>(
    `SELECT user_id::text AS user_id, last_seq::text AS last_seq,
       ARRAY(SELECT (e->>'seq')::int FROM jsonb_array_elements(last_results) e) AS seqs
     FROM client_mutations WHERE client_id = $1`,
    [clientId],
  );
  return rows[0];
}

describe('client_mutations (exactly-once ledger)', () => {
  it('places every seq like a model of the protocol, keeping the last 100 results', async () => {
    // A step: the next seq, an earlier one resent, or one past a gap.
    const step = fc.oneof(
      { arbitrary: fc.constant({ kind: 'next' as const }), weight: 6 },
      { arbitrary: fc.nat().map((n) => ({ kind: 'resend' as const, back: n })), weight: 2 },
      {
        arbitrary: fc
          .integer({ min: 2, max: 5 })
          .map((ahead) => ({ kind: 'skip' as const, ahead })),
        weight: 1,
      },
    );
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(step, fc.boolean()), { minLength: 1, maxLength: 260 }),
        async (steps) => {
          const clientId = randomUUID();
          const userId = randomUUID();
          let last = 0;
          const stored = new Map<number, MutationResult>();
          for (const [s, fails] of steps) {
            const seq =
              s.kind === 'next'
                ? last + 1
                : s.kind === 'skip'
                  ? last + s.ahead
                  : 1 + (s.back % Math.max(last, 1));
            const outcome = fails ? rejected : ok;
            const claimed = await runSeq({ clientId, userId, seq }, outcome);
            if (seq === last + 1) {
              expect(claimed).toEqual({ kind: 'next' });
              stored.set(seq, outcome(seq));
              last = seq;
            } else if (seq > last + 1) {
              expect(claimed).toEqual({ kind: 'gap', lastSeq: last });
            } else if (seq > last - KEPT_RESULTS) {
              expect(claimed).toEqual({ kind: 'replay', result: stored.get(seq) });
            } else {
              expect(claimed).toMatchObject({
                kind: 'replay',
                result: { seq, status: 'error', error: { code: 'CONFLICT' } },
              });
            }
          }
          const row = await ledger(clientId);
          if (last === 0) {
            // A first use that only skipped ahead still registered the client, at seq 0.
            expect(row === undefined || row.last_seq === '0').toBe(true);
            return;
          }
          const kept = Array.from(
            { length: Math.min(last, KEPT_RESULTS) },
            (_, i) => last - Math.min(last, KEPT_RESULTS) + 1 + i,
          );
          expect(row).toEqual({ user_id: userId, last_seq: String(last), seqs: kept });
        },
      ),
      { seed: 20261107, numRuns: 25 },
    );
  }, 120_000);

  it('keeps exactly the last 100 results past the window, and answers older seqs as forgotten', async () => {
    const clientId = randomUUID();
    const userId = randomUUID();
    for (let seq = 1; seq <= 250; seq++) await runSeq({ clientId, userId, seq }, ok);
    const row = await ledger(clientId);
    expect(row?.last_seq).toBe('250');
    expect(row?.seqs).toEqual(Array.from({ length: KEPT_RESULTS }, (_, i) => 151 + i));
    expect(await runSeq({ clientId, userId, seq: 151 }, ok)).toEqual({
      kind: 'replay',
      result: ok(151),
    });
    expect(await runSeq({ clientId, userId, seq: 150 }, ok)).toMatchObject({
      kind: 'replay',
      result: { seq: 150, status: 'error', error: { code: 'CONFLICT' } },
    });
  });

  it('makes a resend of a seq in flight wait for it, then replay what it recorded', async () => {
    const clientId = randomUUID();
    const userId = randomUUID();
    const first = await begin();
    expect(await claimSeq(first.client, { clientId, userId, seq: 1 })).toEqual({ kind: 'next' });
    await first.commit(); // registered
    const a = await begin();
    expect(await claimSeq(a.client, { clientId, userId, seq: 1 })).toEqual({ kind: 'next' });
    const b = await begin();
    // Blocks on the row `a` locked: without the lock it would also see seq 1 as next.
    const waiting = claimSeq(b.client, { clientId, userId, seq: 1 });
    await recordResult(a.client, clientId, ok(1));
    await a.commit();
    expect(await waiting).toEqual({ kind: 'replay', result: ok(1) });
    await b.rollback();
  });

  it('lets the resend run the seq itself when the one in flight rolls back', async () => {
    const clientId = randomUUID();
    const userId = randomUUID();
    await runSeq({ clientId, userId, seq: 1 }, ok);
    const a = await begin();
    expect(await claimSeq(a.client, { clientId, userId, seq: 2 })).toEqual({ kind: 'next' });
    const b = await begin();
    const waiting = claimSeq(b.client, { clientId, userId, seq: 2 });
    await recordResult(a.client, clientId, ok(2));
    await a.rollback();
    expect(await waiting).toEqual({ kind: 'next' });
    await b.rollback();
  });

  it('registers a new client to whichever user commits first; the other is refused', async () => {
    const clientId = randomUUID();
    const ada = randomUUID();
    const bob = randomUUID();
    const a = await begin();
    expect(await claimSeq(a.client, { clientId, userId: ada, seq: 1 })).toEqual({ kind: 'next' });
    const b = await begin();
    // Bob's insert waits on Ada's uncommitted one, then finds her row.
    const waiting = claimSeq(b.client, { clientId, userId: bob, seq: 1 });
    await recordResult(a.client, clientId, ok(1));
    await a.commit();
    expect(await waiting).toEqual({ kind: 'foreign' });
    await b.rollback();
    expect(await ledger(clientId)).toMatchObject({ user_id: ada, last_seq: '1' });
  });

  it('finds the newest log row a connection receives: in its groups, of a model it syncs', async () => {
    const me = randomUUID();
    const team = randomUUID();
    const write = async (groups: string[]) => {
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        const repo = syncRepo(drizzle({ client, casing: 'snake_case' }), new Date());
        await repo.insert('DebugItem', { id: randomUUID(), title: 'x', syncGroups: groups });
        const { lastSyncId } = await repo.flush({});
        await client.query('COMMIT');
        return lastSyncId ?? expect.fail('nothing logged');
      } finally {
        client.release();
      }
    };
    const shared = await write(['workspace']);
    const mine = await write([`user:${me}`]);
    const private_ = await write([`team:${team}`]);
    await write([`user:${randomUUID()}`]); // someone else's, newest

    expect(
      await visibleHead(db.pool, { groups: ['workspace', `user:${me}`], models: ['DebugItem'] }),
    ).toBe(mine);
    expect(await visibleHead(db.pool, { groups: ['workspace'], models: ['DebugItem'] })).toBe(
      shared,
    );
    expect(
      await visibleHead(db.pool, { groups: ['workspace', `team:${team}`], models: ['DebugItem'] }),
    ).toBe(private_);
    // A model the connection doesn't sync is not received.
    expect(
      await visibleHead(db.pool, { groups: ['workspace', `user:${me}`], models: ['Team'] }),
    ).toBeLessThan(shared);
    expect(await visibleHead(db.pool, { groups: ['nobody'], models: ['DebugItem'] })).toBe(0);
  });
});
