/**
 * Warm start of 10k rows (part of SPEC-002 AC-8: interactive in < 1.5 s).
 *
 * This runs in Node against fake-indexeddb behind the worker RPC, so it guards
 * against regressions in the pool and storage code paths; it is not the real
 * browser measurement. That one is in the nightly perf suite (PLAN-002 S10).
 */
import { afterAll, expect, it } from 'vitest';
import { SyncStore } from '../src/store.js';
import { DebugItem, TEST_MODELS, debugRow } from './support/models.js';
import { quietConnection } from './support/hub.js';
import { bootstrapFrames, fakeFetch, ndjsonResponse } from './support/server.js';
import { closePorts, connectViaRpc, uniqueName } from './support/storage.js';

const ROWS = 10_000;
const BUDGET_MS = 1500;

afterAll(closePorts);

it(`warm-starts ${ROWS} rows in under ${BUDGET_MS} ms`, { timeout: 60_000 }, async () => {
  const workspaceId = uniqueName('perf');
  const rows = Array.from({ length: ROWS }, (_, i) => ({
    model: 'DebugItem',
    row: debugRow(i + 1),
  }));
  const options = {
    models: TEST_MODELS,
    workspaceId,
    userId: 'user-1',
    connectStorage: connectViaRpc,
    connection: quietConnection(),
  };

  const cold = new SyncStore({
    ...options,
    fetch: fakeFetch(() => ndjsonResponse(bootstrapFrames(rows), 64 * 1024)),
  });
  expect(await cold.start()).toBe('cold');
  await cold.close();

  const warm = new SyncStore({ ...options, fetch: fakeFetch() });
  const started = performance.now();
  expect(await warm.start()).toBe('warm');
  const elapsed = performance.now() - started;
  expect(warm.pool.count(DebugItem)).toBe(ROWS);
  expect(elapsed, `warm start took ${elapsed.toFixed(0)} ms`).toBeLessThan(BUDGET_MS);
  await warm.close();
});
