import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { IndexedDbStorage } from '../src/storage/indexeddb.js';
import { StorageClosedError } from '../src/storage/types.js';
import { debugRow, id } from './support/models.js';
import { uniqueName } from './support/storage.js';

const HASH = 'b'.repeat(64);

describe('IndexedDB replica', () => {
  it('creates meta, the queue stores and one row store per model', async () => {
    const name = uniqueName();
    const storage = await IndexedDbStorage.open(name, ['DebugItem', 'Card']);
    await storage.close();
    const db = await openDB(name);
    expect([...db.objectStoreNames].sort()).toEqual([
      'clients',
      'meta',
      'pending',
      'row:Card',
      'row:DebugItem',
      'subscriptions',
    ]);
    db.close();
  });

  it('rebuilds row stores when the model list changes, keeping pending mutations', async () => {
    const name = uniqueName();
    const before = await IndexedDbStorage.open(name, ['DebugItem', 'Card']);
    const generation = await before.beginBootstrap({ schemaHash: HASH, lastSyncId: 5, groups: [] });
    await before.writeBootstrapRows(generation, [
      { model: 'DebugItem', row: debugRow(1), archived: false },
    ]);
    await before.touchOnDemand('team-1', 5);
    await before.close();
    const raw = await openDB(name);
    await raw.put('pending', { key: 'client-1:1', op: 'debug.touch' });
    raw.close();

    const after = await IndexedDbStorage.open(name, ['DebugItem', 'Board']);
    expect(await after.readMeta()).toBeUndefined();
    await after.close();
    const db = await openDB(name);
    expect([...db.objectStoreNames].sort()).toEqual([
      'clients',
      'meta',
      'pending',
      'row:Board',
      'row:DebugItem',
      'subscriptions',
    ]);
    expect(await db.getAll('pending')).toEqual([{ key: 'client-1:1', op: 'debug.touch' }]);
    // The on-demand teams survive like the queue (SPEC-011 §5.7: per replica).
    expect(await db.get('subscriptions', 'onDemand')).toEqual(['team-1']);
    db.close();
  });

  it('ignores a meta record it does not recognise, so the client bootstraps again', async () => {
    const name = uniqueName();
    const storage = await IndexedDbStorage.open(name, ['DebugItem']);
    await storage.close();
    const raw = await openDB(name);
    await raw.put('meta', { version: 'from an older app' }, 'meta');
    raw.close();
    const reopened = await IndexedDbStorage.open(name, ['DebugItem']);
    expect(await reopened.readMeta()).toBeUndefined();
    await reopened.close();
  });

  it('steps aside when another tab upgrades the database, and says to reload', async () => {
    const name = uniqueName();
    const oldTab = await IndexedDbStorage.open(name, ['DebugItem']);
    // A newer app version in another tab needs different stores.
    const newTab = await IndexedDbStorage.open(name, ['DebugItem', 'Card']);
    await expect(oldTab.readMeta()).rejects.toBeInstanceOf(StorageClosedError);
    await expect(oldTab.readMeta()).rejects.toThrow(/updated in another tab\. Reload this tab/);
    expect(await newTab.readMeta()).toBeUndefined();
    await newTab.close();
  });

  it('pages past a stored record it cannot read instead of stopping early', async () => {
    const name = uniqueName();
    const storage = await IndexedDbStorage.open(name, ['DebugItem']);
    const generation = await storage.beginBootstrap({
      schemaHash: HASH,
      lastSyncId: 1,
      groups: ['workspace'],
    });
    await storage.writeBootstrapRows(
      generation,
      [1, 2, 3].map((n) => ({ model: 'DebugItem', row: debugRow(n), archived: false })),
    );
    await storage.finishBootstrap(generation);
    const raw = await openDB(name);
    await raw.put('row:DebugItem', { id: `${id(1)}-garbled` });
    raw.close();

    const ids: string[] = [];
    let after: string | undefined;
    do {
      const page = await storage.readRows('DebugItem', after, 2);
      ids.push(...page.rows.map(({ row }) => row.id));
      after = page.next;
    } while (after !== undefined);
    expect(ids).toEqual([id(1), id(2), id(3)]);
    await storage.close();
  });
});
