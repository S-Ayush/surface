// PLAN-010 S3, SPEC-010 AC-9, AC-12 (group refusal; the issue rewrite is S5), AC-13 (label
// limits), AC-16 (optimistic equals the server), AC-24 (one transaction, E20, E21, no issue
// touched), E7 (the count's shape), E14, E18, E19, plus the lock order of §4.4. The rules run on
// an in-memory scope (`support/memory-labels.ts`); the SQL is covered by the registry contract
// and leak tests, and who may call each operation by `ops/label.test.ts`.
import { randomUUID } from 'node:crypto';
import { LABEL_LIMITS } from '@surface/domain';
import { labelCreate, labelUpdate, type OptimisticStore, type StoreRow } from '@surface/operations';
import { describe, expect, it } from 'vitest';
import { SurfaceError } from '../src/executor/errors.js';
import {
  createLabel,
  deleteLabel,
  moveLabelToWorkspace,
  updateLabel,
  type LabelRow,
} from '../src/handlers/labels/core.js';
import { memoryLabels, type MemoryLabels } from './support/memory-labels.js';

const NOW = new Date('2026-11-13T10:00:00Z');

async function failure(run: Promise<unknown>): Promise<SurfaceError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof SurfaceError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

function create(
  m: MemoryLabels,
  name: string,
  extra: {
    team?: 'eng' | 'des' | 'workspace';
    isGroup?: boolean;
    exclusive?: boolean;
    groupId?: string;
  } = {},
) {
  const team = extra.team === 'workspace' ? undefined : m[extra.team ?? 'eng'];
  return createLabel(m.access, m.repo, {
    id: randomUUID(),
    teamRef: team?.key,
    team,
    name,
    isGroup: extra.isGroup,
    exclusive: extra.exclusive,
    groupId: extra.groupId,
  });
}

const ref = (row: LabelRow) => ({ id: row.id, teamId: row.teamId });

