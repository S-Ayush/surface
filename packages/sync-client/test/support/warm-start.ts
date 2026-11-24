/**
 * A replica of `rows` debug rows saved by a cold start, then started warm: for
 * `warm-start.test.ts` (it loads every row, in the gate) and `warm-start.perf.test.ts` (within
 * SPEC-002 AC-8's 1.5 s, in `pnpm test:deep`).
 */
import { SyncStore } from '../../src/store.js';
import { DebugItem, TEST_MODELS, debugRow } from './models.js';
import { quietConnection } from './hub.js';
import { bootstrapFrames, fakeFetch, ndjsonResponse } from './server.js';
import { connectViaRpc, uniqueName } from './storage.js';

export interface WarmStart {
  /** What the cold store's `start()` answered. */
  readonly coldMode: string;
  /** What the warm store's `start()` answered. */
  readonly mode: string;
  /** Rows in the warm store's pool. */
  readonly rows: number;
  /** How long the warm `start()` took, in ms. */
  readonly elapsed: number;
}

export async function warmStart(rows: number): Promise<WarmStart> {
  const options = {
    models: TEST_MODELS,
    workspaceId: uniqueName('perf'),
    userId: 'user-1',
    connectStorage: connectViaRpc,
    connection: quietConnection(),
  };
  const frames = Array.from({ length: rows }, (_, i) => ({
    model: 'DebugItem',
    row: debugRow(i + 1),
  }));
  const cold = new SyncStore({
    ...options,
    fetch: fakeFetch(() => ndjsonResponse(bootstrapFrames(frames), 64 * 1024)),
  });
  const coldMode = await cold.start();
  await cold.close();

  const warm = new SyncStore({ ...options, fetch: fakeFetch() });
  try {
    const started = performance.now();
    const mode = await warm.start();
    const elapsed = performance.now() - started;
    return { coldMode, mode, rows: warm.pool.count(DebugItem), elapsed };
  } finally {
    await warm.close();
  }
}
