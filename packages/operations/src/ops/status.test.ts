// PLAN-010 S2, AC-1 and AC-16 (optimistic part): the status operations' inputs, and what each
// predicts. The client drops an optimistic row its model rejects, so every row is parsed with the
// shared client model. The server's rules are tested in server/test/status-handlers.test.ts, which
// also checks that these predictions equal what the handlers commit.
import { NEW_TEAM_SETTINGS, comparePositions, isUuid, userActor } from '@surface/domain';
import { PRODUCTION_MODELS } from '@surface/domain/model';
import { describe, expect, it } from 'vitest';
import type { OptimisticStore, StoreRow } from '../optimistic.js';
import { evaluatePermission } from '../permission.js';
import { statusCreate, statusDelete, statusList, statusReorder, statusUpdate } from './status.js';

const ENG = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
const BACKLOG = '0192f0c1-7e5a-7b3c-9d4e-0000000000b1';
const TODO = '0192f0c1-7e5a-7b3c-9d4e-0000000000b2';
const PROGRESS = '0192f0c1-7e5a-7b3c-9d4e-0000000000b3';
const REVIEW = '0192f0c1-7e5a-7b3c-9d4e-0000000000b4';
const DONE = '0192f0c1-7e5a-7b3c-9d4e-0000000000b5';
const CANCELED = '0192f0c1-7e5a-7b3c-9d4e-0000000000b6';
const DUPLICATE = '0192f0c1-7e5a-7b3c-9d4e-0000000000b7';
const NEW_ID = '0192f0c1-7e5a-7b3c-9d4e-0000000000f1';
const NOW = new Date('2026-11-12T10:00:00.000Z');
const AT = NOW.toISOString();

const MODELS = new Map<string, (typeof PRODUCTION_MODELS)[number]>(
  PRODUCTION_MODELS.map((m) => [m.name, m]),
);

type Store = OptimisticStore & { rows: Map<string, Map<string, StoreRow>> };

function fakeStore(): Store {
  const rows = new Map<string, Map<string, StoreRow>>();
  const table = (model: string) => {
    let t = rows.get(model);
    if (!t) rows.set(model, (t = new Map<string, StoreRow>()));
    return t;
  };
  const find = (model: string, ref: string): StoreRow | undefined =>
    isUuid(ref)
      ? table(model).get(ref)
      : [...table(model).values()].find((row) => row['key'] === ref);
  const put = (model: string, row: StoreRow) => {
    const def = MODELS.get(model);
    if (!def) throw new Error(`unknown model ${model}`);
    const parsed: StoreRow = def.rowSchema.parse(row);
    const id = parsed['id'];
    if (typeof id !== 'string') throw new Error('row without id');
    table(model).set(id, parsed);
  };
  return {
    rows,
    now: NOW,
    get: find,
    insert: put,
    patch: (model, ref, changes) => {
      const row = find(model, ref);
      if (row) put(model, { ...row, ...changes });
    },
    find: (model, fields) =>
      [...table(model).values()].filter((row) =>
        Object.entries(fields).every(([field, value]) => row[field] === value),
      ),
    archive: () => undefined,
    unarchive: () => undefined,
    remove: (model, ref) => {
      const id = find(model, ref)?.['id'];
      if (typeof id === 'string') table(model).delete(id);
    },
  };
}

const SEED: readonly [string, string, string, string, string][] = [
  [BACKLOG, 'Backlog', 'backlog', 'gray', 'a0'],
  [TODO, 'Todo', 'unstarted', 'gray', 'a0'],
  [PROGRESS, 'In Progress', 'started', 'yellow', 'a0'],
  [REVIEW, 'In Review', 'started', 'green', 'a1'],
  [DONE, 'Done', 'completed', 'blue', 'a0'],
  [CANCELED, 'Canceled', 'canceled', 'gray', 'a0'],
  [DUPLICATE, 'Duplicate', 'duplicate', 'gray', 'a0'],
];

function seeded(): Store {
  const store = fakeStore();
  store.insert('Team', {
    ...NEW_TEAM_SETTINGS,
    id: ENG,
    key: 'ENG',
    name: 'Engineering',
    icon: null,
    groups: ['workspace'],
    createdAt: AT,
    updatedAt: AT,
    defaultStatusId: BACKLOG,
  });
  for (const [id, name, category, color, position] of SEED) {
    store.insert('WorkflowStatus', {
      id,
      teamId: ENG,
      name,
      category,
      color,
      description: null,
      position,
      groups: ['workspace'],
      createdAt: AT,
      updatedAt: AT,
    });
  }
  return store;
}

