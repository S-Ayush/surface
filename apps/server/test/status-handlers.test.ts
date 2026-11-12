// PLAN-010 S2, SPEC-010 AC-1, AC-2, AC-3, AC-5 (no issue table yet: the counts are given),
// AC-13 (status limit), E3 and E4 (lock order and anchors), E17 (first half), AC-16 (the client's
// optimistic row equals the server's). The rules run on an in-memory workflow
// (`support/memory-workflow.ts`); the SQL is covered by the registry contract and leak tests.
import { randomUUID } from 'node:crypto';
import { STATUS_LIMIT } from '@surface/domain';
import {
  statusCreate,
  statusReorder,
  type OptimisticStore,
  type StoreRow,
} from '@surface/operations';
import { describe, expect, it } from 'vitest';
import { SurfaceError } from '../src/executor/errors.js';
import {
  createStatus,
  deleteStatus,
  reorderStatus,
  updateStatus,
} from '../src/handlers/statuses/core.js';
import { memoryWorkflow, type MemoryWorkflow } from './support/memory-workflow.js';

const NOW = new Date('2026-11-12T10:00:00Z');

function target(w: MemoryWorkflow) {
  return { teamRef: 'ENG', team: { id: w.team.id, key: w.team.key } };
}

async function create(
  w: MemoryWorkflow,
  name: string,
  category: 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled',
  extra: { after?: string; color?: 'red'; description?: string } = {},
) {
  return createStatus(w.access, w.repo, {
    id: randomUUID(),
    ...target(w),
    name,
    category,
    ...extra,
  });
}

async function failure(run: Promise<unknown>): Promise<SurfaceError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof SurfaceError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

/** A category's names in order, byte order of `position`. */
function names(w: MemoryWorkflow, category: string): string[] {
  return [...w.rows.values()]
    .filter((r) => r.category === category)
    .sort((a, b) => (a.position < b.position ? -1 : 1))
    .map((r) => r.name);
}

describe('status.create (AC-1)', () => {
  it('adds the status at the end of its category with the category color', async () => {
    const w = memoryWorkflow();
    const row = await create(w, 'QA', 'started');
    expect(row).toMatchObject({ name: 'QA', category: 'started', color: 'yellow' });
    expect(row.description).toBeNull();
    expect(names(w, 'started')).toEqual(['In Progress', 'In Review', 'QA']);
  });

  it('puts it right after `after`, and keeps a given color and description', async () => {
    const w = memoryWorkflow();
    const after = w.byName('In Progress').id;
    const row = await create(w, 'QA', 'started', { after, color: 'red', description: 'Testing' });
    expect(names(w, 'started')).toEqual(['In Progress', 'QA', 'In Review']);
    expect(row).toMatchObject({ color: 'red', description: 'Testing' });
  });

  it('refuses a name another status has, in any case, with CONFLICT on name', async () => {
    const w = memoryWorkflow();
    const error = await failure(create(w, 'in review', 'started'));
    expect(error.code).toBe('CONFLICT');
    expect(error.details.issues?.[0]?.path).toEqual(['name']);
    expect(w.writes).toEqual([]);
  });

  it('allows the name of a status that was deleted (E2)', async () => {
    const w = memoryWorkflow();
    await deleteStatus(w.access, w.repo, { ...target(w), statusId: w.byName('In Review').id });
    await expect(create(w, 'In Review', 'started')).resolves.toMatchObject({ name: 'In Review' });
  });

  it('refuses an after status of another category with INVALID_INPUT on after', async () => {
    const w = memoryWorkflow();
    const error = await failure(create(w, 'QA', 'started', { after: w.byName('Done').id }));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.details.issues?.[0]?.path).toEqual(['after']);
  });

  it('answers CONFLICT when the after status vanished after it was resolved (E4)', async () => {
    const w = memoryWorkflow();
    const error = await failure(create(w, 'QA', 'started', { after: randomUUID() }));
    expect(error.code).toBe('CONFLICT');
    expect(w.writes).toEqual([]);
  });

  it('refuses the 51st status with the limit in the message (AC-13)', async () => {
    const w = memoryWorkflow();
    while (w.rows.size < STATUS_LIMIT) await create(w, `Extra ${w.rows.size}`, 'started');
    const error = await failure(create(w, 'One too many', 'started'));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe('A team can have at most 50 statuses. Delete one first.');
  });

  it('is NOT_FOUND for a team that is gone, worded like an unknown one', async () => {
    const w = memoryWorkflow();
    const error = await failure(
      createStatus(w.access, w.repo, {
        id: randomUUID(),
        teamRef: 'GONE',
        team: { id: randomUUID(), key: 'GONE' },
        name: 'QA',
        category: 'started',
      }),
    );
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('Team "GONE" not found. Use a team key like ENG, or a team id.');
  });

  it('locks the team row first, then reads, then locks the anchor (E3)', async () => {
    const w = memoryWorkflow();
    await create(w, 'QA', 'started', { after: w.byName('In Progress').id });
    expect(w.calls).toEqual(['lockTeam', 'statuses', 'shareStatus:In Progress']);
  });
});

