// PLAN-010 S4, SPEC-010 AC-7 (default status accepts only Backlog or Unstarted of the same team;
// the estimate settings need no issue), AC-14 (a status of another team is never this team's
// default), AC-16 (the client's optimistic row equals the server's, in
// packages/operations/src/ops/team.test.ts), E5 (no issue read or written) and E17 (the two sequential orders against
// `status.delete`; a concurrent two-connection test waits for the testing hold to lift). The rules run on the in-memory workflow
// (`support/memory-workflow.ts`); the SQL is covered by the registry contract test.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SurfaceError } from '../src/executor/errors.js';
import { createStatus, deleteStatus, setDefaultStatus } from '../src/handlers/statuses/core.js';
import { setEstimates, type TeamSettingsRow } from '../src/handlers/teams/estimates.js';
import type { Repo } from '../src/sync/repo.js';
import { memoryWorkflow, type MemoryWorkflow } from './support/memory-workflow.js';

const NOW = new Date('2026-11-13T10:00:00Z');

function scope(w: MemoryWorkflow) {
  return { teamRef: 'ENG', team: { id: w.team.id, key: w.team.key } };
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

describe('team.setDefaultStatus (AC-7)', () => {
  it('accepts a Backlog or Unstarted status and writes only the pointer', async () => {
    const w = memoryWorkflow();
    const todo = w.byName('Todo');
    const { changed } = await setDefaultStatus(w.access, w.repo, {
      ...scope(w),
      statusId: todo.id,
    });
    expect(changed?.from).not.toBe(todo.id);
    expect(w.team.defaultStatusId).toBe(todo.id);
    expect(w.writes).toEqual([{ action: 'update', id: w.team.id, fields: ['defaultStatusId'] }]);
    // And back to Backlog, the other accepted category.
    await setDefaultStatus(w.access, w.repo, { ...scope(w), statusId: w.byName('Backlog').id });
    expect(w.team.defaultStatusId).toBe(w.byName('Backlog').id);
  });

  it('refuses every other category with INVALID_INPUT on status, changing nothing (INV-05)', async () => {
    const w = memoryWorkflow();
    const before = w.snapshot();
    const others = [...w.rows.values()].filter(
      (r) => r.category !== 'backlog' && r.category !== 'unstarted',
    );
    expect(new Set(others.map((r) => r.category))).toEqual(
      new Set(['triage', 'started', 'completed', 'canceled', 'duplicate']),
    );
    for (const status of others) {
      const error = await failure(
        setDefaultStatus(w.access, w.repo, { ...scope(w), statusId: status.id }),
      );
      expect(error.code, status.name).toBe('INVALID_INPUT');
      expect(error.details.issues?.[0]?.path).toEqual(['status']);
    }
    expect(w.snapshot()).toBe(before);
    expect(w.writes).toEqual([]);
  });

  it('writes nothing when the status already is the default', async () => {
    const w = memoryWorkflow();
    const result = await setDefaultStatus(w.access, w.repo, {
      ...scope(w),
      statusId: w.team.defaultStatusId,
    });
    expect(result.changed).toBeUndefined();
    expect(w.writes).toEqual([]);
  });

  it('takes the team lock first, then re-reads the status FOR KEY SHARE', async () => {
    const w = memoryWorkflow();
    await setDefaultStatus(w.access, w.repo, { ...scope(w), statusId: w.byName('Todo').id });
    expect(w.calls).toEqual(['lockTeam', 'shareStatus:Todo']);
  });

  it('is NOT_FOUND for a status of another team, even for an id the resolver passed (AC-14)', async () => {
    const w = memoryWorkflow();
    const todo = w.byName('Todo');
    w.rows.set(todo.id, { ...todo, teamId: randomUUID() });
    const error = await failure(
      setDefaultStatus(w.access, w.repo, { ...scope(w), statusId: todo.id }),
    );
    expect(error.code).toBe('NOT_FOUND');
    expect(w.writes).toEqual([]);
  });

  // E17: the team row lock serialises the two operations.
  it('is CONFLICT when status.delete ran before it (E17, delete then set)', async () => {
    const w = memoryWorkflow();
    const todo = w.byName('Todo');
    // Todo is the only Unstarted status, so add another or the delete is refused (INV-04).
    await createStatus(w.access, w.repo, {
      id: randomUUID(),
      ...scope(w),
      name: 'Ready',
      category: 'unstarted',
    });
    await deleteStatus(w.access, w.repo, { ...scope(w), statusId: todo.id });
    const error = await failure(
      setDefaultStatus(w.access, w.repo, { ...scope(w), statusId: todo.id }),
    );
    expect(error.code).toBe('CONFLICT');
    expect(w.team.defaultStatusId).not.toBe(todo.id);
  });

  it('makes status.delete refuse the status when setDefaultStatus ran before it (E17, set then delete)', async () => {
    const w = memoryWorkflow();
    const todo = w.byName('Todo');
    await setDefaultStatus(w.access, w.repo, { ...scope(w), statusId: todo.id });
    const error = await failure(deleteStatus(w.access, w.repo, { ...scope(w), statusId: todo.id }));
    expect(error.code).toBe('CONFLICT');
    expect(w.rows.has(todo.id)).toBe(true);
  });
});

function teamRow(over: Partial<TeamSettingsRow> = {}): TeamSettingsRow {
  return {
    id: randomUUID(),
    key: 'ENG',
    name: 'Engineering',
    icon: null,
    color: 'blue',
    timezone: 'UTC',
    private: false,
    defaultStatusId: randomUUID(),
    estimateScale: 'off',
    estimateExtended: false,
    estimateAllowZero: false,
    estimateCountUnestimatedAsOne: true,
    syncGroups: ['workspace'],
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    ...over,
  } as TeamSettingsRow;
}

/** Only `Team` writes are expected: anything else, an issue included, fails the test (E5). */
function estimateHarness(team: TeamSettingsRow | undefined) {
  const writes: { model: string; patch: Record<string, unknown> }[] = [];
  const calls: string[] = [];
  const repo = {
    update(model: string, id: string, patch: Record<string, unknown>) {
      if (model !== 'Team') throw new Error(`unexpected write to ${model}`);
      writes.push({ model, patch });
      return Promise.resolve({ ...team, ...patch, id } as TeamSettingsRow);
    },
  } as unknown as Repo;
  const access = {
    lockTeam: (id: string) => {
      calls.push(`lockTeam:${id === team?.id ? 'team' : id}`);
      return Promise.resolve(id === team?.id ? team : undefined);
    },
  };
  return { writes, calls, repo, access };
}

describe('team.setEstimates (AC-7, E5)', () => {
  it('writes only the settings that differ and reports them', async () => {
    const team = teamRow({ estimateScale: 'linear' });
    const h = estimateHarness(team);
    const { team: row, changes } = await setEstimates(h.access, h.repo, {
      teamRef: 'ENG',
      teamId: team.id,
      scale: 'linear',
      extended: true,
      allowZero: false,
    });
    expect(h.writes).toEqual([{ model: 'Team', patch: { estimateExtended: true } }]);
    expect(changes).toEqual({ estimateExtended: { from: false, to: true } });
    expect(row.estimateExtended).toBe(true);
  });

  it('writes nothing when no setting differs', async () => {
    const team = teamRow();
    const h = estimateHarness(team);
    const result = await setEstimates(h.access, h.repo, {
      teamRef: 'ENG',
      teamId: team.id,
      scale: 'off',
      countUnestimatedAsOne: true,
    });
    expect(h.writes).toEqual([]);
    expect(result.changes).toEqual({});
  });

  it('turns estimates off and keeps the other options stored (D21, E5)', async () => {
    const team = teamRow({ estimateScale: 'fibonacci', estimateExtended: true });
    const h = estimateHarness(team);
    await setEstimates(h.access, h.repo, { teamRef: 'ENG', teamId: team.id, scale: 'off' });
    expect(h.writes).toEqual([{ model: 'Team', patch: { estimateScale: 'off' } }]);
  });

  it('takes the team row lock and touches no other model (E5)', async () => {
    const team = teamRow();
    const h = estimateHarness(team);
    await setEstimates(h.access, h.repo, {
      teamRef: 'ENG',
      teamId: team.id,
      scale: 'tshirt',
      allowZero: true,
      countUnestimatedAsOne: false,
    });
    expect(h.calls).toEqual(['lockTeam:team']);
    expect(h.writes.map((w) => w.model)).toEqual(['Team']);
  });

  it('is NOT_FOUND, worded like an unknown team, when the team vanished', async () => {
    const h = estimateHarness(undefined);
    const error = await failure(
      setEstimates(h.access, h.repo, { teamRef: 'ENG', teamId: randomUUID(), scale: 'linear' }),
    );
    expect(error.code).toBe('NOT_FOUND');
    expect(h.writes).toEqual([]);
  });
});
