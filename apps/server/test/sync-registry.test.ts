// PLAN-002 S3: the sync registry is built from the shared model definitions the client uses
// (`@surface/domain/model`), so both sides compute the same schema hash, and a server row is
// projected to exactly the client row (sync-protocol §4.1, SPEC-002 Q6).
import { array, DebugItem, defineModel, int, str, timestamp } from '@surface/domain/model';
import { computeSchemaHash, decodeBootstrapFrame } from '@surface/sync-protocol';
import { describe, expect, it } from 'vitest';
import { debugItems } from '../src/db/schema/index.js';
import { clientRow, syncModel, syncRegistry } from '../src/sync/registry.js';

describe('the sync registry', () => {
  it('outside production, syncs the DebugItem fixture with the hash the client computes', () => {
    const registry = syncRegistry({ includeFixtures: true });
    expect(registry.eager.map((m) => m.name)).toEqual(['DebugItem']);
    // The client store hashes its model list the same way (sync-client `store.ts`).
    expect(registry.schemaHash).toBe(computeSchemaHash([DebugItem]));
  });

  it('in production, leaves the fixture out of the models and the hash', () => {
    const registry = syncRegistry({ includeFixtures: false });
    expect(registry.models).toEqual([]);
    expect(registry.schemaHash).toBe(computeSchemaHash([]));
    expect(registry.schemaHash).not.toBe(syncRegistry({ includeFixtures: true }).schemaHash);
  });

  it('maps each declared field to its column, with groups taken from sync_groups', () => {
    const [model] = syncRegistry({ includeFixtures: true }).models;
    expect(model?.table).toBe('debug_items');
    expect(Object.fromEntries(model?.columns ?? [])).toEqual({
      id: 'id',
      title: 'title',
      counter: 'counter',
    });
    expect(model?.archivable).toBe(true);
  });

  it('refuses a definition that declares a field the table lacks, naming both', () => {
    const extra = defineModel('DebugItem', {
      load: 'eager',
      fields: { title: str(), counter: int(), groups: array(str()), colour: str() },
    });
    expect(() => syncModel('DebugItem', extra, debugItems)).toThrow(
      'DebugItem.colour is declared in @surface/domain/model but debug_items has no such column.',
    );
  });
});

describe('a client row', () => {
  const [model] = syncRegistry({ includeFixtures: true }).models;
  if (!model) throw new Error('DebugItem is not in the registry');
  const row = {
    id: '0192f0c1-7e5a-7b3c-9d4e-1f2a3b4c5d6f',
    title: 'Shared',
    counter: 3,
    syncGroups: ['workspace', 'team:0192f0c1-0000-7000-8000-00000000000a'],
    createdAt: new Date('2026-11-07T10:00:00.123Z'),
    archived: false,
  };

  it('holds exactly the declared fields, valid for the client model and the wire', () => {
    const d = clientRow(model, row, new Set(['workspace']));
    expect(d).toEqual({
      id: row.id,
      title: 'Shared',
      counter: 3,
      groups: ['workspace'],
    });
    expect(DebugItem.rowSchema.parse(d)).toEqual(d);
    expect(decodeBootstrapFrame({ t: 'row', m: 'DebugItem', d })).toMatchObject({ d });
  });

  it("carries only the groups the receiving connection is in (a private team's id stays hidden)", () => {
    expect(clientRow(model, row, new Set(['workspace']))['groups']).toEqual(['workspace']);
    expect(clientRow(model, row, new Set(row.syncGroups))['groups']).toEqual(row.syncGroups);
  });

  it('sends instants as ISO strings with milliseconds', () => {
    const withCreatedAt = defineModel('DebugItem', {
      load: 'eager',
      fields: { title: str(), counter: int(), groups: array(str()), createdAt: timestamp() },
    });
    const timed = syncModel('DebugItem', withCreatedAt, debugItems);
    expect(clientRow(timed, row, new Set())['createdAt']).toBe('2026-11-07T10:00:00.123Z');
  });
});