describe('status.update (AC-2)', () => {
  it('renames, recolors and describes, and an empty description clears it', async () => {
    const w = memoryWorkflow();
    const statusId = w.byName('In Review').id;
    const row = await updateStatus(w.access, w.repo, {
      ...target(w),
      statusId,
      name: 'Code review',
      color: 'red',
      description: 'Waiting for eyes',
    });
    expect(row).toMatchObject({ name: 'Code review', color: 'red', category: 'started' });
    const cleared = await updateStatus(w.access, w.repo, {
      ...target(w),
      statusId,
      description: '',
    });
    expect(cleared.description).toBeNull();
  });

  it('lets Triage be renamed (§4.1)', async () => {
    const w = memoryWorkflow();
    const row = await updateStatus(w.access, w.repo, {
      ...target(w),
      statusId: w.byName('Triage').id,
      name: 'Inbox',
    });
    expect(row.name).toBe('Inbox');
  });

  it('refuses Duplicate with the system message', async () => {
    const w = memoryWorkflow();
    const error = await failure(
      updateStatus(w.access, w.repo, {
        ...target(w),
        statusId: w.byName('Duplicate').id,
        color: 'red',
      }),
    );
    expect(error).toMatchObject({
      code: 'INVALID_INPUT',
      message: "Duplicate is a system status and can't be changed.",
    });
  });

  it('refuses another status’s name with CONFLICT on name, but not its own in another case', async () => {
    const w = memoryWorkflow();
    const statusId = w.byName('In Review').id;
    const error = await failure(
      updateStatus(w.access, w.repo, { ...target(w), statusId, name: 'DONE' }),
    );
    expect(error.code).toBe('CONFLICT');
    expect(error.details.issues?.[0]?.path).toEqual(['name']);
    const row = await updateStatus(w.access, w.repo, { ...target(w), statusId, name: 'IN REVIEW' });
    expect(row.name).toBe('IN REVIEW');
  });

  it('writes nothing when nothing differs, and never writes the category', async () => {
    const w = memoryWorkflow();
    const statusId = w.byName('In Review').id;
    await updateStatus(w.access, w.repo, { ...target(w), statusId, name: 'In Review' });
    expect(w.writes).toEqual([]);
    await updateStatus(w.access, w.repo, { ...target(w), statusId, color: 'red' });
    expect(w.writes).toEqual([{ action: 'update', id: statusId, fields: ['color'] }]);
  });

  it('answers CONFLICT when the status was deleted after it was resolved', async () => {
    const w = memoryWorkflow();
    const error = await failure(
      updateStatus(w.access, w.repo, { ...target(w), statusId: randomUUID(), name: 'X' }),
    );
    expect(error).toMatchObject({
      code: 'CONFLICT',
      message: 'That status was deleted. Choose another status.',
    });
  });
});