describe('label.create (AC-9)', () => {
  it('creates a team label with the column defaults', async () => {
    const m = memoryLabels();
    const row = await create(m, 'Needs design');
    expect(row).toMatchObject({
      teamId: m.eng.id,
      name: 'Needs design',
      color: 'gray',
      description: null,
      parentId: null,
      isGroup: false,
      exclusive: true,
    });
  });

  it('creates a workspace label without a team, locking the workspace row', async () => {
    const m = memoryLabels();
    const row = await create(m, 'Chore', { team: 'workspace' });
    expect(row.teamId).toBeNull();
    expect(m.calls).toEqual(['lockWorkspace', 'scopeLabels']);
  });

  it('creates a group, single-select by default or multiple on request, and a label inside it', async () => {
    const m = memoryLabels();
    const single = await create(m, 'Size', { isGroup: true });
    const multi = await create(m, 'Area', { isGroup: true, exclusive: false });
    const inside = await create(m, 'Small', { groupId: single.id });
    expect([single.exclusive, multi.exclusive]).toEqual([true, false]);
    expect(inside.parentId).toBe(single.id);
  });

  it('locks the team row, re-reads the group FOR KEY SHARE, then reads the scope (§4.4)', async () => {
    const m = memoryLabels();
    const group = await create(m, 'Size', { isGroup: true });
    m.calls.length = 0;
    await create(m, 'Small', { groupId: group.id });
    expect(m.calls).toEqual(['lockTeam', 'shareLabel:Size', 'scopeLabels']);
  });

  it('refuses a name in use in the same scope and group, any case, with CONFLICT on name', async () => {
    const m = memoryLabels();
    await create(m, 'Bug');
    const error = await failure(create(m, 'bug'));
    expect(error).toMatchObject({ code: 'CONFLICT' });
    expect(error.message).toBe('A label named "bug" already exists in ENG. Choose another name.');
    expect(error.details?.issues?.[0]?.path).toEqual(['name']);
  });

  it('lets another team, and the workspace, use the same name', async () => {
    const m = memoryLabels();
    await create(m, 'Bug');
    await create(m, 'Bug', { team: 'des' });
    await create(m, 'Bug', { team: 'workspace' });
    expect(m.rows.size).toBe(3);
  });

  it('refuses separators and reserved words (E18, E19)', async () => {
    const m = memoryLabels();
    expect((await failure(create(m, 'Size/Small'))).message).toBe(
      "Label names can't contain / or :. Use a group instead, like Size/Small.",
    );
    expect((await failure(create(m, 'Priority'))).message).toBe(
      'Priority is a reserved name. Choose another label name.',
    );
    expect(m.writes).toEqual([]);
  });

  it('refuses exclusive on a plain label, and a group in a group', async () => {
    const m = memoryLabels();
    const group = await create(m, 'Size', { isGroup: true });
    expect(await failure(create(m, 'X', { exclusive: false }))).toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect((await failure(create(m, 'Y', { isGroup: true, groupId: group.id }))).message).toBe(
      "A label group can't go inside another group.",
    );
  });

  it('refuses a group of another scope, and a group deleted meanwhile (CONFLICT)', async () => {
    const m = memoryLabels();
    const other = await create(m, 'Size', { team: 'des', isGroup: true });
    expect((await failure(create(m, 'Small', { groupId: other.id }))).message).toBe(
      "Team labels can only go in their team's groups.",
    );
    const gone = await failure(create(m, 'Small', { groupId: randomUUID() }));
    expect(gone).toMatchObject({ code: 'CONFLICT' });
    expect(gone.message).toBe('That label group was deleted. Choose another group.');
  });

  it('refuses a label in an archived group (E14)', async () => {
    const m = memoryLabels();
    const group = m.add({ name: 'Old', isGroup: true, archivedAt: NOW });
    expect((await failure(create(m, 'X', { groupId: group.id }))).message).toBe(
      'The Old group is archived. Unarchive the group first.',
    );
  });

  it('refuses the 501st label of a scope, archived ones counting (AC-13)', async () => {
    const m = memoryLabels();
    for (let i = 0; i < LABEL_LIMITS.perScope; i++) {
      m.add({ name: `L${i}`, archivedAt: i % 2 ? NOW : null });
    }
    const error = await failure(create(m, 'One more'));
    expect(error).toMatchObject({ code: 'INVALID_INPUT' });
    expect(error.message).toBe('A team can have at most 500 labels. Delete one first.');
    // The scope limit is about the new label's name, not its group.
    expect(error.details.issues?.[0]?.path).toEqual(['name']);
    // Another team's scope is separate.
    await create(m, 'One more', { team: 'des' });
  });

  it('refuses the 251st label of a group (AC-13)', async () => {
    const m = memoryLabels();
    const group = m.add({ name: 'Big', isGroup: true });
    for (let i = 0; i < LABEL_LIMITS.perGroup; i++) m.add({ name: `G${i}`, parentId: group.id });
    expect((await failure(create(m, 'One more', { groupId: group.id }))).message).toBe(
      'A label group can have at most 250 labels. Delete one first.',
    );
  });
});

