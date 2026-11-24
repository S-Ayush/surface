/**
 * Warm start of a replica of 10k rows (part of SPEC-002 AC-8): every row comes back from storage.
 * How long it takes is `warm-start.perf.test.ts` (`pnpm test:deep`, plans README §6).
 */
import { afterAll, expect, it } from 'vitest';
import { closePorts } from './support/storage.js';
import { warmStart } from './support/warm-start.js';

const ROWS = 10_000;

afterAll(closePorts);

it(`warm-starts ${ROWS} rows from the saved replica`, { timeout: 60_000 }, async () => {
  const { coldMode, mode, rows } = await warmStart(ROWS);
  expect(coldMode).toBe('cold');
  expect(mode).toBe('warm');
  expect(rows).toBe(ROWS);
});
