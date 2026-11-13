/**
 * PLAN-015 S1, SPEC-015 §7: `issue.delete` and `issue.restore` read the issue's lifecycle from a
 * real `SyncStore` (its `pool`), not the stand-in of the operations' unit test, so a change to the
 * store's surface that hides the rows from `ui.available` fails here. Delete is hidden on a
 * deleted issue; Restore shows on an archived one and on a deleted one before `purgeAfter` only.
 */
import { Issue, PRODUCTION_MODELS } from '@surface/domain/model';
import { issueDelete, issueRestore } from '@surface/operations';
import { computeSchemaHash } from '@surface/sync-protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SyncStore } from '../src/store.js';
import { quietConnection } from './support/hub.js';
import { memoryStorage } from './support/live.js';
import { bootstrapFrames, fakeFetch, ndjsonResponse } from './support/server.js';
import { uniqueName } from './support/storage.js';

const NOW = new Date('2026-11-13T10:00:00.000Z');
const HOUR = 3_600_000;
const ENG = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
const ADA = '0192f0c1-7e5a-7b3c-9d4e-0000000000ad';
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

/** One issue per lifecycle case, keyed by name; ids end in its index. */
const CASES = {
  live: { archivedAt: null, deletedAt: null },
  archived: { archivedAt: ago(1000 * HOUR), deletedAt: null },
  deletedRecently: { archivedAt: null, deletedAt: ago(HOUR) },
  deletedJustBeforePurge: { archivedAt: null, deletedAt: ago(720 * HOUR - 1) },
  deletedAtPurge: { archivedAt: null, deletedAt: ago(720 * HOUR) },
} as const;
type Case = keyof typeof CASES;
const idOf = (name: Case) =>
  `0192f0c1-7e5a-7b3c-9d4e-${String(Object.keys(CASES).indexOf(name)).padStart(12, '0')}`;

function issueRow(name: Case, n: number) {
  return {
    id: idOf(name),
    teamId: ENG,
    number: n,
    title: name,
    statusId: ENG,
    priority: 0,
    assigneeId: null,
    labelIds: [],
    estimate: null,
    dueDate: null,
    sortOrder: `a${n}`,
    creatorId: ADA,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    deletedById: null,
    groups: [`team:${ENG}`],
    createdAt: ago(2000 * HOUR),
    updatedAt: ago(2000 * HOUR),
    ...CASES[name],
  };
}

let store: SyncStore | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  vi.useRealTimers();
  await store?.close();
  store = undefined;
});

async function startedStore(): Promise<SyncStore> {
  const names = Object.keys(CASES).filter((name): name is Case => name in CASES);
  const rows = names.map((name, i) => ({
    model: 'Issue',
    row: issueRow(name, i + 1),
    // The bootstrap sends an archived row with the flag, like the server (SPEC-002 §3.2).
    archived: CASES[name].archivedAt !== null,
  }));
  const frames = bootstrapFrames(rows, { schemaHash: computeSchemaHash(PRODUCTION_MODELS) });
  store = new SyncStore({
    models: PRODUCTION_MODELS,
    workspaceId: uniqueName('lifecycle'),
    userId: ADA,
    fetch: fakeFetch(() => ndjsonResponse(frames)),
    connectStorage: memoryStorage,
    connection: quietConnection(),
    // With partial loading the replica never holds an archived or deleted issue (SPEC-011 AC-29,
    // PLAN-011 S4c), and no team here is followed. This test is about how the ops read the
    // store's pool, so it turns partial loading off to feed those rows in.
    partial: null,
  });
  await store.start();
  expect(store.pool.count(Issue)).toBe(names.length);
  return store;
}

function available(op: typeof issueDelete | typeof issueRestore, s: SyncStore, name: Case) {
  return op.ui?.available?.({ kind: 'issue', ids: [idOf(name)] }, s);
}

it('offers Delete on a live or archived issue the store holds, and not on a deleted one', async () => {
  const s = await startedStore();
  expect(available(issueDelete, s, 'live')).toBe(true);
  expect(available(issueDelete, s, 'archived')).toBe(true);
  expect(available(issueDelete, s, 'deletedRecently')).toBe(false);
  expect(available(issueDelete, s, 'deletedAtPurge')).toBe(false);
});

it('offers Restore on an archived issue and a deleted one before purgeAfter, never on a live one', async () => {
  const s = await startedStore();
  expect(available(issueRestore, s, 'live')).toBe(false);
  expect(available(issueRestore, s, 'archived')).toBe(true);
  expect(available(issueRestore, s, 'deletedRecently')).toBe(true);
  // Restorable until 1 ms before `deletedAt + 720 h`, not at it (AC-3, D6).
  expect(available(issueRestore, s, 'deletedJustBeforePurge')).toBe(true);
  expect(available(issueRestore, s, 'deletedAtPurge')).toBe(false);
});
