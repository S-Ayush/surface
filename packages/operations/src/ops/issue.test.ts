// PLAN-011 S4, SPEC-011 §6.2, AC-7 (optimistic part): `issue.create` and `issue.update` predict
// the server's row except the number and sortOrder, predict nothing where the server would refuse,
// and give identical rows on every rebuild. The client drops an optimistic row its model rejects,
// so every row is parsed with the shared client model. That the predictions equal what the
// handlers commit is checked in server/test/issue-handlers.test.ts.
import { NEW_TEAM_SETTINGS, isFractionalKey, isUuid } from '@surface/domain';
import { PRODUCTION_MODELS } from '@surface/domain/model';
import { describe, expect, it } from 'vitest';
import type { OptimisticStore, StoreRow } from '../optimistic.js';
import { issueCreate, issueUpdate } from './issue.js';

const ENG = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
const DES = '0192f0c1-7e5a-7b3c-9d4e-0000000000e2';
const ME = '0192f0c1-7e5a-7b3c-9d4e-0000000000c1';
const IRIS = '0192f0c1-7e5a-7b3c-9d4e-0000000000c2';
const BUG = '0192f0c1-7e5a-7b3c-9d4e-0000000000a1'; // workspace
const DEFECT = '0192f0c1-7e5a-7b3c-9d4e-0000000000a2'; // ENG
const SIZE = '0192f0c1-7e5a-7b3c-9d4e-0000000000a3'; // ENG group, exclusive
const SMALL = '0192f0c1-7e5a-7b3c-9d4e-0000000000a4';
const LARGE = '0192f0c1-7e5a-7b3c-9d4e-0000000000a5';
const POLISH = '0192f0c1-7e5a-7b3c-9d4e-0000000000a6'; // DES
const OLD = '0192f0c1-7e5a-7b3c-9d4e-0000000000a7'; // ENG, archived
const EXISTING = '0192f0c1-7e5a-7b3c-9d4e-0000000000b1'; // ENG-1
const NEW_ID = '0192f0c1-7e5a-7b3c-9d4e-0000000000f1';
const NOW = new Date('2026-11-13T10:00:00.000Z');
const AT = NOW.toISOString();
const EARLIER = '2026-11-12T10:00:00.000Z';

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
  const get = (model: string, ref: string): StoreRow | undefined => {
    if (model === 'User' && ref === 'me') return table(model).get(ME);
    return isUuid(ref)
      ? table(model).get(ref)
      : [...table(model).values()].find((row) => row['key'] === ref || row['email'] === ref);
  };
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
    get,
    insert: put,
    patch: (model, ref, changes) => {
      const row = get(model, ref);
      if (row) put(model, { ...row, ...changes });
    },
    find: (model, fields) =>
      [...table(model).values()]
        .filter((row) => Object.entries(fields).every(([field, value]) => row[field] === value))
        .sort((a, b) => String(a['id']).localeCompare(String(b['id']))),
    archive: () => undefined,
    unarchive: () => undefined,
    remove: (model, ref) => {
      const id = get(model, ref)?.['id'];
      if (typeof id === 'string') table(model).delete(id);
    },
  };
}

const STATUSES = [
  ['Triage', 'triage'],
  ['Backlog', 'backlog'],
  ['Todo', 'unstarted'],
  ['In Progress', 'started'],
  ['Done', 'completed'],
  ['Canceled', 'canceled'],
  ['Duplicate', 'duplicate'],
] as const;

/** `0192…d<team><n>`: a status id per team and row of STATUSES. */
function statusId(team: 'ENG' | 'DES', name: string): string {
  const index = STATUSES.findIndex(([n]) => n === name);
  return `0192f0c1-7e5a-7b3c-9d4e-0000000${team === 'ENG' ? '1' : '2'}d00${index}`;
}

