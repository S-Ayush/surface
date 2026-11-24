// AC-1 (SPEC-002 §9): 20 concurrent writers × 500 mutations produce sync ids that are gap-free
// and in commit order, verified by replaying `sync_log`. "Commit order" is checked the way the
// hub depends on it: no snapshot ever sees a sync id before every lower one is visible.
// `pnpm test:int` runs 50 mutations a writer; `pnpm test:deep` the full 500 (plans README §6).
import { randomUUID } from 'node:crypto';
import { isDeepRun } from '@surface/config/properties';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  FIXTURE_SCHEMA,
  actors,
  executorHarness,
  testExecutor,
  type ExecutorHarness,
} from './executor.js';

const WORKERS = 20;
const MUTATIONS = isDeepRun() ? 500 : 50;
const SHARED_ITEMS = 8;
const SEED = 20261106;

let h: ExecutorHarness;
let pool: pg.Pool;
beforeAll(async () => {
  h = await executorHarness();
  pool = new pg.Pool({
    connectionString: h.db.url,
    max: WORKERS + 2,
    options: `-c search_path=${FIXTURE_SCHEMA},public`,
  });
});
afterAll(async () => {
  await pool.end();
  await h.close();
});

/** A small deterministic PRNG (mulberry32), so a failing run can be replayed from `SEED`. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface LogRow {
  sync_id: string;
  model_id: string;
  action: string;
  data: { title: string; counter: number } | null;
}

it(
  `gives ${WORKERS} × ${MUTATIONS} concurrent mutations gap-free, commit-ordered sync ids`,
  { timeout: 180_000 },
  async () => {
    const { executor } = testExecutor(pool);
    const actor = actors(h.teams).engMember;
    const shared: string[] = Array.from({ length: SHARED_ITEMS }, () => randomUUID());
    for (const id of shared) {
      const created = await executor.execute('debug.create', { id, title: 'shared' }, actor);
      expect(created.ok).toBe(true);
    }
    const { rows: base } = await pool.query<{ last: string }>(
      'SELECT last_sync_id AS last FROM sync_state',
    );
    const start = Number(base[0]?.last);

    // Observer: in every snapshot, the visible ids above `start` are exactly start+1 … max.
    let writing = true;
    let snapshots = 0;
    const holes: string[] = [];
    const observer = (async () => {
      while (writing) {
        const { rows } = await pool.query<{ n: string; max: string }>(
          'SELECT count(*) AS n, coalesce(max(sync_id), $1) AS max FROM sync_log WHERE sync_id > $1',
          [start],
        );
        const n = Number(rows[0]?.n);
        const max = Number(rows[0]?.max);
        if (n !== max - start) holes.push(`saw ${n} rows up to ${max}`);
        snapshots++;
      }
    })();

    const returned: number[] = [];
    const failures: string[] = [];
    await Promise.all(
      Array.from({ length: WORKERS }, async (_, worker) => {
        const random = prng(SEED + worker);
        const pick = () => shared[Math.floor(random() * SHARED_ITEMS)] ?? '';
        for (let i = 0; i < MUTATIONS; i++) {
          const roll = random();
          const [op, input] =
            roll < 0.5
              ? ['debug.touch', { id: pick() }]
              : roll < 0.75
                ? ['debug.rename', { id: pick(), title: `w${worker}-${i}` }]
                : ['debug.create', { id: randomUUID(), title: `new w${worker}-${i}` }];
          const result = await executor.execute(op, input, actor);
          if (result.ok && result.lastSyncId !== undefined) returned.push(result.lastSyncId);
          else failures.push(`${op}: ${result.ok ? 'no lastSyncId' : result.error.code}`);
        }
      }),
    );
    writing = false;
    await observer;

    expect(failures).toEqual([]);
    expect(holes).toEqual([]);
    expect(snapshots).toBeGreaterThan(10);

    // Gap-free: one row per mutation, numbered start+1 … end, and sync_state agrees.
    const total = WORKERS * MUTATIONS;
    const { rows: log } = await pool.query<LogRow>(
      'SELECT sync_id, model_id, action, data FROM sync_log WHERE sync_id > $1 ORDER BY sync_id',
      [start],
    );
    expect(log.map((r) => Number(r.sync_id))).toEqual(
      Array.from({ length: total }, (_, i) => start + 1 + i),
    );
    const { rows: state } = await pool.query<{ last: string }>(
      'SELECT last_sync_id AS last FROM sync_state',
    );
    expect(Number(state[0]?.last)).toBe(start + total);
    // Each mutation was told the id of the change it made.
    expect([...returned].sort((a, b) => a - b)).toEqual(log.map((r) => Number(r.sync_id)));

    // Commit order: replaying the log in id order reproduces the table, so no later write to a
    // row was logged before an earlier one.
    const replayed = new Map<string, { title: string; counter: number }>();
    for (const row of log) {
      if (row.action === 'D') replayed.delete(row.model_id);
      else if (row.data)
        replayed.set(row.model_id, { title: row.data.title, counter: row.data.counter });
    }
    const { rows: items } = await pool.query<{ id: string; title: string; counter: number }>(
      'SELECT id, title, counter FROM debug_items WHERE id = ANY($1)',
      [[...replayed.keys()]],
    );
    expect(new Map(items.map((r) => [r.id, { title: r.title, counter: r.counter }]))).toEqual(
      replayed,
    );
    const touches = log.filter((r) => r.data && shared.includes(r.model_id)).length;
    expect(touches).toBeGreaterThan(total / 2);
  },
);
