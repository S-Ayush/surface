// PLAN-010 S6, SPEC-010 AC-11 (archive and unarchive, group cascade, rename while archived),
// AC-16 (optimistic equals the server), E14 (archived group), E15 (the permission part lives in
// operations/src/ops/label.test.ts), and the lock order of §4.4. The rules run on an in-memory
// scope (`support/memory-labels.ts`); the `A`/`V` rows in the log are checked by
// `label-leak.int.test.ts`. E12 and E13 (an issue refusing an archived label) are PLAN-011 S4's
// code: no issue operation exists on this branch, so here a label archived with `label.archive`
// is checked to carry `archivedAt`, which is what S4 reads.
import { randomUUID } from 'node:crypto';
import {
  labelArchive,
  labelCreate,
  labelUnarchive,
  labelUpdate,
  type OptimisticStore,
  type StoreRow,
} from '@surface/operations';
import { describe, expect, it } from 'vitest';
import { SurfaceError } from '../src/executor/errors.js';
import {
  archiveLabel,
  createLabel,
  unarchiveLabel,
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

const ref = (row: LabelRow) => ({ id: row.id, teamId: row.teamId, name: row.name });
const archive = (m: MemoryLabels, row: LabelRow) =>
  archiveLabel(m.access, m.repo, { label: ref(row), teamRef: 'ENG', team: m.eng });
const unarchive = (m: MemoryLabels, row: LabelRow) =>
  unarchiveLabel(m.access, m.repo, { label: ref(row), teamRef: 'ENG', team: m.eng });
const live = (m: MemoryLabels, name: string) => m.byName(name).archivedAt === null;

describe('label.archive (AC-11)', () => {
  it('archives one label through the repo archive path, so an A is logged', async () => {
    const m = memoryLabels();
    const row = m.add({ name: 'Bug' });
    const done = await archive(m, row);
    expect(done.archivedAt).toEqual(NOW);
    expect(m.writes).toEqual([{ action: 'archive', id: row.id, model: 'Label' }]);
  });

  it('archives a label inside a group alone, leaving the group and its siblings', async () => {
    const m = memoryLabels();
    const group = m.add({ name: 'Size', isGroup: true });
    const small = m.add({ name: 'Small', parentId: group.id });
    m.add({ name: 'Large', parentId: group.id });
    await archive(m, small);
    expect(live(m, 'Size')).toBe(true);
    expect(live(m, 'Large')).toBe(true);
    expect(live(m, 'Small')).toBe(false);
  });

  it('archives a group with all its labels in one call, writing only rows not archived yet (D26)', async () => {
    const m = memoryLabels();
    const group = m.add({ name: 'Size', isGroup: true });
    m.add({ name: 'Small', parentId: group.id });
    const old = m.add({ name: 'Old', parentId: group.id, archivedAt: new Date('2026-01-01') });
    m.add({ name: 'Other' });
    const done = await archive(m, group);
    expect(done.id).toBe(group.id);
    expect(live(m, 'Size') || live(m, 'Small')).toBe(false);
    expect(live(m, 'Other')).toBe(true);
    expect(m.rows.get(old.id)?.archivedAt).toEqual(new Date('2026-01-01'));
    expect(m.writes).toHaveLength(2);
    expect(m.writes.map((w) => w.id)).toEqual(m.writes.map((w) => w.id).sort());
  });

  it('archiving an archived label changes nothing and writes nothing', async () => {
    const m = memoryLabels();
    const row = m.add({ name: 'Bug', archivedAt: new Date('2026-01-01') });
    const done = await archive(m, row);
    expect(done.archivedAt).toEqual(new Date('2026-01-01'));
    expect(m.writes).toEqual([]);
  });

  it('works on a workspace label, locking the workspace row', async () => {
    const m = memoryLabels();
    const row = m.add({ name: 'Chore', teamId: null });
    await archiveLabel(m.access, m.repo, { label: ref(row) });
    expect(m.calls.slice(0, 3)).toEqual(['lockWorkspace', 'lockLabel:Chore', 'scopeLabels']);
    expect(live(m, 'Chore')).toBe(false);
  });

  it('locks the scope row, then the label, then reads the scope (§4.4)', async () => {
    const m = memoryLabels();
    const row = m.add({ name: 'Bug' });
    await archive(m, row);
    expect(m.calls).toEqual(['lockTeam', 'lockLabel:Bug', 'scopeLabels']);
  });

  it('is a CONFLICT when the label was deleted or moved since it was resolved', async () => {
    const m = memoryLabels();
    const row = m.add({ name: 'Bug' });
    m.rows.delete(row.id);
    expect(await failure(archive(m, row))).toMatchObject({ code: 'CONFLICT' });
    const moved = m.add({ name: 'Moved', teamId: null });
    const stale = { id: moved.id, teamId: m.eng.id };
    expect(
      await failure(archiveLabel(m.access, m.repo, { label: stale, teamRef: 'ENG', team: m.eng })),
    ).toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses a team label of another team than the one named', async () => {
    const m = memoryLabels();
    const row = m.add({ name: 'Bug', teamId: m.des.id });
    const error = await failure(
      archiveLabel(m.access, m.repo, { label: ref(row), teamRef: 'ENG', team: m.eng }),
    );
    expect(error).toMatchObject({ code: 'INVALID_INPUT' });
    expect(m.writes).toEqual([]);
  });

  it('leaves an archived label renameable and recolorable, and E13: it carries archivedAt', async () => {
    const m = memoryLabels();
    const row = m.add({ name: 'Bug' });
    const done = await archive(m, row);
    expect(done.archivedAt).not.toBeNull();
    const renamed = await updateLabel(m.access, m.repo, {
      label: ref(done),
      name: 'Defect',
      color: 'red',
    });
    expect(renamed).toMatchObject({ name: 'Defect', color: 'red', archivedAt: NOW });
  });

  it('still counts archived labels towards the clash check, so a name stays taken', async () => {
    const m = memoryLabels();
    const row = m.add({ name: 'Bug' });
    await archive(m, row);
    const clash = await failure(
      createLabel(m.access, m.repo, {
        id: randomUUID(),
        teamRef: 'ENG',
        team: m.eng,
        name: 'bug',
      }),
    );
    expect(clash).toMatchObject({ code: 'CONFLICT' });
  });
});

describe('label.unarchive (AC-11, E14)', () => {
  it('restores one label through the repo unarchive path, so a V is logged', async () => {
    const m = memoryLabels();
    const row = m.add({ name: 'Bug', archivedAt: NOW });
    const done = await unarchive(m, row);
    expect(done.archivedAt).toBeNull();
    expect(m.writes).toEqual([{ action: 'unarchive', id: row.id, model: 'Label' }]);
  });

  it('unarchives a group with all its labels, archived or not before (D26)', async () => {
    const m = memoryLabels();
    const group = m.add({ name: 'Size', isGroup: true, archivedAt: NOW });
    m.add({ name: 'Small', parentId: group.id, archivedAt: NOW });
    m.add({ name: 'Large', parentId: group.id });
    await unarchive(m, group);
    expect(['Size', 'Small', 'Large'].every((n) => live(m, n))).toBe(true);
    expect(m.writes).toHaveLength(2);
  });

  it('unarchiving a label that is not archived changes nothing', async () => {
    const m = memoryLabels();
    const row = m.add({ name: 'Bug' });
    await unarchive(m, row);
    expect(m.writes).toEqual([]);
  });

  it('refuses to unarchive a label in an archived group (E14)', async () => {
    const m = memoryLabels();
    const group = m.add({ name: 'Size', isGroup: true, archivedAt: NOW });
    const small = m.add({ name: 'Small', parentId: group.id, archivedAt: NOW });
    const error = await failure(unarchive(m, small));
    expect(error).toMatchObject({ code: 'INVALID_INPUT' });
    expect(error.message).toBe('The Size group is archived. Unarchive the group first.');
    expect(m.writes).toEqual([]);
  });

  it('unarchives a label whose group is live, re-reading the group FOR KEY SHARE', async () => {
    const m = memoryLabels();
    const group = m.add({ name: 'Size', isGroup: true });
    const small = m.add({ name: 'Small', parentId: group.id, archivedAt: NOW });
    await unarchive(m, small);
    expect(live(m, 'Small')).toBe(true);
    expect(m.calls).toEqual(['lockTeam', 'lockLabel:Small', 'shareLabel:Size', 'scopeLabels']);
  });

  it('is a CONFLICT when the group was deleted since', async () => {
    const m = memoryLabels();
    const small = m.add({ name: 'Small', parentId: randomUUID(), archivedAt: NOW });
    expect(await failure(unarchive(m, small))).toMatchObject({ code: 'CONFLICT' });
  });

  it('keeps E14 for create and update: no new label in, and no move into, an archived group', async () => {
    const m = memoryLabels();
    const group = m.add({ name: 'Size', isGroup: true });
    const loose = m.add({ name: 'Loose' });
    await archive(m, group);
    const words = 'The Size group is archived. Unarchive the group first.';
    const created = createLabel(m.access, m.repo, {
      id: randomUUID(),
      teamRef: 'ENG',
      team: m.eng,
      name: 'Medium',
      groupId: group.id,
    });
    expect((await failure(created)).message).toBe(words);
    const moved = updateLabel(m.access, m.repo, { label: ref(loose), groupId: group.id });
    expect((await failure(moved)).message).toBe(words);
  });
});

// ---------------------------------------------------------------------------------------------
// AC-16: the optimistic rows equal the server's, apart from updatedAt.

function storeOf(m: MemoryLabels): OptimisticStore & { rows: Map<string, StoreRow> } {
  const rows = new Map<string, StoreRow>();
  for (const [id, r] of m.rows)
    rows.set(id, { ...r, archivedAt: r.archivedAt?.toISOString() ?? null, groups: r.syncGroups });
  const teams: StoreRow[] = [m.eng, m.des].map((t) => ({ id: t.id, key: t.key, groups: [] }));
  const team = (r: string) => teams.find((t) => t['key'] === r || t['id'] === r);
  const patch = (id: string, changes: Record<string, unknown>) => {
    const row = rows.get(id);
    if (row) rows.set(id, { ...row, ...changes });
  };
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
    patch: (_model, id, changes) => patch(id, changes),
    insert: (_model, row) => void rows.set(row.id, row),
    remove: (_model, id) => void rows.delete(id),
    archive: (_model, id) => patch(id, { archivedAt: NOW.toISOString() }),
    unarchive: (_model, id) => patch(id, { archivedAt: null }),
  };
}