describe('status.reorder (AC-3)', () => {
  it('moves one status and writes only that row, only its position', async () => {
    const w = memoryWorkflow();
    const review = w.byName('In Review');
    await reorderStatus(w.access, w.repo, {
      ...target(w),
      statusId: review.id,
      before: w.byName('In Progress').id,
    });
    expect(names(w, 'started')).toEqual(['In Review', 'In Progress']);
    expect(w.writes).toEqual([{ action: 'update', id: review.id, fields: ['position'] }]);
  });

  it('writes nothing when the status already sits there', async () => {
    const w = memoryWorkflow();
    await reorderStatus(w.access, w.repo, {
      ...target(w),
      statusId: w.byName('In Review').id,
      after: w.byName('In Progress').id,
    });
    expect(w.writes).toEqual([]);
  });

  it('refuses an anchor in another category, and itself, with INVALID_INPUT', async () => {
    const w = memoryWorkflow();
    const review = w.byName('In Review').id;
    const other = await failure(
      reorderStatus(w.access, w.repo, {
        ...target(w),
        statusId: review,
        after: w.byName('Done').id,
      }),
    );
    expect(other.code).toBe('INVALID_INPUT');
    const itself = await failure(
      reorderStatus(w.access, w.repo, { ...target(w), statusId: review, before: review }),
    );
    expect(itself.code).toBe('INVALID_INPUT');
    expect(w.writes).toEqual([]);
  });

  it('refuses Triage and Duplicate, which have nothing to reorder against', async () => {
    const w = memoryWorkflow();
    for (const name of ['Triage', 'Duplicate']) {
      const error = await failure(
        reorderStatus(w.access, w.repo, {
          ...target(w),
          statusId: w.byName(name).id,
          before: w.byName('Backlog').id,
        }),
      );
      expect(error.code).toBe('INVALID_INPUT');
    }
  });

  it('answers CONFLICT when the anchor was deleted meanwhile (E4)', async () => {
    const w = memoryWorkflow();
    const error = await failure(
      reorderStatus(w.access, w.repo, {
        ...target(w),
        statusId: w.byName('In Review').id,
        before: randomUUID(),
      }),
    );
    expect(error.code).toBe('CONFLICT');
  });

  it('locks the team, then the status, then the anchor (E3)', async () => {
    const w = memoryWorkflow();
    await reorderStatus(w.access, w.repo, {
      ...target(w),
      statusId: w.byName('In Review').id,
      before: w.byName('In Progress').id,
    });
    expect(w.calls.slice(0, 3)).toEqual([
      'lockTeam',
      'lockStatus:In Review',
      'shareStatus:In Progress',
    ]);
  });
});

describe('status.delete (AC-5, E3, E17)', () => {
  const del = (w: MemoryWorkflow, name: string) =>
    deleteStatus(w.access, w.repo, { ...target(w), statusId: w.byName(name).id });

  it('deletes an empty status and the row is gone', async () => {
    const w = memoryWorkflow();
    const id = w.byName('In Review').id;
    await del(w, 'In Review');
    expect(w.rows.has(id)).toBe(false);
    expect(w.writes).toEqual([{ action: 'purge', id }]);
  });

  it('refuses Triage and Duplicate, the default, and the last of a category', async () => {
    const w = memoryWorkflow();
    expect((await failure(del(w, 'Triage'))).message).toBe(
      "Triage is a system status and can't be deleted.",
    );
    expect((await failure(del(w, 'Duplicate'))).code).toBe('CONFLICT');
    expect((await failure(del(w, 'Backlog'))).message).toBe(
      "Can't delete the default status. Make another status the default first.",
    );
    expect((await failure(del(w, 'Done'))).message).toBe(
      'Every team needs at least one Completed status. Add another before deleting this one.',
    );
    expect(w.writes).toEqual([]);
  });

  it('refuses the team’s auto-close status (SPEC-015)', async () => {
    const w = memoryWorkflow();
    const extra = await create(w, 'Won’t do', 'canceled');
    w.team.autoCloseStatusId = extra.id;
    const error = await failure(del(w, 'Won’t do'));
    expect(error.message).toBe(
      'This status closes stale issues. Choose another one in Settings → Automations first.',
    );
  });

  it('refuses a status that has issues, and counts archived and recently deleted ones', async () => {
    const w = memoryWorkflow();
    w.issues.set(w.byName('In Review').id, { live: 1, archived: 1, recentlyDeleted: 1 });
    const error = await failure(del(w, 'In Review'));
    expect(error.code).toBe('CONFLICT');
    expect(error.message).toBe(
      'Can\'t delete the "In Review" status. It has 3 issues (2 archived or recently deleted). Move them to another status first.',
    );
    expect(w.writes).toEqual([]);
  });

  it('lets exactly one of two deletes of the last two statuses of a category commit (E3)', async () => {
    const w = memoryWorkflow();
    await del(w, 'In Progress');
    const error = await failure(del(w, 'In Review'));
    expect(error.message).toBe(
      'Every team needs at least one Started status. Add another before deleting this one.',
    );
    expect(names(w, 'started')).toEqual(['In Review']);
  });

  it('locks the team row, then the status row, then reads the workflow (E3)', async () => {
    const w = memoryWorkflow();
    await del(w, 'In Review');
    expect(w.calls).toEqual(['lockTeam', 'lockStatus:In Review', 'statuses']);
  });

  it('answers CONFLICT when the status is already gone', async () => {
    const w = memoryWorkflow();
    const error = await failure(
      deleteStatus(w.access, w.repo, { ...target(w), statusId: randomUUID() }),
    );
    expect(error.message).toBe('That status was deleted. Choose another status.');
  });
});

