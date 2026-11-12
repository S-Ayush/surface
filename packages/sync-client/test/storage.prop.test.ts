/**
 * Two tabs share one replica (SPEC-002 E5). Each applies the same delta stream
 * in order, in its own batches, at its own pace. Whatever the interleaving, the
 * stored rows and `lastSyncId` must equal one tab applying the stream once.
 */
import fc from 'fast-check';
import { afterAll, describe, expect, it } from 'vitest';
import type { StoredChange, SyncStorage } from '../src/storage/types.js';
import { PROPERTY_SEED } from './support/fc.js';
import { debugRow, id } from './support/models.js';
import { BACKENDS, closePorts, uniqueName } from './support/storage.js';

const BOOTSTRAP_ID = 10;
const START = {
  schemaHash: 'c'.repeat(64),
  lastSyncId: BOOTSTRAP_ID,
  groups: ['workspace' as const],
};

const step = fc.record({
  kind: fc.constantFrom('upsert', 'archive', 'unarchive', 'delete'),
  n: fc.integer({ min: 1, max: 3 }),
  title: fc.constantFrom('A', 'B'),
});

/** A delta stream with consecutive versions after the bootstrap, cut into batches. */
const scenario = fc
  .record({
    initial: fc.subarray([1, 2, 3]),
    steps: fc.array(step, { minLength: 1, maxLength: 25 }),
    cutsA: fc.array(fc.nat({ max: 25 }), { maxLength: 6 }),
    cutsB: fc.array(fc.nat({ max: 25 }), { maxLength: 6 }),
    order: fc.array(fc.boolean(), { maxLength: 30 }),
  })
  .map(({ initial, steps, ...rest }) => ({
    ...rest,
    initial,
    changes: steps.map(({ kind, n, title }, i): StoredChange => {
      const version = BOOTSTRAP_ID + i + 1;
      // Archive and unarchive carry the row too (v0.7).
      return kind === 'delete'
        ? { kind, model: 'DebugItem', version, id: id(n) }
        : { kind, model: 'DebugItem', version, row: debugRow(n, { title }) };
    }),
  }));

function batches(changes: readonly StoredChange[], cuts: readonly number[]): StoredChange[][] {
  const points = [...new Set(cuts.map((c) => Math.min(c, changes.length)))].sort((a, b) => a - b);
  const result: StoredChange[][] = [];
  let start = 0;
  for (const point of [...points, changes.length]) {
    if (point > start) result.push(changes.slice(start, point));
    start = point;
  }
  return result;
}

async function snapshot(storage: SyncStorage) {
  const page = await storage.readRows('DebugItem', undefined, 100);
  return { rows: page.rows, lastSyncId: (await storage.readMeta())?.lastSyncId };
}

async function seed(storage: SyncStorage, initial: readonly number[]): Promise<string> {
  const generation = await storage.beginBootstrap(START);
  await storage.writeBootstrapRows(
    generation,
    initial.map((n) => ({ model: 'DebugItem', row: debugRow(n), archived: false })),
  );
  await storage.finishBootstrap(generation);
  return generation;
}

afterAll(closePorts);

describe.each(BACKENDS)('$name storage', (backend) => {
  it('converges for any interleaving of two tabs', async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async ({ initial, changes, cutsA, cutsB, order }) => {
        const reference = await backend.open(uniqueName(), ['DebugItem']);
        const referenceGeneration = await seed(reference, initial);
        for (const change of changes) {
          await reference.applyChanges(referenceGeneration, [change], change.version);
        }
        const expected = await snapshot(reference);
        await reference.close();

        const name = uniqueName();
        const tabA = await backend.open(name, ['DebugItem']);
        const tabB = await backend.open(name, ['DebugItem']);
        const generation = await seed(tabA, initial);
        const queues = [batches(changes, cutsA), batches(changes, cutsB)];
        const tabs = [tabA, tabB];
        const apply = async (tab: number) => {
          const batch = queues[tab]?.shift();
          const last = batch?.at(-1);
          if (batch && last) await tabs[tab]?.applyChanges(generation, batch, last.version);
        };
        for (const pickA of order) await apply(pickA ? 0 : 1);
        while ((queues[0]?.length ?? 0) > 0 || (queues[1]?.length ?? 0) > 0) {
          await apply(0);
          await apply(1);
        }
        expect(await snapshot(tabA)).toEqual(expected);
        await tabA.close();
        await tabB.close();
      }),
      { seed: PROPERTY_SEED, numRuns: backend.name === 'memory' ? 300 : 60 },
    );
  }, 60_000);
});