function row(store: Store, id: string): StoreRow | undefined {
  return store.rows.get('WorkflowStatus')?.get(id);
}

/** The names of a category in order, as the workflow page shows them. */
function order(store: Store, category: string): string[] {
  return [...(store.rows.get('WorkflowStatus')?.values() ?? [])]
    .filter((s) => s['category'] === category)
    .sort((a, b) => comparePositions(String(a['position']), String(b['position'])))
    .map((s) => String(s['name']));
}

describe('status operations: inputs', () => {
  it('create refuses Triage and Duplicate, and an empty or long name (AC-1)', () => {
    const base = { team: 'ENG', name: 'QA', category: 'started' };
    expect(statusCreate.input.safeParse(base).success).toBe(true);
    expect(statusCreate.input.safeParse({ ...base, category: 'triage' }).success).toBe(false);
    expect(statusCreate.input.safeParse({ ...base, category: 'duplicate' }).success).toBe(false);
    expect(statusCreate.input.safeParse({ ...base, name: '  ' }).success).toBe(false);
    expect(statusCreate.input.safeParse({ ...base, name: 'x'.repeat(51) }).success).toBe(false);
  });

  it('update has no category field, so the category can never change (AC-2)', () => {
    expect(Object.keys(statusUpdate.input.shape)).not.toContain('category');
  });

  it('reorder needs exactly one of before and after (AC-3)', () => {
    const base = { team: 'ENG', status: 'Done' };
    expect(statusReorder.input.safeParse(base).success).toBe(false);
    expect(statusReorder.input.safeParse({ ...base, before: 'a', after: 'b' }).success).toBe(false);
    expect(statusReorder.input.safeParse({ ...base, before: 'a' }).success).toBe(true);
  });

  it('delete is destructive and list is a query', () => {
    expect(statusDelete.destructive).toBe(true);
    expect(statusList.kind).toBe('query');
  });

  it('create has the "Add status…" command-menu entry in a team context (AC-23)', () => {
    expect(statusCreate.ui).toMatchObject({ title: 'Add status…', contexts: ['team'] });
  });
});

describe('status.create optimistic', () => {
  it('adds the status at the end of its category with the category color (AC-1)', () => {
    const store = seeded();
    statusCreate.optimistic?.(store, {
      id: NEW_ID,
      team: 'ENG',
      name: 'QA',
      category: 'started',
    });
    expect(row(store, NEW_ID)).toMatchObject({
      name: 'QA',
      category: 'started',
      color: 'yellow',
      description: null,
      teamId: ENG,
      groups: ['workspace'],
    });
    expect(order(store, 'started')).toEqual(['In Progress', 'In Review', 'QA']);
  });

  it('puts it right after the status named in after, by name in any case', () => {
    const store = seeded();
    statusCreate.optimistic?.(store, {
      id: NEW_ID,
      team: 'ENG',
      name: 'QA',
      category: 'started',
      after: 'in progress',
    });
    expect(order(store, 'started')).toEqual(['In Progress', 'QA', 'In Review']);
  });

  it('predicts nothing without an id, for a clashing name, or for an anchor in another category', () => {
    const store = seeded();
    statusCreate.optimistic?.(store, { team: 'ENG', name: 'QA', category: 'started' });
    statusCreate.optimistic?.(store, {
      id: NEW_ID,
      team: 'ENG',
      name: 'in review',
      category: 'started',
    });
    statusCreate.optimistic?.(store, {
      id: NEW_ID,
      team: 'ENG',
      name: 'QA',
      category: 'started',
      after: 'Done',
    });
    expect(row(store, NEW_ID)).toBeUndefined();
    expect(store.rows.get('WorkflowStatus')?.size).toBe(SEED.length);
  });
});

describe('status.update optimistic', () => {
  it('renames, recolors and clears the description', () => {
    const store = seeded();
    statusUpdate.optimistic?.(store, {
      team: 'ENG',
      status: 'In Review',
      name: 'Code review',
      color: 'red',
      description: '',
    });
    expect(row(store, REVIEW)).toMatchObject({
      name: 'Code review',
      color: 'red',
      description: null,
      category: 'started',
      updatedAt: AT,
    });
  });

  it('leaves Duplicate and a taken name alone', () => {
    const store = seeded();
    statusUpdate.optimistic?.(store, { team: 'ENG', status: 'Duplicate', name: 'Dupe' });
    statusUpdate.optimistic?.(store, { team: 'ENG', status: 'In Review', name: 'done' });
    expect(row(store, DUPLICATE)?.['name']).toBe('Duplicate');
    expect(row(store, REVIEW)?.['name']).toBe('In Review');
  });
});

