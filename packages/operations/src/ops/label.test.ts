// PLAN-010 S3, SPEC-010 AC-9 (input shapes), AC-14 (permissions, narrowed key, E15), AC-16
// (optimistic part), AC-23 (the "Create label…" entry), AC-24 (move to workspace, optimistic).
// The client drops an optimistic row its model rejects, so every row is parsed with the shared
// client model. The server's rules run in server/test/label-handlers.test.ts, which also checks
// that these predictions equal what the handlers commit.
import { NEW_TEAM_SETTINGS, isUuid, userActor } from '@surface/domain';
import { PRODUCTION_MODELS } from '@surface/domain/model';
import { describe, expect, it } from 'vitest';
import type { OptimisticStore, StoreRow } from '../optimistic.js';
import { evaluatePermission } from '../permission.js';
import { labelCreate, labelDelete, labelList, labelMoveToWorkspace, labelUpdate } from './label.js';

const ENG = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
const DES = '0192f0c1-7e5a-7b3c-9d4e-0000000000e2';
const WS_BUG = '0192f0c1-7e5a-7b3c-9d4e-0000000000a1';
const ENG_BUG = '0192f0c1-7e5a-7b3c-9d4e-0000000000a2';
const SIZE = '0192f0c1-7e5a-7b3c-9d4e-0000000000a3';
const SMALL = '0192f0c1-7e5a-7b3c-9d4e-0000000000a4';
const SCOPE = '0192f0c1-7e5a-7b3c-9d4e-0000000000a5';
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
  const get = (model: string, ref: string): StoreRow | undefined =>
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
    get,
    insert: put,
    patch: (model, ref, changes) => {
      const row = get(model, ref);
      if (row) put(model, { ...row, ...changes });
    },
    find: (model, fields) =>
      [...table(model).values()].filter((row) =>
        Object.entries(fields).every(([field, value]) => row[field] === value),
      ),
    archive: () => undefined,
    unarchive: () => undefined,
    remove: (model, ref) => {
      const id = get(model, ref)?.['id'];
      if (typeof id === 'string') table(model).delete(id);
    },
  };
}

const LABELS: readonly {
  id: string;
  teamId: string | null;
  name: string;
  parentId?: string;
  isGroup?: boolean;
}[] = [
  { id: WS_BUG, teamId: null, name: 'Bug' },
  { id: ENG_BUG, teamId: ENG, name: 'Defect' },
  { id: SIZE, teamId: ENG, name: 'Size', isGroup: true },
  { id: SMALL, teamId: ENG, name: 'Small', parentId: SIZE },
  { id: SCOPE, teamId: ENG, name: 'Scope', isGroup: true },
];