function seeded(estimateScale = 'off'): Store {
  const store = fakeStore();
  for (const [id, key] of [
    [ENG, 'ENG'],
    [DES, 'DES'],
  ] as const) {
    for (const [index, [name, category]] of STATUSES.entries()) {
      store.insert('WorkflowStatus', {
        id: statusId(key, name),
        teamId: id,
        name,
        category,
        color: 'gray',
        description: null,
        position: `a${index}`,
        groups: ['workspace'],
        createdAt: EARLIER,
        updatedAt: EARLIER,
      });
    }
    store.insert('Team', {
      ...NEW_TEAM_SETTINGS,
      id,
      key,
      name: key,
      icon: null,
      groups: ['workspace'],
      createdAt: EARLIER,
      updatedAt: EARLIER,
      defaultStatusId: statusId(key, 'Backlog'),
      estimateScale,
    });
  }
  for (const [id, name, email] of [
    [ME, 'Ada', 'ada@example.com'],
    [IRIS, 'Iris', 'iris@example.com'],
  ] as const) {
    store.insert('User', {
      id,
      email,
      name,
      displayName: name.toLowerCase(),
      avatarFileId: null,
      timezone: 'UTC',
      role: 'member',
      active: true,
      createdAt: EARLIER,
      updatedAt: EARLIER,
    });
  }
  const labels: (StoreRow & { readonly id: string })[] = [
    { id: BUG, teamId: null, name: 'Bug' },
    { id: DEFECT, teamId: ENG, name: 'Defect' },
    { id: SIZE, teamId: ENG, name: 'Size', isGroup: true },
    { id: SMALL, teamId: ENG, name: 'Small', parentId: SIZE },
    { id: LARGE, teamId: ENG, name: 'Large', parentId: SIZE },
    { id: POLISH, teamId: DES, name: 'Polish' },
    { id: OLD, teamId: ENG, name: 'Old', archivedAt: EARLIER },
  ];
  for (const label of labels) {
    store.insert('Label', {
      color: 'gray',
      description: null,
      parentId: null,
      isGroup: false,
      exclusive: true,
      groups: ['workspace'],
      archivedAt: null,
      createdAt: EARLIER,
      updatedAt: EARLIER,
      ...label,
    });
  }
  store.insert('Issue', {
    id: EXISTING,
    teamId: ENG,
    number: 1,
    title: 'Fix login',
    statusId: statusId('ENG', 'Todo'),
    priority: 0,
    assigneeId: null,
    labelIds: [SMALL, OLD],
    estimate: null,
    dueDate: null,
    sortOrder: 'a0',
    creatorId: ME,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    archivedAt: null,
    deletedAt: null,
    deletedById: null,
    groups: ['workspace'],
    createdAt: EARLIER,
    updatedAt: EARLIER,
  });
  return store;
}

function issue(store: Store, id: string): StoreRow | undefined {
  return store.rows.get('Issue')?.get(id);
}

function create(store: Store, input: Record<string, unknown>): void {
  issueCreate.optimistic?.(
    store,
    issueCreate.input.parse({ id: NEW_ID, team: 'ENG', title: 'Fix login', ...input }),
  );
}

function update(store: Store, input: Record<string, unknown>): void {
  issueUpdate.optimistic?.(store, issueUpdate.input.parse({ issue: EXISTING, ...input }));
}

describe('issue.create optimistic (§6.2)', () => {
  it('inserts the issue with no number, the team default status and the column defaults', () => {
    const store = seeded();
    create(store, { title: ' Fix\nthe login ' });
    const row = issue(store, NEW_ID);
    expect(row).toMatchObject({
      teamId: ENG,
      number: null,
      title: 'Fix the login',
      statusId: statusId('ENG', 'Backlog'),
      priority: 0,
      assigneeId: null,
      labelIds: [],
      estimate: null,
      dueDate: null,
      creatorId: ME,
      startedAt: null,
      completedAt: null,
      canceledAt: null,
      archivedAt: null,
      deletedAt: null,
      groups: ['workspace'],
      createdAt: AT,
      updatedAt: AT,
    });
  });

  it('puts the new issue first in the team: a key before the lowest one, from its id', () => {
    const store = seeded();
    create(store, {});
    const key = issue(store, NEW_ID)?.['sortOrder'];
    expect(typeof key === 'string' && isFractionalKey(key) && key < 'a0').toBe(true);
  });

  it('sets the category timestamps of its status, and resolves the assignee', () => {
    const store = seeded();
    create(store, { status: 'in progress', assignee: 'iris@example.com', dueDate: '2026-12-01' });
    expect(issue(store, NEW_ID)).toMatchObject({
      statusId: statusId('ENG', 'In Progress'),
      startedAt: AT,
      completedAt: null,
      assigneeId: IRIS,
      dueDate: '2026-12-01',
    });
  });

  it('applies the exclusive-group rule to the labels it is given (AC-4)', () => {
    const store = seeded('linear');
    create(store, { labels: ['Bug', 'Size/Small', LARGE], estimate: 3 });
    expect(issue(store, NEW_ID)).toMatchObject({ labelIds: [BUG, LARGE], estimate: 3 });
  });

  it('predicts nothing without an id, or when the server would refuse', () => {
    const refused: Record<string, unknown>[] = [
      { id: undefined }, // the server picks the id
      { status: 'Triage' },
      { status: 'Duplicate' },
      { status: statusId('DES', 'Todo') }, // another team's status (INV-06)
      { labels: [POLISH] }, // another team's label, by id (INV-06)
      { labels: ['Size'] }, // a group
      { labels: [OLD] }, // archived (SPEC-010 E12)
      { labels: ['Nope'] }, // unknown: the server answers
      { estimate: 3 }, // ENG has no estimates
      { assignee: 'nobody@example.com' },
    ];
    for (const input of refused) {
      const store = seeded();
      create(store, input);
      expect(issue(store, NEW_ID), JSON.stringify(input)).toBeUndefined();
    }
  });
});