describe('status.reorder optimistic', () => {
  it('writes only the moved row (AC-3)', () => {
    const store = seeded();
    const before = new Map(store.rows.get('WorkflowStatus'));
    statusReorder.optimistic?.(store, { team: 'ENG', status: 'In Review', before: 'In Progress' });
    expect(order(store, 'started')).toEqual(['In Review', 'In Progress']);
    for (const [id, old] of before) {
      if (id !== REVIEW) expect(row(store, id)).toEqual(old);
    }
  });

  it('writes nothing when the status would stay where it is, or the anchor is in another category', () => {
    const store = seeded();
    statusReorder.optimistic?.(store, { team: 'ENG', status: 'In Review', after: 'In Progress' });
    statusReorder.optimistic?.(store, { team: 'ENG', status: 'In Review', after: 'Done' });
    expect(row(store, REVIEW)?.['position']).toBe('a1');
  });
});

describe('status.delete optimistic', () => {
  it('removes an ordinary status', () => {
    const store = seeded();
    statusDelete.optimistic?.(store, { team: 'ENG', status: 'In Review' });
    expect(row(store, REVIEW)).toBeUndefined();
  });

  it('keeps the default, the last of a category, and Duplicate, which the server refuses too', () => {
    const store = seeded();
    for (const status of ['Backlog', 'Done', 'Duplicate']) {
      statusDelete.optimistic?.(store, { team: 'ENG', status });
    }
    expect(store.rows.get('WorkflowStatus')?.size).toBe(SEED.length);
  });
});

describe('status.update optimistic, nothing changing', () => {
  it('leaves the row, updatedAt included, as it is, like the server, which writes nothing', () => {
    const store = seeded();
    const before = row(store, REVIEW);
    // The clock moved on since the row was written.
    const later: Store = { ...store, now: new Date('2026-11-13T10:00:00.000Z') };
    statusUpdate.optimistic?.(later, {
      team: 'ENG',
      status: 'In Review',
      name: 'In Review',
      color: 'green',
      description: '',
    });
    expect(row(store, REVIEW)).toEqual(before);
  });
});

// AC-14, E11: who may change a workflow, through the shared predicates the executor runs.
describe('status operation permissions (AC-14, E11)', () => {
  const engRef = { team: { id: ENG, key: 'ENG', name: 'Engineering' } };
  const actor = (role: 'admin' | 'member', member: boolean) =>
    userActor({
      userId: 'u-1',
      role,
      memberships: member ? [{ teamId: ENG, private: false }] : [],
    });
  const mutations = [
    [statusCreate, { team: 'ENG', name: 'QA', category: 'started' }],
    [statusUpdate, { team: 'ENG', status: 'Done', name: 'Shipped' }],
    [statusReorder, { team: 'ENG', status: 'Done', before: 'Canceled' }],
    [statusDelete, { team: 'ENG', status: 'Done' }],
  ] as const;

  it('refuses a non-member Member of a public team with FORBIDDEN and the reason', () => {
    for (const [op, input] of mutations) {
      const result = evaluatePermission(op, actor('member', false), engRef, input);
      expect(result.allowed, op.name).toBe(false);
    }
  });

  it('says who may, worded from the operation summary (E11)', () => {
    const result = evaluatePermission(
      statusUpdate,
      actor('member', false),
      engRef,
      mutations[1][1],
    );
    expect(result).toEqual({
      allowed: false,
      reason: 'Only Admins or members of Engineering can rename, recolor or describe a status.',
    });
  });

  it('allows a member of the team, and an Admin who is not a member', () => {
    for (const [op, input] of mutations) {
      expect(evaluatePermission(op, actor('member', true), engRef, input).allowed, op.name).toBe(
        true,
      );
      expect(evaluatePermission(op, actor('admin', false), engRef, input).allowed, op.name).toBe(
        true,
      );
    }
  });

  it('lets anyone who can see the team read its statuses (status.list is p.any())', () => {
    const outsider = actor('member', false);
    expect(evaluatePermission(statusList, outsider, engRef, { team: 'ENG' }).allowed).toBe(true);
  });
});
