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

function batches<T>(items: readonly T[], cuts: readonly number[]): T[][] {
  const points = [...new Set(cuts.map((c) => Math.min(c, items.length)))].sort((a, b) => a - b);
  const result: T[][] = [];
  let start = 0;
  for (const point of [...points, items.length]) {
    if (point > start) result.push(items.slice(start, point));
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

/*
 * SPEC-011 §5.3, §5.4, E18, E24, E25 (PLAN-011 S5b): the hydrated set is shared. Tab A hydrates
 * item 1 with an answer at some `C` at or past where it stands, between two of its batches; tab B
 * applies the same stream at its own pace and keeps item 1's content only once A's mark is there.
 * At the end, item 1's stored notes equal the server's (or none, once it was purged), and item 2,
 * never hydrated, has none.
 */
const CONTENT_REFS = [{ model: 'Note', field: 'itemId', parent: 'DebugItem' }];

const contentStep = fc.oneof(
  fc.record({
    kind: fc.constant('note' as const),
    n: fc.constantFrom(11, 12, 21),
    body: fc.constantFrom('A', 'B'),
  }),
  fc.record({ kind: fc.constant('drop' as const), n: fc.constantFrom(11, 12, 21) }),
  // A group change logs `D` then `U` of the item in one batch (sync-protocol §6).
  fc.record({ kind: fc.constant('regroup' as const) }),
  fc.record({ kind: fc.constant('purge' as const) }),
);
type ContentStep = typeof contentStep extends fc.Arbitrary<infer T> ? T : never;

interface ServerState {
  alive: boolean;
  notes: Map<number, string>;
}

/** The stream of `steps` as packet groups (a `D`+`U` pair is one group), and the server's state after each. */
function contentStream(steps: readonly ContentStep[]) {
  const state: ServerState = { alive: true, notes: new Map() };
  const groups: StoredChange[][] = [];
  const states: { version: number; alive: boolean; notes: Map<number, string> }[] = [
    { version: BOOTSTRAP_ID, alive: true, notes: new Map() },
  ];
  let version = BOOTSTRAP_ID;
  const next = () => (version += 1);
  for (const step of steps) {
    const item = (n: number) => (n === 21 ? 2 : 1);
    let group: StoredChange[];
    if (step.kind === 'note') {
      // A purged item takes no more notes; item 2's notes are never asked for.
      if (item(step.n) === 1 && !state.alive) continue;
      group = [
        {
          kind: 'upsert',
          model: 'Note',
          version: next(),
          row: { id: id(step.n), itemId: id(item(step.n)), body: step.body },
        },
      ];
      if (item(step.n) === 1) state.notes.set(step.n, step.body);
    } else if (step.kind === 'drop') {
      group = [{ kind: 'delete', model: 'Note', version: next(), id: id(step.n) }];
      state.notes.delete(step.n);
    } else if (step.kind === 'regroup') {
      if (!state.alive) continue;
      group = [
        { kind: 'delete', model: 'DebugItem', version: next(), id: id(1) },
        { kind: 'upsert', model: 'DebugItem', version: next(), row: debugRow(1) },
      ];
    } else {
      if (!state.alive) continue;
      // The purge's content deletes are not logged (ADR-0022): only the item's `D`.
      group = [{ kind: 'delete', model: 'DebugItem', version: next(), id: id(1) }];
      state.alive = false;
      state.notes.clear();
    }
    groups.push(group);
    states.push({ version, alive: state.alive, notes: new Map(state.notes) });
  }
  return { groups, states, final: state };
}

/** Batches of whole packet groups, cut at `cuts` (group indexes). */
function groupBatches(
  groups: readonly StoredChange[][],
  cuts: readonly number[],
): StoredChange[][] {
  return batches(
    groups.map((group, index) => ({ index, group })),
    cuts,
  ).map((batch) => batch.flatMap(({ group }) => group));
}

const contentScenario = fc.record({
  steps: fc.array(contentStep, { minLength: 1, maxLength: 20 }),
  cutsA: fc.array(fc.nat({ max: 20 }), { maxLength: 6 }),
  cutsB: fc.array(fc.nat({ max: 20 }), { maxLength: 6 }),
  order: fc.array(fc.boolean(), { maxLength: 30 }),
  /** After which of A's batches A hydrates item 1, and how far past A's position the answer is. */
  hydrateAfter: fc.nat({ max: 8 }),
  ahead: fc.nat({ max: 20 }),
});

describe.each(BACKENDS)('$name content storage', (backend) => {
  it('keeps a parent one tab hydrated live in every tab, and equal to the server (E18)', async () => {
    await fc.assert(
      fc.asyncProperty(contentScenario, async (scenario) => {
        const { groups, states, final } = contentStream(scenario.steps);
        const name = uniqueName();
        const models = ['DebugItem', 'Note'];
        const tabA = await backend.open(name, models, CONTENT_REFS);
        const tabB = await backend.open(name, models, CONTENT_REFS);
        const generation = await seed(tabA, [1, 2]);
        const queues = [groupBatches(groups, scenario.cutsA), groupBatches(groups, scenario.cutsB)];
        const tabs = [tabA, tabB];
        let positionA = BOOTSTRAP_ID;
        let doneA = 0;
        let hydrated = false;
        const hydrate = async () => {
          if (hydrated) return;
          hydrated = true;
          // The answer is taken at or after what A has applied: the server state at `C`.
          const reachable = states.filter((s) => s.version >= positionA);
          const at = reachable[Math.min(scenario.ahead, reachable.length - 1)];
          if (at === undefined) return;
          await tabA.writeContent(generation, {
            parents: at.alive ? [id(1)] : [],
            rows: [...at.notes].map(([n, body]) => ({
              model: 'Note',
              row: { id: id(n), itemId: id(1), body },
              archived: false,
            })),
            version: at.version,
            openedAt: 1,
          });
        };
        const apply = async (tab: number) => {
          if (tab === 0 && doneA === scenario.hydrateAfter) await hydrate();
          const batch = queues[tab]?.shift();
          const last = batch?.at(-1);
          if (!batch || !last) return;
          await tabs[tab]?.applyChanges(generation, batch, last.version);
          if (tab === 0) {
            positionA = last.version;
            doneA += 1;
          }
        };
        for (const pickA of scenario.order) await apply(pickA ? 0 : 1);
        while ((queues[0]?.length ?? 0) > 0 || (queues[1]?.length ?? 0) > 0) {
          await apply(0);
          await apply(1);
        }
        await hydrate();

        const stored = async (item: number) => {
          const read = await tabB.readContent(generation, id(item));
          return {
            hydrated: read.hydrated,
            notes: Object.fromEntries(read.records.map((r) => [r.row.id, r.row['body']])),
          };
        };
        const expected = final.alive
          ? {
              hydrated: true,
              notes: Object.fromEntries([...final.notes].map(([n, body]) => [id(n), body])),
            }
          : { hydrated: false, notes: {} };
        expect(await stored(1)).toEqual(expected);
        expect(await stored(2)).toEqual({ hydrated: false, notes: {} });
        await tabA.close();
        if (tabB !== tabA) await tabB.close();
      }),
      { seed: PROPERTY_SEED, numRuns: backend.name === 'memory' ? 300 : 60 },
    );
  }, 60_000);
});