describe('issue.update optimistic (§6.2)', () => {
  it('patches the given fields and the status side effects', () => {
    const store = seeded();
    update(store, { status: 'Done', priority: 2, assignee: 'me', title: 'Fix the login' });
    expect(issue(store, EXISTING)).toMatchObject({
      statusId: statusId('ENG', 'Done'),
      priority: 2,
      assigneeId: ME,
      title: 'Fix the login',
      startedAt: null,
      completedAt: AT,
      canceledAt: null,
      updatedAt: AT,
    });
  });

  it('replaces the label of an exclusive group, removes, and keeps an archived label already on it', () => {
    const store = seeded();
    update(store, { addLabels: ['Large', 'Bug'] });
    expect(issue(store, EXISTING)?.['labelIds']).toEqual([OLD, LARGE, BUG]);
    update(store, { removeLabels: ['Bug'], addLabels: [OLD] });
    expect(issue(store, EXISTING)?.['labelIds']).toEqual([OLD, LARGE]);
  });

  it('a no-op patches nothing, so updatedAt stays (E12)', () => {
    const store = seeded();
    update(store, { title: 'Fix login', priority: 0, addLabels: [SMALL], status: 'Todo' });
    expect(issue(store, EXISTING)?.['updatedAt']).toBe(EARLIER);
  });

  it('predicts nothing when the server would refuse', () => {
    const refused: Record<string, unknown>[] = [
      { status: 'Triage' },
      { status: statusId('DES', 'Todo') },
      { addLabels: [POLISH] },
      { addLabels: ['Size'] },
      { addLabels: [DEFECT], removeLabels: [DEFECT] },
      { estimate: 3 },
    ];
    for (const input of refused) {
      const store = seeded();
      update(store, { priority: 3, ...input });
      expect(issue(store, EXISTING)?.['updatedAt'], JSON.stringify(input)).toBe(EARLIER);
    }
  });

  it('predicts no edit of an archived or deleted issue (AC-23)', () => {
    for (const state of [{ archivedAt: EARLIER }, { deletedAt: EARLIER, deletedById: ME }]) {
      const store = seeded();
      store.patch('Issue', EXISTING, state);
      update(store, { priority: 3 });
      expect(issue(store, EXISTING)?.['priority']).toBe(0);
    }
  });
});

describe('rebuilds (AC-7)', () => {
  type Step = { readonly op: 'create' | 'update' } & Record<string, unknown>;
  const SEQUENCES: readonly (readonly Step[])[] = [
    [
      { op: 'create', status: 'Todo', labels: ['Bug', 'Small'] },
      { op: 'update', status: 'In Progress', addLabels: ['Large'] },
      { op: 'create', status: 'Done' },
      { op: 'update', status: 'Done', removeLabels: ['Large'], priority: 1 },
      { op: 'update', status: 'Todo', addLabels: ['Size/Small', 'Defect'] },
    ],
    [
      { op: 'update', addLabels: ['Large', 'Small'], priority: 4 },
      { op: 'create', status: 'Canceled', labels: ['Large', 'Size/Small'] },
      { op: 'update', status: 'Canceled' },
      { op: 'update', status: 'Backlog', title: 'Fix the login' },
    ],
  ];

  function rebuild(sequence: readonly Step[]): StoreRow[] {
    const store = seeded();
    sequence.forEach(({ op, ...input }, index) => {
      if (op === 'update') return update(store, input);
      const id = `0192f0c1-7e5a-7b3c-9d4e-0000000001${String(index).padStart(2, '0')}`;
      create(store, { ...input, id });
    });
    return [...(store.rows.get('Issue')?.values() ?? [])];
  }

  it('give identical rows for the same mutations, in every rebuild', () => {
    for (const sequence of SEQUENCES) {
      const first = rebuild(sequence);
      expect(first.length).toBeGreaterThan(1);
      expect(rebuild(sequence)).toEqual(first);
    }
  });
});
