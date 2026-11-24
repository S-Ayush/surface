/**
 * Warm start of 10k rows (part of SPEC-002 AC-8: interactive in < 1.5 s). A wall-clock budget, so
 * it runs in `pnpm test:deep` (plans README §6); `warm-start.test.ts` checks the rows in the gate.
 *
 * This runs in Node against fake-indexeddb behind the worker RPC, so it guards
 * against regressions in the pool and storage code paths; it is not the real
 * browser measurement. That one is in the nightly perf suite (PLAN-002 S10).
 */
import { afterAll, expect, it } from 'vitest';
import { closePorts } from './support/storage.js';
import { warmStart } from './support/warm-start.js';

const ROWS = 10_000;
const BUDGET_MS = 1500;

afterAll(closePorts);

it(`warm-starts ${ROWS} rows in under ${BUDGET_MS} ms`, { timeout: 60_000 }, async () => {
  const { coldMode, mode, rows, elapsed } = await warmStart(ROWS);
  expect(coldMode).toBe('cold');
  expect(mode).toBe('warm');
  expect(rows).toBe(ROWS);
  expect(elapsed, `warm start took ${elapsed.toFixed(0)} ms`).toBeLessThan(BUDGET_MS);
});