describe('label.update (AC-9, AC-10)', () => {
  it('renames, recolors and clears the description, writing only what differs', async () => {
    const m = memoryLabels();
    const row = m.add({ name: 'Bug', color: 'red', description: 'Broken' });
    const updated = await updateLabel(m.access, m.repo, {
      label: ref(row),
      name: 'Defect',
      color: 'red',
      description: '',
    });
    expect(updated).toMatchObject({ name: 'Defect', description: null, color: 'red' });
    expect(m.writes).toEqual([
      { action: 'update', id: row.id, model: 'Label', fields: ['name', 'description'] },
    ]);
  });

  it('writes nothing when nothing differs', async () => {
    const m = memoryLabels();
    const row = m.add({ name: 'Bug' });
    await updateLabel(m.access, m.repo, { label: ref(row), name: 'Bug', color: 'gray' });
    expect(m.writes).toEqual([]);
  });

  it('locks the team row, then the label row, then reads the scope (§4.4)', async () => {
    const m = memoryLabels();
    const row = m.add({ name: 'Bug' });
    await updateLabel(m.access, m.repo, { label: ref(row), name: 'Defect' });
    expect(m.calls).toEqual(['lockTeam', 'lockLabel:Bug', 'scopeLabels']);
  });

  it('refuses a name another label of the group has, in any case', async () => {
    const m = memoryLabels();
    m.add({ name: 'Bug' });
    const row = m.add({ name: 'Feature' });
    const error = await failure(updateLabel(m.access, m.repo, { label: ref(row), name: 'BUG' }));
    expect(error).toMatchObject({ code: 'CONFLICT' });
  });

  it('moves a label into a group and out again, reading no issue', async () => {
    const m = memoryLabels();
    const group = m.add({ name: 'Size', isGroup: true });
    const row = m.add({ name: 'Small' });
    const inside = await updateLabel(m.access, m.repo, { label: ref(row), groupId: group.id });
    expect(inside.parentId).toBe(group.id);
    const out = await updateLabel(m.access, m.repo, { label: ref(row), groupId: null });
    expect(out.parentId).toBeNull();
    expect(m.writes.every((w) => w.model === 'Label')).toBe(true);
  });

  it('switches a group to multiple choice and back without touching another row (E6)', async () => {
    const m = memoryLabels();
    const group = m.add({ name: 'Size', isGroup: true });
    m.add({ name: 'Small', parentId: group.id });
    await updateLabel(m.access, m.repo, { label: ref(group), exclusive: false });
    expect(m.writes).toEqual([
      { action: 'update', id: group.id, model: 'Label', fields: ['exclusive'] },
    ]);
  });

  it('refuses exclusive on a plain label, a name clash after moving into a group, an archived group (E14)', async () => {
    const m = memoryLabels();
    const group = m.add({ name: 'Size', isGroup: true });
    m.add({ name: 'Small', parentId: group.id });
    const row = m.add({ name: 'Small' });
    expect(
      await failure(updateLabel(m.access, m.repo, { label: ref(row), exclusive: true })),
    ).toMatchObject({ code: 'INVALID_INPUT' });
    expect(
      await failure(updateLabel(m.access, m.repo, { label: ref(row), groupId: group.id })),
    ).toMatchObject({ code: 'CONFLICT' });
    const old = m.add({ name: 'Old', isGroup: true, archivedAt: NOW });
    expect(
      (await failure(updateLabel(m.access, m.repo, { label: ref(row), groupId: old.id }))).message,
    ).toBe('The Old group is archived. Unarchive the group first.');
  });

  it('lets an archived label be renamed', async () => {
    const m = memoryLabels();
    const row = m.add({ name: 'Old', archivedAt: NOW });
    const updated = await updateLabel(m.access, m.repo, { label: ref(row), name: 'Older' });
    expect(updated.name).toBe('Older');
  });

  it('answers CONFLICT when the label is gone, or moved to another scope since it was resolved', async () => {
    const m = memoryLabels();
    expect(
      await failure(
        updateLabel(m.access, m.repo, {
          label: { id: randomUUID(), teamId: m.eng.id },
          name: 'X',
        }),
      ),
    ).toMatchObject({ code: 'CONFLICT' });
    const row = m.add({ name: 'Bug', teamId: null });
    expect(
      await failure(
        updateLabel(m.access, m.repo, { label: { id: row.id, teamId: m.eng.id }, name: 'X' }),
      ),
    ).toMatchObject({ code: 'CONFLICT' });
  });
});

describe('label.delete (AC-12, E7)', () => {
  it('deletes a label no issue carries, rewrites no issue and returns removedFromIssues 0', async () => {
    const m = memoryLabels();
    const row = m.add({ name: 'Bug' });
    m.addIssue([]);
    const out = await deleteLabel(m.access, m.repo, { label: ref(row) });
    expect(out).toMatchObject({ label: { id: row.id }, removedFromIssues: 0 });
    expect(m.rows.size).toBe(0);
    expect(m.writes).toEqual([{ action: 'purge', id: row.id, model: 'Label' }]);
  });

  it('refuses a group that still has labels, archived ones included, and deletes an empty one', async () => {
    const m = memoryLabels();
    const group = m.add({ name: 'Size', isGroup: true });
    const child = m.add({ name: 'Small', parentId: group.id, archivedAt: NOW });
    const error = await failure(deleteLabel(m.access, m.repo, { label: ref(group) }));
    expect(error).toMatchObject({ code: 'CONFLICT' });
    expect(m.rows.size).toBe(2);
    await deleteLabel(m.access, m.repo, { label: ref(child) });
    await deleteLabel(m.access, m.repo, { label: ref(group) });
    expect(m.rows.size).toBe(0);
  });

  it('locks the scope row, then the label row, then reads the scope and rewrites issues (§4.4)', async () => {
    const m = memoryLabels();
    const row = m.add({ name: 'Bug', teamId: null });
    await deleteLabel(m.access, m.repo, { label: ref(row) });
    expect(m.calls).toEqual([
      'lockWorkspace',
      'lockLabel:Bug',
      'scopeLabels',
      'removeFromIssues:Bug',
    ]);
  });

  it('answers CONFLICT when the label is already gone', async () => {
    const m = memoryLabels();
    const error = await failure(
      deleteLabel(m.access, m.repo, { label: { id: randomUUID(), teamId: m.eng.id } }),
    );
    expect(error.message).toBe('That label was deleted or moved. Reload and try again.');
  });
});