const archivedOf = (row: StoreRow | undefined) => {
  const at = row?.['archivedAt'];
  return at === null || at === undefined
    ? null
    : typeof at === 'string'
      ? new Date(at).getTime()
      : Number.NaN;
};

describe('optimistic equals the server (AC-16)', () => {
  it('for archive and unarchive of a label and of a group with its labels', async () => {
    const m = memoryLabels();
    const group = m.add({ name: 'Size', isGroup: true });
    m.add({ name: 'Small', parentId: group.id });
    m.add({ name: 'Large', parentId: group.id, archivedAt: NOW });
    const lone = m.add({ name: 'Bug' });
    for (const [op, run, target] of [
      [labelArchive, archive, lone],
      [labelArchive, archive, group],
      [labelUnarchive, unarchive, group],
      [labelUnarchive, unarchive, lone],
    ] as const) {
      const store = storeOf(m);
      op.optimistic?.(store, { label: target.id, team: 'ENG' });
      await run(m, m.rows.get(target.id) ?? target);
      for (const [id, row] of m.rows) {
        expect(archivedOf(store.rows.get(id)), `${op.name} ${row.name}`).toBe(
          row.archivedAt === null ? null : row.archivedAt.getTime(),
        );
      }
    }
  });

  it('predicts nothing for E14 and for an unknown label, like the server refuses', () => {
    const m = memoryLabels();
    const group = m.add({ name: 'Size', isGroup: true, archivedAt: NOW });
    const small = m.add({ name: 'Small', parentId: group.id, archivedAt: NOW });
    const store = storeOf(m);
    labelUnarchive.optimistic?.(store, { label: small.id, team: 'ENG' });
    labelArchive.optimistic?.(store, { label: randomUUID(), team: 'ENG' });
    expect(archivedOf(store.rows.get(small.id))).not.toBeNull();
  });

  it('keeps label.create and label.update unchanged by the archive operations', () => {
    expect(labelCreate.name).toBe('label.create');
    expect(labelUpdate.name).toBe('label.update');
  });
});