// ---------------------------------------------------------------------------------------------
// AC-16: the optimistic row equals the server's row, apart from createdAt and updatedAt.

/** A store over the memory workflow's rows, as the client holds them. */
function storeOf(w: MemoryWorkflow): OptimisticStore & { rows: Map<string, StoreRow> } {
  const rows = new Map<string, StoreRow>();
  for (const [id, r] of w.rows) {
    rows.set(id, { ...r, groups: r.syncGroups });
  }
  const team: StoreRow = {
    id: w.team.id,
    key: w.team.key,
    groups: ['workspace'],
    defaultStatusId: w.team.defaultStatusId,
  };
  return {
    rows,
    now: NOW,
    get: (model, ref) =>
      model === 'Team' && (ref === 'ENG' || ref === w.team.id) ? team : undefined,
    find: (model, fields) =>
      model === 'WorkflowStatus'
        ? [...rows.values()].filter((r) =>
            Object.entries(fields).every(([field, value]) => r[field] === value),
          )
        : [],
    patch: (model, ref, changes) => {
      const row = rows.get(ref);
      if (model === 'WorkflowStatus' && row) rows.set(ref, { ...row, ...changes });
    },
    insert: (model, row) => void (model === 'WorkflowStatus' && rows.set(row.id, row)),
    remove: (model, ref) => void (model === 'WorkflowStatus' && rows.delete(ref)),
    archive: () => undefined,
    unarchive: () => undefined,
  };
}

function comparable(row: StoreRow | undefined) {
  if (!row) return undefined;
  const { id, teamId, name, category, color, description, position } = row;
  return { id, teamId, name, category, color, description, position };
}

describe('optimistic equals the server (AC-16)', () => {
  it('for status.create at the end and after a status', async () => {
    for (const after of [undefined, 'In Progress']) {
      const w = memoryWorkflow();
      const store = storeOf(w);
      const id = randomUUID();
      const input = {
        id,
        team: 'ENG',
        name: 'QA',
        category: 'started' as const,
        ...(after === undefined ? {} : { after }),
      };
      statusCreate.optimistic?.(store, input);
      const row = await createStatus(w.access, w.repo, {
        id,
        ...target(w),
        name: 'QA',
        category: 'started',
        after: after === undefined ? undefined : w.byName(after).id,
      });
      expect(comparable(store.rows.get(id))).toEqual(comparable({ ...row }));
    }
  });

  it('for status.reorder before and after', async () => {
    for (const side of ['before', 'after'] as const) {
      const w = memoryWorkflow();
      const store = storeOf(w);
      const extra = await create(w, 'QA', 'started');
      store.rows.set(extra.id, { ...extra, groups: ['workspace'] });
      const input = { team: 'ENG', status: 'QA', [side]: 'In Progress' };
      statusReorder.optimistic?.(store, input);
      const row = await reorderStatus(w.access, w.repo, {
        ...target(w),
        statusId: extra.id,
        [side]: w.byName('In Progress').id,
      });
      expect(comparable(store.rows.get(extra.id))).toEqual(comparable({ ...row }));
    }
  });
});
