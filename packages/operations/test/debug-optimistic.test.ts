// PLAN-002 S8 contract (session D): the debug operations' `optimistic()` writes rows in the shape
// of the shared `DebugItem` model, which is what the client store holds. A field the model
// doesn't declare, or a missing one, makes the overlay disagree with the server's rows.
import { DebugItem } from '@surface/domain/model';
import { describe, expect, it } from 'vitest';
import type { OptimisticStore, StoreRow } from '../src/optimistic.js';
import { debugCreate, debugDelete, debugRename, debugTouch } from '../src/ops/debug.js';

/** An in-memory store with the `OptimisticStore` contract, for one model. */
function memoryStore(): OptimisticStore & { rows: Map<string, StoreRow> } {
  const rows = new Map<string, StoreRow>();
  return {
    rows,
    now: new Date('2026-11-07T10:00:00.000Z'),
    get: (_model, id) => rows.get(id),
    patch: (_model, id, changes) => {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, ...changes });
    },
    insert: (_model, row) => void rows.set(row.id, row),
    find: () => [],
    archive: () => undefined,
    unarchive: () => undefined,
    remove: (_model, id) => void rows.delete(id),
  };
}

const ID = '0192f0c1-7e5a-7b3c-9d4e-1f2a3b4c5d6f';
// `fields` includes `id`.
const modelKeys = Object.keys(DebugItem.fields).sort();

describe('debug operations, optimistically', () => {
  it('create inserts a row with exactly the DebugItem fields', () => {
    const store = memoryStore();
    debugCreate.optimistic?.(store, debugCreate.input.parse({ id: ID, title: 'New' }));
    const row = store.rows.get(ID);
    expect(Object.keys(row ?? {}).sort()).toEqual(modelKeys);
    expect(DebugItem.rowSchema.parse(row)).toEqual({
      id: ID,
      title: 'New',
      counter: 0,
      groups: ['workspace'],
    });
  });

  it('create puts the row in the groups it was given', () => {
    const store = memoryStore();
    const input = debugCreate.input.parse({ id: ID, title: 'Secret', groups: ['team:x'] });
    debugCreate.optimistic?.(store, input);
    expect(store.rows.get(ID)?.['groups']).toEqual(['team:x']);
  });

  it('rename, touch and delete keep the row in the DebugItem shape, then remove it', () => {
    const store = memoryStore();
    debugCreate.optimistic?.(store, debugCreate.input.parse({ id: ID, title: 'New' }));
    debugRename.optimistic?.(store, debugRename.input.parse({ id: ID, title: 'Renamed' }));
    debugTouch.optimistic?.(store, debugTouch.input.parse({ id: ID }));
    expect(DebugItem.rowSchema.parse(store.rows.get(ID))).toMatchObject({
      title: 'Renamed',
      counter: 1,
    });
    expect(Object.keys(store.rows.get(ID) ?? {}).sort()).toEqual(modelKeys);
    debugDelete.optimistic?.(store, debugDelete.input.parse({ id: ID }));
    expect(store.rows.has(ID)).toBe(false);
  });
});