describe('label.moveToWorkspace (AC-24)', () => {
  function move(m: MemoryLabels, row: LabelRow) {
    return moveLabelToWorkspace(m.access, m.repo, {
      teamRef: 'ENG',
      team: m.eng,
      label: ref(row),
    });
  }

  it('moves a label by writing teamId only, and no issue', async () => {
    const m = memoryLabels();
    const row = m.add({ name: 'Needs design' });
    const moved = await move(m, row);
    expect(moved.teamId).toBeNull();
    expect(m.writes).toEqual([
      { action: 'update', id: row.id, model: 'Label', fields: ['teamId'] },
    ]);
  });

  it('moves a group with all its labels, archived ones included, in ascending id order', async () => {
    const m = memoryLabels();
    const group = m.add({ name: 'Size', isGroup: true });
    const a = m.add({ name: 'Small', parentId: group.id });
    const b = m.add({ name: 'Huge', parentId: group.id, archivedAt: NOW });
    const other = m.add({ name: 'Scope', isGroup: true });
    await move(m, group);
    for (const row of [group, a, b]) expect(m.rows.get(row.id)?.teamId).toBeNull();
    expect(m.rows.get(a.id)?.parentId).toBe(group.id);
    expect(m.rows.get(other.id)?.teamId).toBe(m.eng.id);
    const updated = m.writes.map((w) => w.id);
    expect(updated).toEqual([group.id, a.id, b.id].sort());
  });

  it('locks the workspace row, then the team row, then the labels (§4.4)', async () => {
    const m = memoryLabels();
    const row = m.add({ name: 'Needs design' });
    await move(m, row);
    expect(m.calls.filter((c) => c !== 'scopeLabels')).toEqual([
      'lockWorkspace',
      'lockTeam',
      'lockLabel:Needs design',
    ]);
  });

  it('refuses a label inside a group (E21), writing nothing', async () => {
    const m = memoryLabels();
    const group = m.add({ name: 'Size', isGroup: true });
    const row = m.add({ name: 'Small', parentId: group.id });
    const error = await failure(move(m, row));
    expect(error).toMatchObject({ code: 'INVALID_INPUT' });
    expect(error.message).toBe(
      'Move the Size group instead, or take the label out of its group first.',
    );
    expect(m.writes).toEqual([]);
  });

  it('refuses a name a workspace label has (E20), moving nothing', async () => {
    const m = memoryLabels();
    m.add({ name: 'Bug', teamId: null });
    const group = m.add({ name: 'Bug' });
    const before = m.snapshot();
    const error = await failure(move(m, group));
    expect(error).toMatchObject({ code: 'CONFLICT' });
    expect(error.message).toBe(
      'A workspace label named Bug already exists. Rename this label first.',
    );
    expect(m.snapshot()).toBe(before);
  });

  it('refuses a label of another team, and one that is already a workspace label', async () => {
    const m = memoryLabels();
    const theirs = m.add({ name: 'Theirs', teamId: m.des.id });
    expect((await failure(move(m, theirs))).message).toBe(
      'Theirs is not a label of ENG. Use the team the label belongs to.',
    );
    const shared = m.add({ name: 'Shared', teamId: null });
    expect(
      await failure(
        moveLabelToWorkspace(m.access, m.repo, {
          teamRef: 'ENG',
          team: m.eng,
          label: { id: shared.id, teamId: null },
        }),
      ),
    ).toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('refuses when the workspace is full (AC-13)', async () => {
    const m = memoryLabels();
    for (let i = 0; i < LABEL_LIMITS.perScope; i++) m.add({ name: `W${i}`, teamId: null });
    const row = m.add({ name: 'One more' });
    expect((await failure(move(m, row))).message).toBe(
      'The workspace can have at most 500 labels. Delete one first.',
    );
  });
});

// ---------------------------------------------------------------------------------------------
// AC-16: the optimistic row equals the server's row, apart from createdAt and updatedAt.

/** A store over the memory labels' rows, as the client holds them. */
function storeOf(m: MemoryLabels): OptimisticStore & { rows: Map<string, StoreRow> } {
  const rows = new Map<string, StoreRow>();
  for (const [id, r] of m.rows) rows.set(id, { ...r, groups: r.syncGroups });
  const teams: StoreRow[] = [m.eng, m.des].map((t) => ({
    id: t.id,
    key: t.key,
    groups: ['workspace'],
  }));
  const team = (ref: string) => teams.find((t) => t['key'] === ref || t['id'] === ref);
  return {
    rows,
    now: NOW,
    get: (model, id) => (model === 'Team' ? team(id) : rows.get(id)),
    find: (model, fields) =>
      model === 'Label'
        ? [...rows.values()].filter((r) =>
            Object.entries(fields).every(([field, value]) => r[field] === value),
          )
        : [],
    patch: (model, id, changes) => {
      const row = rows.get(id);
      if (model === 'Label' && row) rows.set(id, { ...row, ...changes });
    },
    insert: (model, row) => void (model === 'Label' && rows.set(row.id, row)),
    remove: (model, id) => void (model === 'Label' && rows.delete(id)),
    archive: () => undefined,
    unarchive: () => undefined,
  };
}

function comparable(row: StoreRow | undefined) {
  if (!row) return undefined;
  const { id, teamId, name, color, description, parentId, isGroup, exclusive, archivedAt } = row;
  return { id, teamId, name, color, description, parentId, isGroup, exclusive, archivedAt };
}

describe('optimistic equals the server (AC-16)', () => {
  it('for label.create: a label, a group, and a label in a group', async () => {
    const m = memoryLabels();
    const group = m.add({ name: 'Size', isGroup: true });
    const cases = [
      { name: 'Needs design', color: 'orange' as const, description: 'Mock-up first' },
      { name: 'Area', isGroup: true, exclusive: false },
      { name: 'Small', group: 'Size' },
    ];
    for (const extra of cases) {
      const store = storeOf(m);
      const id = randomUUID();
      labelCreate.optimistic?.(store, { id, team: 'ENG', ...extra });
      const row = await createLabel(m.access, m.repo, {
        id,
        teamRef: 'ENG',
        team: m.eng,
        name: extra.name,
        color: 'color' in extra ? extra.color : undefined,
        description: 'description' in extra ? extra.description : undefined,
        isGroup: 'isGroup' in extra ? extra.isGroup : undefined,
        exclusive: 'exclusive' in extra ? extra.exclusive : undefined,
        groupId: 'group' in extra ? group.id : undefined,
      });
      expect(comparable(store.rows.get(id))).toEqual(comparable({ ...row }));
    }
  });

  it('for label.update: rename, recolor, move into a group and out', async () => {
    const m = memoryLabels();
    const group = m.add({ name: 'Size', isGroup: true });
    const row = m.add({ name: 'Bug', description: 'Broken' });
    const steps = [
      { name: 'Defect', color: 'red' as const, description: '' },
      { group: 'Size' },
      { group: null },
    ];
    for (const step of steps) {
      const store = storeOf(m);
      labelUpdate.optimistic?.(store, { label: row.id, team: 'ENG', ...step });
      const updated = await updateLabel(m.access, m.repo, {
        label: ref(m.rows.get(row.id) ?? row),
        name: 'name' in step ? step.name : undefined,
        color: 'color' in step ? step.color : undefined,
        description: 'description' in step ? step.description : undefined,
        groupId: 'group' in step ? (step.group === null ? null : group.id) : undefined,
      });
      expect(comparable(store.rows.get(row.id))).toEqual(comparable({ ...updated }));
    }
  });
});
