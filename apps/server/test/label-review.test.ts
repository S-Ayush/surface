// PLAN-010 S3 review fixes (SPEC-010 §4.4, §5): a team label of another team than the one named,
// concurrent changes answered as CONFLICT rather than bad input, and the order the moving rows are
// locked in. Runs the rules on the in-memory scope, like `label-handlers.test.ts`.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SurfaceError } from '../src/executor/errors.js';
import {
  createLabel,
  deleteLabel,
  moveLabelToWorkspace,
  updateLabel,
  type LabelRow,
} from '../src/handlers/labels/core.js';
import { memoryLabels } from './support/memory-labels.js';

async function failure(run: Promise<unknown>): Promise<SurfaceError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof SurfaceError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const ref = (row: LabelRow) => ({ id: row.id, teamId: row.teamId });

describe('a team label of another team than the one named (SPEC-010 §5)', () => {
  it('refuses update and delete as moveToWorkspace does, writing nothing', async () => {
    const m = memoryLabels();
    const theirs = m.add({ name: 'Theirs', teamId: m.des.id });
    const updated = await failure(
      updateLabel(m.access, m.repo, { team: m.eng, label: ref(theirs), name: 'Mine' }),
    );
    expect(updated.code).toBe('INVALID_INPUT');
    expect(updated.details.issues?.[0]?.path).toEqual(['label']);
    const deleted = await failure(
      deleteLabel(m.access, m.repo, { team: m.eng, label: ref(theirs) }),
    );
    expect(deleted.code).toBe('INVALID_INPUT');
    expect(m.writes).toEqual([]);
    expect(m.rows.get(theirs.id)?.name).toBe('Theirs');
  });

  it('still lets a workspace label be named with a team, as the lookup falls back to it', async () => {
    const m = memoryLabels();
    const shared = m.add({ name: 'Bug', teamId: null });
    const updated = await updateLabel(m.access, m.repo, {
      team: m.eng,
      label: ref(shared),
      name: 'Defect',
    });
    expect(updated.name).toBe('Defect');
  });
});

describe('concurrent changes are CONFLICT, not bad input (SPEC-010 §4.4)', () => {
  it('a group moved to another scope since it was resolved is a gone group', async () => {
    const m = memoryLabels();
    const group = m.add({ name: 'Size', isGroup: true });
    const row = m.add({ name: 'Small' });
    // The executor resolved the group in ENG; it has since moved to the workspace.
    m.rows.set(group.id, { ...group, teamId: null });
    const gone = {
      code: 'CONFLICT',
      message: 'That label group was deleted. Choose another group.',
    };
    expect(
      await failure(
        updateLabel(m.access, m.repo, {
          label: ref(row),
          groupId: group.id,
          groupTeamId: m.eng.id,
        }),
      ),
    ).toMatchObject(gone);
    expect(
      await failure(
        createLabel(m.access, m.repo, {
          id: randomUUID(),
          teamRef: m.eng.key,
          team: m.eng,
          name: 'Other',
          groupId: group.id,
          groupTeamId: m.eng.id,
        }),
      ),
    ).toMatchObject(gone);
  });

  it('a group in another scope from the start is still bad input', async () => {
    const m = memoryLabels();
    const group = m.add({ name: 'Kind', isGroup: true, teamId: null });
    const row = m.add({ name: 'Small' });
    const error = await failure(
      updateLabel(m.access, m.repo, { label: ref(row), groupId: group.id, groupTeamId: null }),
    );
    expect(error.code).toBe('INVALID_INPUT');
  });

  it('a label whose team was deleted meanwhile is a gone label, not a TeamRef NOT_FOUND', async () => {
    const m = memoryLabels();
    const row = m.add({ name: 'Orphan', teamId: randomUUID() });
    const message = 'That label was deleted or moved. Reload and try again.';
    expect(
      await failure(updateLabel(m.access, m.repo, { teamRef: 'GHO', label: ref(row), name: 'X' })),
    ).toMatchObject({ code: 'CONFLICT', message });
    expect(
      await failure(deleteLabel(m.access, m.repo, { teamRef: 'GHO', label: ref(row) })),
    ).toMatchObject({ code: 'CONFLICT', message });
  });
});

describe('label.moveToWorkspace locks every moving row in ascending id order', () => {
  const LOW = '00000000-0000-7000-8000-000000000001';
  const HIGH = 'ffffffff-ffff-7fff-8fff-ffffffffffff';

  it('locks a child with a lower id before the named group', async () => {
    const m = memoryLabels();
    const group = m.add({ id: HIGH, name: 'Size', isGroup: true });
    m.add({ id: LOW, name: 'Small', parentId: group.id });
    await moveLabelToWorkspace(m.access, m.repo, {
      teamRef: 'ENG',
      team: m.eng,
      label: ref(group),
    });
    expect(m.calls.filter((c) => c.startsWith('lockLabel'))).toEqual([
      'lockLabel:Small',
      'lockLabel:Size',
    ]);
  });

  it('re-checks the named row once it is locked', async () => {
    const m = memoryLabels();
    const group = m.add({ id: HIGH, name: 'Size', isGroup: true });
    m.add({ id: LOW, name: 'Small', parentId: group.id });
    // Between the plan's read and the lock, the group stopped being a group.
    const access = {
      ...m.access,
      lockLabel: async (id: string) => {
        const row = await m.access.lockLabel(id);
        return row && id === group.id ? { ...row, isGroup: false } : row;
      },
    };
    const error = await failure(
      moveLabelToWorkspace(access, m.repo, { teamRef: 'ENG', team: m.eng, label: ref(group) }),
    );
    expect(error.code).toBe('CONFLICT');
    expect(m.writes).toEqual([]);
  });
});
