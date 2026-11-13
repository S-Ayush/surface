// PLAN-002 S3: the sync registry is built from the shared model definitions the client uses
// (`@surface/domain/model`), so both sides compute the same schema hash, and a server row is
// projected to exactly the client row (sync-protocol §4.1, SPEC-002 Q6).
import {
  array,
  DebugItem,
  defineModel,
  int,
  PRODUCTION_MODELS,
  str,
  timestamp,
  uuid,
} from '@surface/domain/model';
import { computeSchemaHash, decodeBootstrapFrame } from '@surface/sync-protocol';
import { describe, expect, it } from 'vitest';
import { debugItems } from '../src/db/schema/index.js';
import { selectRows } from '../src/sync/bootstrap.js';
import { groupsOfIssueChild, SYNCED_MODELS } from '../src/sync/models.js';
import {
  clientRow,
  contentParentProblem,
  issueChildProblem,
  serverSyncRegistry,
  syncModel,
  syncRegistry,
} from '../src/sync/registry.js';

describe('the sync registry', () => {
  it('with fixtures, syncs DebugItem too, with the hash the sync-engine tests compute', () => {
    const registry = syncRegistry({ includeFixtures: true });
    const models = [DebugItem, ...PRODUCTION_MODELS];
    expect(registry.models.map((m) => m.name)).toEqual(models.map((m) => m.name));
    expect(registry.eager.map((m) => m.name)).toEqual(
      models.filter((m) => m.load === 'eager').map((m) => m.name),
    );
    // The client store hashes its model list the same way (sync-client `store.ts`).
    expect(registry.schemaHash).toBe(computeSchemaHash(models));
  });

  it('without them, leaves the fixture out of the models and the hash', () => {
    const registry = syncRegistry({ includeFixtures: false });
    expect(registry.models.map((m) => m.name)).toEqual(PRODUCTION_MODELS.map((m) => m.name));
    expect(registry.schemaHash).toBe(computeSchemaHash(PRODUCTION_MODELS));
    expect(registry.schemaHash).not.toBe(syncRegistry({ includeFixtures: true }).schemaHash);
  });

  it('serves the web app’s models in every environment, the fixtures only when a test asks', () => {
    // The web client syncs PRODUCTION_MODELS; a dev server that counted DebugItem in its hash
    // would refuse it as outdated (C's check against `pnpm dev`; SPEC-002 Q8).
    expect(serverSyncRegistry({}).schemaHash).toBe(computeSchemaHash(PRODUCTION_MODELS));
    expect(serverSyncRegistry({ syncFixtures: true }).models.map((m) => m.name)).toContain(
      'DebugItem',
    );
  });

  it('maps each declared field to its column, with groups taken from sync_groups', () => {
    const [model] = syncRegistry({ includeFixtures: true }).models;
    expect(model?.table).toBe('debug_items');
    expect(Object.fromEntries(model?.columns ?? [])).toEqual({
      id: 'id',
      title: 'title',
      counter: 'counter',
      // A synced field since protocol v0.7 (SPEC-011 §5.5).
      archivedAt: 'archived_at',
    });
    expect(model?.archivable).toBe(true);
  });

  it('maps a multi-word field to its snake_case column, as Drizzle names it in SQL', () => {
    const withCreatedAt = defineModel('DebugItem', {
      load: 'eager',
      fields: { title: str(), counter: int(), groups: array(str()), createdAt: timestamp() },
    });
    const model = syncModel('DebugItem', withCreatedAt, debugItems);
    expect(model.columns.get('createdAt')).toBe('created_at');
  });

  it("can't be given a field named like bootstrap's own aliases (__groups, __archived)", () => {
    // `defineModel` accepts camelCase names only, so the aliases never collide with a field.
    expect(() =>
      defineModel('DebugItem', { load: 'eager', fields: { __groups: array(str()) } }),
    ).toThrow('field __groups must be camelCase');
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

// PLAN-011 S5a (sync-protocol §2, §8): content models and their parents.
describe('content models', () => {
  const registry = syncRegistry({ includeFixtures: false });
  const registered = (name: string) => {
    const model = registry.content.find((m) => m.name === name);
    if (model === undefined) throw new Error(`${name} is not registered`);
    return model;
  };

  it('are IssueContent and IssueHistory, outside the bootstrap, with parent Issue by issueId', () => {
    expect(registry.content.map((m) => [m.name, m.def.parent])).toEqual([
      ['IssueContent', { model: 'Issue', field: 'issueId' }],
      ['IssueHistory', { model: 'Issue', field: 'issueId' }],
    ]);
    expect(registry.eager.map((m) => m.name)).not.toContain('IssueContent');
    expect(registry.models.filter((m) => m.def.load === 'content')).toEqual(registry.content);
  });

  it('change the schema hash with their parent, so clients re-bootstrap when it changes', () => {
    const others = PRODUCTION_MODELS.filter((m) => m.name !== 'IssueHistory');
    const history = registered('IssueHistory').def;
    expect(computeSchemaHash([...others, history])).toBe(registry.schemaHash);
    const reparented = { ...history, parent: { model: 'Issue', field: 'teamId' } };
    expect(computeSchemaHash([...others, reparented])).not.toBe(registry.schemaHash);
    const { parent: _parent, ...orphan } = history;
    expect(computeSchemaHash([...others, orphan])).not.toBe(registry.schemaHash);
  });

  it('can’t be defined without a parent', () => {
    expect(() =>
      defineModel('IssueHistory', { load: 'content', fields: { issueId: uuid() } }),
    ).toThrow('Model IssueHistory: a content model needs a parent');
  });

  it('must name a synced eager parent in the same registry', () => {
    const history = registered('IssueHistory');
    expect(contentParentProblem(registry.models)).toBeUndefined();
    const withParent = (model: string) => ({
      ...history,
      def: { ...history.def, parent: { model, field: 'issueId' } },
    });
    expect(contentParentProblem([...registry.models, withParent('Project')])).toBe(
      'Content model IssueHistory names parent Project, which is not a synced eager model.',
    );
    expect(contentParentProblem([...registry.models, withParent('IssueContent')])).toBe(
      'Content model IssueHistory names parent IssueContent, which is not a synced eager model.',
    );
  });
});

// PLAN-011 S3 review: the repo takes a child's team from its issue only for `issueChild: true`,
// and `groupsOfIssueChild` trusts that it did, so one without the other is a leak (SPEC-011 §5.1).
describe('issue child entries', () => {
  const child = {
    issueChild: true,
    groupsOf: groupsOfIssueChild,
    groupFields: ['issueId', 'teamId'],
  };

  it('accept an entry that declares both issueChild and groupsOfIssueChild', () => {
    expect(issueChildProblem('IssueHistory', child)).toBeUndefined();
  });

  it('refuse issueChild with other groups, and groupsOfIssueChild without issueChild', () => {
    expect(issueChildProblem('IssueHistory', { ...child, groupsOf: () => [] })).toBe(
      'Synced model IssueHistory has issueChild: true, so its groupsOf must be groupsOfIssueChild.',
    );
    expect(issueChildProblem('IssueHistory', { ...child, issueChild: undefined })).toBe(
      'Synced model IssueHistory uses groupsOfIssueChild, so it must declare issueChild: true, or its teamId would come from input.',
    );
  });

  it('refuse a child whose groupFields would let updateWhere move it', () => {
    for (const groupFields of [['teamId'], ['issueId'], []]) {
      expect(issueChildProblem('IssueHistory', { ...child, groupFields })).toBe(
        "Issue child IssueHistory must list issueId and teamId in groupFields, so updateWhere can't move it to another team.",
      );
    }
  });

  it('hold for every registered model, so the registry builds', () => {
    for (const [name, entry] of Object.entries(SYNCED_MODELS)) {
      expect(issueChildProblem(name, entry)).toBeUndefined();
    }
    expect(() => syncRegistry({ includeFixtures: true })).not.toThrow();
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
    archivedAt: new Date('2026-11-12T10:00:00.456Z'),
    archived: false,
  };

  it('holds exactly the declared fields, valid for the client model and the wire', () => {
    const d = clientRow(model, row, row.syncGroups, new Set(['workspace']));
    expect(d).toEqual({
      id: row.id,
      title: 'Shared',
      counter: 3,
      groups: ['workspace'],
      archivedAt: '2026-11-12T10:00:00.456Z',
    });
    expect(DebugItem.rowSchema.parse(d)).toEqual(d);
    expect(decodeBootstrapFrame({ t: 'row', m: 'DebugItem', d })).toMatchObject({ d });
  });

  it("carries only the groups the receiving connection is in (a private team's id stays hidden)", () => {
    expect(clientRow(model, row, row.syncGroups, new Set(['workspace']))['groups']).toEqual([
      'workspace',
    ]);
    expect(clientRow(model, row, row.syncGroups, new Set(row.syncGroups))['groups']).toEqual(
      row.syncGroups,
    );
  });

  it('sends instants as ISO strings with milliseconds', () => {
    const withCreatedAt = defineModel('DebugItem', {
      load: 'eager',
      fields: { title: str(), counter: int(), groups: array(str()), createdAt: timestamp() },
    });
    const timed = syncModel('DebugItem', withCreatedAt, debugItems);
    expect(clientRow(timed, row, row.syncGroups, new Set())['createdAt']).toBe(
      '2026-11-07T10:00:00.123Z',
    );
  });
});

// PLAN-011 S3: a calendar date (`day()`, the Issue's `dueDate`) leaves bootstrap as `YYYY-MM-DD`.
// `pg` parses a `date` into a `Date` at the server's local midnight, which `clientRow` would send
// as an instant; the select casts it to text instead.
describe('bootstrap of calendar dates', () => {
  const issue = syncRegistry({ includeFixtures: false }).models.find((m) => m.name === 'Issue');

  it('selects a day field as text, and every other field as stored', () => {
    if (!issue) throw new Error('Issue is not in the production registry');
    const select = selectRows(issue);
    expect(select).toContain('"due_date"::text AS "dueDate"');
    expect(select).toContain('"created_at" AS "createdAt"');
    expect(select).toContain('"sort_order" AS "sortOrder"');
  });

  it('sends the text date unchanged', () => {
    if (!issue) throw new Error('Issue is not in the production registry');
    const row = { id: '0190f0c0-0000-7000-8000-000000000001', dueDate: '2026-12-03' };
    expect(clientRow(issue, row, [], new Set())['dueDate']).toBe('2026-12-03');
  });
});