function seeded(): Store {
  const store = fakeStore();
  for (const [id, key, name] of [
    [ENG, 'ENG', 'Engineering'],
    [DES, 'DES', 'Design'],
  ] as const) {
    store.insert('Team', {
      ...NEW_TEAM_SETTINGS,
      id,
      key,
      name,
      icon: null,
      groups: ['workspace'],
      createdAt: AT,
      updatedAt: AT,
      defaultStatusId: ENG_BUG,
    });
  }
  for (const label of LABELS) {
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
  return store;
}

function row(store: Store, id: string): StoreRow | undefined {
  return store.rows.get('Label')?.get(id);
}

function count(store: Store): number {
  return store.rows.get('Label')?.size ?? 0;
}

describe('label operations: inputs', () => {
  it('create needs a name and keeps the optional fields optional (AC-9)', () => {
    expect(labelCreate.input.safeParse({ name: 'Bug' }).success).toBe(true);
    expect(labelCreate.input.safeParse({ team: 'ENG', name: 'Size/Small' }).success).toBe(true);
    expect(labelCreate.input.safeParse({ name: '  ' }).success).toBe(false);
    expect(labelCreate.input.safeParse({ name: 'x'.repeat(51) }).success).toBe(false);
    expect(labelCreate.input.safeParse({ name: 'Bug', description: 'x'.repeat(256) }).success).toBe(
      false,
    );
  });

  it('update takes a group reference or null, and Group/Label as the label (AC-18)', () => {
    expect(
      labelUpdate.input.safeParse({ label: 'Size/Small', team: 'ENG', group: null }).success,
    ).toBe(true);
    expect(labelUpdate.input.safeParse({ label: 'Small', group: 'Size' }).success).toBe(true);
    expect(labelUpdate.input.safeParse({ label: '/Small' }).success).toBe(false);
  });

  it('list defaults to scope all and is a query; delete is destructive', () => {
    expect(labelList.kind).toBe('query');
    expect(labelList.input.parse({}).scope).toBe('all');
    expect(labelDelete.destructive).toBe(true);
  });

  it('create has the "Create label…" entry in the team and global contexts (AC-23)', () => {
    expect(labelCreate.ui).toMatchObject({ title: 'Create label…', contexts: ['team', 'global'] });
    expect(labelMoveToWorkspace.ui).toBeUndefined();
  });
});

describe('label.create optimistic', () => {
  it('adds a team label with the team groups and the column defaults (AC-16)', () => {
    const store = seeded();
    labelCreate.optimistic?.(store, { id: NEW_ID, team: 'ENG', name: 'Needs design' });
    expect(row(store, NEW_ID)).toMatchObject({
      teamId: ENG,
      name: 'Needs design',
      color: 'gray',
      description: null,
      parentId: null,
      isGroup: false,
      exclusive: true,
      groups: ['workspace'],
      archivedAt: null,
    });
  });

  it('adds a workspace label without a team, and a group that is single-select by default', () => {
    const store = seeded();
    labelCreate.optimistic?.(store, { id: NEW_ID, name: 'Chore', isGroup: true, color: 'red' });
    expect(row(store, NEW_ID)).toMatchObject({
      teamId: null,
      isGroup: true,
      exclusive: true,
      color: 'red',
    });
  });

  it('puts a label in a group found by name or Group/Label', () => {
    const store = seeded();
    labelCreate.optimistic?.(store, { id: NEW_ID, team: 'ENG', name: 'Large', group: 'size' });
    expect(row(store, NEW_ID)?.['parentId']).toBe(SIZE);
  });

  it('predicts nothing without an id, or when the server would refuse', () => {
    const store = seeded();
    const refused = [
      { team: 'ENG', name: 'Needs design' }, // no id
      { id: NEW_ID, team: 'ENG', name: 'defect' }, // name taken (any case)
      { id: NEW_ID, team: 'ENG', name: 'Priority' }, // reserved
      { id: NEW_ID, team: 'ENG', name: 'a/b' }, // separator
      { id: NEW_ID, team: 'ENG', name: 'Large', exclusive: false }, // not a group
      { id: NEW_ID, team: 'ENG', name: 'Large', group: 'Bug' }, // not a group
      { id: NEW_ID, name: 'Large', group: 'Size' }, // group of another scope: not found
    ];
    for (const input of refused) labelCreate.optimistic?.(store, input);
    expect(count(store)).toBe(LABELS.length);
  });

  it('allows a team label to share a name with a workspace label', () => {
    const store = seeded();
    labelCreate.optimistic?.(store, { id: NEW_ID, team: 'ENG', name: 'Bug' });
    expect(row(store, NEW_ID)?.['name']).toBe('Bug');
  });
});

describe('label.update optimistic', () => {
  it('renames, recolors and clears the description', () => {
    const store = seeded();
    labelUpdate.optimistic?.(store, {
      label: 'Defect',
      team: 'ENG',
      name: 'Regression',
      color: 'red',
      description: '',
    });
    expect(row(store, ENG_BUG)).toMatchObject({
      name: 'Regression',
      color: 'red',
      description: null,
      updatedAt: AT,
    });
  });

  it('moves a label into a group, and out of it with null', () => {
    const store = seeded();
    labelUpdate.optimistic?.(store, { label: 'Defect', team: 'ENG', group: 'Scope' });
    expect(row(store, ENG_BUG)?.['parentId']).toBe(SCOPE);
    labelUpdate.optimistic?.(store, { label: 'Scope/Defect', team: 'ENG', group: null });
    expect(row(store, ENG_BUG)?.['parentId']).toBeNull();
  });

  it('switches a group to multiple choice, and refuses exclusive on a plain label', () => {
    const store = seeded();
    labelUpdate.optimistic?.(store, { label: 'Size', team: 'ENG', exclusive: false });
    labelUpdate.optimistic?.(store, { label: 'Defect', team: 'ENG', exclusive: false });
    expect(row(store, SIZE)?.['exclusive']).toBe(false);
    expect(row(store, ENG_BUG)?.['exclusive']).toBe(true);
  });

  it('leaves the row, updatedAt included, alone when nothing differs, like the server', () => {
    const store = seeded();
    labelUpdate.optimistic?.(store, {
      label: 'Defect',
      team: 'ENG',
      name: 'Defect',
      color: 'gray',
    });
    expect(row(store, ENG_BUG)?.['updatedAt']).toBe(EARLIER);
  });

  it('predicts nothing for a taken name, a group inside a group, or a missing label', () => {
    const store = seeded();
    labelUpdate.optimistic?.(store, { label: 'Defect', team: 'ENG', name: 'size' });
    labelUpdate.optimistic?.(store, { label: 'Size', team: 'ENG', group: 'Scope' });
    labelUpdate.optimistic?.(store, { label: 'Nope', team: 'ENG', name: 'Other' });
    expect(row(store, ENG_BUG)?.['name']).toBe('Defect');
    expect(row(store, SIZE)?.['parentId']).toBeNull();
  });

  it('takes a uuid without a team', () => {
    const store = seeded();
    labelUpdate.optimistic?.(store, { label: ENG_BUG, name: 'Regression' });
    expect(row(store, ENG_BUG)?.['name']).toBe('Regression');
  });
});

describe('label.moveToWorkspace optimistic (AC-24)', () => {
  it('sets teamId to null on a label', () => {
    const store = seeded();
    labelMoveToWorkspace.optimistic?.(store, { label: 'Defect', team: 'ENG' });
    expect(row(store, ENG_BUG)).toMatchObject({ teamId: null, groups: ['workspace'] });
  });

  it('moves a group together with its labels', () => {
    const store = seeded();
    labelMoveToWorkspace.optimistic?.(store, { label: 'Size', team: 'ENG' });
    expect(row(store, SIZE)?.['teamId']).toBeNull();
    expect(row(store, SMALL)?.['teamId']).toBeNull();
    expect(row(store, SMALL)?.['parentId']).toBe(SIZE);
    expect(row(store, SCOPE)?.['teamId']).toBe(ENG);
  });

  it('moves nothing for a label inside a group (E21) or a name a workspace label has (E20)', () => {
    const store = seeded();
    labelMoveToWorkspace.optimistic?.(store, { label: 'Size/Small', team: 'ENG' });
    labelCreate.optimistic?.(store, { id: NEW_ID, team: 'ENG', name: 'Bug' });
    labelMoveToWorkspace.optimistic?.(store, { label: NEW_ID, team: 'ENG' });
    expect(row(store, SMALL)?.['teamId']).toBe(ENG);
    expect(row(store, NEW_ID)?.['teamId']).toBe(ENG);
  });
});

describe('label.delete optimistic', () => {
  it('removes the label row only', () => {
    const store = seeded();
    labelDelete.optimistic?.(store, { label: 'Defect', team: 'ENG' });
    expect(row(store, ENG_BUG)).toBeUndefined();
    expect(count(store)).toBe(LABELS.length - 1);
  });

  it('keeps a group that still has labels, which the server refuses too', () => {
    const store = seeded();
    labelDelete.optimistic?.(store, { label: 'Size', team: 'ENG' });
    expect(row(store, SIZE)).toBeDefined();
    labelDelete.optimistic?.(store, { label: 'Scope', team: 'ENG' });
    expect(row(store, SCOPE)).toBeUndefined();
  });
});

// AC-14, E15: who may change labels, through the shared predicates the executor runs.
describe('label operation permissions (AC-14, E15)', () => {
  const engRef = { team: { id: ENG, key: 'ENG', name: 'Engineering' } };
  const teamLabel = { label: { id: ENG_BUG, teamId: ENG, name: 'Defect' } };
  const workspaceLabel = { label: { id: WS_BUG, teamId: null, name: 'Bug' } };
  const narrowed = {
    kind: 'api' as const,
    apiKey: { id: 'k', scope: 'read_write' as const, teamIds: [ENG], allowDestructive: true },
  };
  const actor = (
    role: 'admin' | 'member',
    member: boolean,
    via?: { kind: 'api'; apiKey: typeof narrowed.apiKey },
  ) =>
    userActor({
      userId: 'u-1',
      role,
      memberships: member ? [{ teamId: ENG, private: false }] : [],
      ...(via ? { via } : {}),
    });

  it('lets only a member of the team, or an Admin, change a team label', () => {
    const calls = [
      [labelCreate, engRef, { team: 'ENG', name: 'QA' }],
      [labelUpdate, teamLabel, { label: 'Defect', name: 'X' }],
      [labelDelete, teamLabel, { label: 'Defect' }],
      [labelMoveToWorkspace, { ...teamLabel, ...engRef }, { label: 'Defect', team: 'ENG' }],
    ] as const;
    for (const [op, refs, input] of calls) {
      expect(evaluatePermission(op, actor('member', false), refs, input).allowed, op.name).toBe(
        false,
      );
      expect(evaluatePermission(op, actor('member', true), refs, input).allowed, op.name).toBe(
        true,
      );
      expect(evaluatePermission(op, actor('admin', false), refs, input).allowed, op.name).toBe(
        true,
      );
    }
  });

  it('says who may, worded from the summary', () => {
    expect(
      evaluatePermission(labelUpdate, actor('member', false), teamLabel, { label: 'Defect' }),
    ).toEqual({
      allowed: false,
      reason: 'Only Admins or members of the team can edit a label or label group.',
    });
  });

  it('lets any member create, edit and delete workspace labels (D9)', () => {
    const outsider = actor('member', false);
    expect(evaluatePermission(labelCreate, outsider, {}, { name: 'Chore' }).allowed).toBe(true);
    expect(
      evaluatePermission(labelUpdate, outsider, workspaceLabel, { label: 'Bug' }).allowed,
    ).toBe(true);
    expect(
      evaluatePermission(labelDelete, outsider, workspaceLabel, { label: 'Bug' }).allowed,
    ).toBe(true);
  });

  it('refuses a key narrowed to some teams any workspace-label change, with the reason (E15)', () => {
    const key = actor('admin', true, narrowed);
    const reason =
      'This API key is limited to some teams. Changing workspace labels needs a key for all teams.';
    expect(evaluatePermission(labelCreate, key, {}, { name: 'Chore' })).toEqual({
      allowed: false,
      reason,
    });
    expect(evaluatePermission(labelUpdate, key, workspaceLabel, { label: 'Bug' })).toEqual({
      allowed: false,
      reason,
    });
    expect(evaluatePermission(labelDelete, key, workspaceLabel, { label: 'Bug' })).toEqual({
      allowed: false,
      reason,
    });
  });

  it('refuses a narrowed key label.moveToWorkspace even for its own team (E15)', () => {
    const key = actor('member', true, narrowed);
    const result = evaluatePermission(
      labelMoveToWorkspace,
      key,
      { ...teamLabel, ...engRef },
      { label: 'Defect', team: 'ENG' },
    );
    expect(result).toMatchObject({ allowed: false });
    // It can still change its own team's labels.
    expect(evaluatePermission(labelUpdate, key, teamLabel, { label: 'Defect' }).allowed).toBe(true);
  });

  it('lets anyone read labels (label.list is p.any())', () => {
    expect(evaluatePermission(labelList, actor('member', false), {}, {}).allowed).toBe(true);
  });
});
