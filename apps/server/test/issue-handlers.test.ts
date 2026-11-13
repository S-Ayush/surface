// PLAN-011 S4, SPEC-011: AC-1 (validation of every §4.1 field, defaults), AC-3 (side effects in
// the handler), AC-4 (label rules on the re-read rows), AC-7 (optimistic equals the server, apart
// from the number and sortOrder), AC-15 and E19/E22 (re-read CONFLICT), AC-20 (key locks before the
// issue lock, in id order), AC-23 (archived and deleted issues refused, even a no-op), E8, E12,
// and SPEC-010 E12/E13 (archived labels). The rules run on an in-memory workspace
// (`support/memory-issues.ts`); the SQL is covered by the registry contract and leak tests.
import { randomUUID } from 'node:crypto';
import { issueCreate, issueUpdate, type OptimisticStore, type StoreRow } from '@surface/operations';
import { describe, expect, it } from 'vitest';
import { SurfaceError } from '../src/executor/errors.js';
import {
  createIssue,
  LABEL_GONE,
  STATUS_GONE,
  updateIssue,
  type CreateIssueInput,
  type IssueRow,
  type UpdateIssueInput,
} from '../src/handlers/issues/core.js';
import { memoryIssues, NOW, type MemoryIssues } from './support/memory-issues.js';

const ADA = '0192f0c1-7e5a-7b3c-9d4e-0000000000ad';

async function failure(run: Promise<unknown>): Promise<SurfaceError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof SurfaceError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

function create(m: MemoryIssues, extra: Partial<CreateIssueInput> = {}): Promise<IssueRow> {
  return createIssue(m.ctx, {
    id: randomUUID(),
    team: m.eng,
    teamRef: 'ENG',
    title: 'Fix login',
    assigneeId: null,
    labelIds: [],
    estimate: null,
    dueDate: null,
    creatorId: ADA,
    ...extra,
  });
}

function update(
  m: MemoryIssues,
  issue: IssueRow,
  extra: Partial<UpdateIssueInput> = {},
): ReturnType<typeof updateIssue> {
  return updateIssue(m.ctx, {
    issueId: issue.id,
    teamId: issue.teamId,
    addLabelIds: [],
    removeLabelIds: [],
    ...extra,
  });
}

describe('issue.create input (AC-1)', () => {
  const parse = (input: Record<string, unknown>) =>
    issueCreate.input.safeParse({ team: 'ENG', title: 'Fix login', ...input });
  const message = (input: Record<string, unknown>) =>
    parse(input).error?.issues.map((i) => i.message);

  it('refuses an empty or too long title with the §6.4 wording', () => {
    expect(message({ title: '  \n ' })).toEqual(['Title is required.']);
    expect(message({ title: 'x'.repeat(256) })).toEqual(['Title must be 255 characters or fewer.']);
    expect(parse({ title: 'x'.repeat(255) }).success).toBe(true);
  });

  it('accepts priorities 0 to 4 only, as whole numbers', () => {
    for (const priority of [0, 4]) expect(parse({ priority }).success).toBe(true);
    for (const priority of [-1, 5, 1.5, '2']) expect(parse({ priority }).success).toBe(false);
  });

  it('accepts a calendar date as the due date, and null', () => {
    expect(parse({ dueDate: '2026-11-30' }).success).toBe(true);
    expect(parse({ dueDate: null }).success).toBe(true);
    for (const dueDate of ['2026-02-30', '30/11/2026', '2026-11-30T00:00:00Z']) {
      expect(parse({ dueDate }).success, dueDate).toBe(false);
    }
  });

  it('accepts whole-number estimates and at most 20 labels', () => {
    expect(parse({ estimate: 2.5 }).success).toBe(false);
    expect(parse({ labels: Array.from({ length: 21 }, (_, i) => `L${i}`) }).success).toBe(false);
  });

  it('refuses an id that is not a UUIDv7', () => {
    expect(parse({ id: randomUUID() }).success).toBe(false);
  });
});

describe('issue.create (AC-1, AC-3, AC-4)', () => {
  it('defaults to the team default status, priority 0, no labels, and numbers issues per team', async () => {
    const m = memoryIssues();
    const row = await create(m, { title: ' Fix\nlogin ' });
    expect(row).toMatchObject({
      teamId: m.eng.id,
      number: 1,
      title: 'Fix login',
      statusId: m.eng.defaultStatusId,
      priority: 0,
      assigneeId: null,
      labelIds: [],
      creatorId: ADA,
      startedAt: null,
      completedAt: null,
      canceledAt: null,
    });
    expect((await create(m)).number).toBe(2);
    expect((await create(m, { team: m.des, teamRef: 'DES' })).number).toBe(1);
    expect(m.events.map((e) => e.type)).toEqual([
      'issue.created',
      'issue.created',
      'issue.created',
    ]);
  });

  it('applies its initial category’s side effects (§4.6)', async () => {
    const m = memoryIssues();
    const started = await create(m, { statusId: m.status(m.eng, 'In Progress').id });
    expect(started.startedAt).toEqual(NOW);
    const done = await create(m, { statusId: m.status(m.eng, 'Done').id });
    expect(done).toMatchObject({ completedAt: NOW, canceledAt: null, startedAt: null });
  });

  it('refuses Triage and Duplicate', async () => {
    const m = memoryIssues();
    for (const name of ['Triage', 'Duplicate']) {
      const error = await failure(create(m, { statusId: m.status(m.eng, name).id }));
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.message).toBe('Triage and Duplicate are set by their own actions.');
    }
    expect(m.writes).toEqual([]);
  });

  it("refuses another team's status (INV-06)", async () => {
    const m = memoryIssues();
    const error = await failure(create(m, { statusId: m.status(m.des, 'Todo').id }));
    expect(error.message).toBe('That status belongs to another team.');
  });

  it("refuses another team's label by uuid (INV-06), a group, and archived labels (SPEC-010 E12, E13)", async () => {
    const m = memoryIssues();
    const des = m.addLabel({ name: 'Design', teamId: m.des.id });
    const group = m.addLabel({ name: 'Size', isGroup: true });
    const archived = m.addLabel({ name: 'Old', archivedAt: NOW });
    const shelf = m.addLabel({ name: 'Shelf', isGroup: true, archivedAt: NOW });
    const inShelf = m.addLabel({ name: 'Boxed', parentId: shelf.id });
    const cases: [string, string][] = [
      [des.id, 'That label belongs to another team. Use a label of ENG or a workspace label.'],
      [group.id, 'Size is a label group. Choose one of its labels.'],
      [archived.id, 'That label is archived. Unarchive it in Settings → Labels.'],
      [inShelf.id, 'That label is archived. Unarchive it in Settings → Labels.'],
    ];
    for (const [labelId, wording] of cases) {
      const error = await failure(create(m, { labelIds: [labelId] }));
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.message).toBe(wording);
      expect(error.details.issues?.[0]?.path).toEqual(['labels', 0]);
    }
    expect(m.writes).toEqual([]);
  });

  it('accepts workspace labels, and keeps one label per exclusive group (the last added)', async () => {
    const m = memoryIssues();
    const bug = m.addLabel({ name: 'Bug', teamId: null });
    const size = m.addLabel({ name: 'Size', isGroup: true });
    const small = m.addLabel({ name: 'Small', parentId: size.id });
    const large = m.addLabel({ name: 'Large', parentId: size.id });
    const row = await create(m, { labelIds: [bug.id, small.id, large.id] });
    expect(row.labelIds).toEqual([bug.id, large.id]);
  });

  it('validates the estimate on the team’s scale (§6.4)', async () => {
    const m = memoryIssues();
    expect((await failure(create(m, { estimate: 3 }))).message).toBe(
      "ENG doesn't use estimates. Turn them on in team settings, or leave the estimate empty.",
    );
    m.setEstimates(m.eng, { estimateScale: 'fibonacci' });
    expect((await failure(create(m, { estimate: 4 }))).message).toBe(
      "4 is not on ENG's fibonacci scale (1, 2, 3, 5, 8).",
    );
    expect((await create(m, { estimate: 5 })).estimate).toBe(5);
    expect((await create(m, { estimate: null })).estimate).toBeNull();
  });

  it('takes the team share lock, then the status and labels, then the counter (§4.8)', async () => {
    const m = memoryIssues();
    const a = m.addLabel({ name: 'A' });
    const b = m.addLabel({ name: 'B' });
    const [low, high] = [a, b].sort((x, y) => (x.id < y.id ? -1 : 1));
    await create(m, { labelIds: [high?.id ?? '', low?.id ?? ''] });
    expect(m.calls).toEqual([
      'shareTeam',
      'shareStatus:Backlog',
      `shareLabels:${low?.name},${high?.name}`,
      'position',
    ]);
  });

  it('answers CONFLICT when a status or label was deleted after it resolved (E19, E22)', async () => {
    const m = memoryIssues();
    const todo = m.status(m.eng, 'Todo');
    m.statuses.delete(todo.id);
    const status = await failure(create(m, { statusId: todo.id }));
    expect([status.code, status.message]).toEqual(['CONFLICT', STATUS_GONE]);
    const label = m.addLabel({ name: 'Gone' });
    m.labels.delete(label.id);
    const gone = await failure(create(m, { labelIds: [label.id] }));
    expect([gone.code, gone.message]).toEqual(['CONFLICT', LABEL_GONE]);
    expect(m.writes).toEqual([]);
  });
});

describe('issue.update (AC-3, AC-4, AC-23, E8, E12)', () => {
  it('writes only the fields that change, and emits them', async () => {
    const m = memoryIssues();
    const issue = await create(m);
    m.writes.length = 0;
    const { changes } = await update(m, issue, { title: 'Fix login', priority: 2 });
    expect(changes).toEqual({ priority: { from: 0, to: 2 } });
    expect(m.writes).toEqual([{ action: 'update', ids: [issue.id], fields: ['priority'] }]);
    expect(m.events.at(-1)).toEqual({
      type: 'issue.updated',
      subject: { type: 'issue', id: issue.id },
      changes: { priority: { from: 0, to: 2 } },
    });
  });

  it('a no-op on a live issue writes nothing and emits nothing (E12)', async () => {
    const m = memoryIssues();
    const bug = m.addLabel({ name: 'Bug' });
    const issue = await create(m, { labelIds: [bug.id], priority: 1 });
    m.writes.length = 0;
    m.events.length = 0;
    const { row, changes } = await update(m, issue, {
      title: 'Fix login',
      priority: 1,
      statusId: issue.statusId,
      addLabelIds: [bug.id],
      assigneeId: null,
      estimate: null,
      dueDate: null,
    });
    expect(changes).toEqual({});
    expect(row.updatedAt).toEqual(issue.updatedAt);
    expect(m.writes).toEqual([]);
    expect(m.events).toEqual([]);
  });

  it('applies the category side effects of a status change (§4.6)', async () => {
    const m = memoryIssues();
    const issue = await create(m);
    const started = await update(m, issue, { statusId: m.status(m.eng, 'In Progress').id });
    expect(started.row.startedAt).toEqual(NOW);
    const done = await update(m, issue, { statusId: m.status(m.eng, 'Done').id });
    expect(done.row).toMatchObject({ startedAt: NOW, completedAt: NOW, canceledAt: null });
    const reopened = await update(m, issue, { statusId: m.status(m.eng, 'Todo').id });
    expect(reopened.row).toMatchObject({ startedAt: NOW, completedAt: null, canceledAt: null });
    const error = await failure(update(m, issue, { statusId: m.status(m.eng, 'Triage').id }));
    expect(error.message).toBe('Triage and Duplicate are set by their own actions.');
  });

  it('merges label adds and removes; a label in both lists is refused', async () => {
    const m = memoryIssues();
    const [a, b, c] = ['A', 'B', 'C'].map((name) => m.addLabel({ name }));
    if (!a || !b || !c) throw new Error('labels');
    const issue = await create(m, { labelIds: [a.id, b.id] });
    const { row } = await update(m, issue, { addLabelIds: [c.id], removeLabelIds: [a.id] });
    expect(row.labelIds).toEqual([b.id, c.id]);
    const error = await failure(update(m, issue, { addLabelIds: [a.id], removeLabelIds: [a.id] }));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe("A label can't be in both addLabels and removeLabels.");
  });

  it('adding a label of an exclusive group replaces the one the issue already has (D20)', async () => {
    const m = memoryIssues();
    const size = m.addLabel({ name: 'Size', isGroup: true });
    const small = m.addLabel({ name: 'Small', parentId: size.id });
    const large = m.addLabel({ name: 'Large', parentId: size.id });
    const bug = m.addLabel({ name: 'Bug' });
    const issue = await create(m, { labelIds: [small.id, bug.id] });
    const { row, changes } = await update(m, issue, { addLabelIds: [large.id] });
    expect(row.labelIds).toEqual([bug.id, large.id]);
    expect(changes.labelIds).toEqual({ from: [small.id, bug.id], to: [bug.id, large.id] });
  });

  it("refuses adding another team's label by uuid to the issue (INV-06)", async () => {
    const m = memoryIssues();
    const issue = await create(m, { team: m.des, teamRef: 'DES' });
    const eng = m.addLabel({ name: 'Backend', teamId: m.eng.id });
    const error = await failure(update(m, issue, { addLabelIds: [eng.id] }));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe(
      'That label belongs to another team. Use a label of DES or a workspace label.',
    );
    expect(error.details.issues?.[0]?.path).toEqual(['addLabels', 0]);
  });

  it('refuses newly adding an archived label, and keeps one already applied (SPEC-010 E12, E13)', async () => {
    const m = memoryIssues();
    const old = m.addLabel({ name: 'Old' });
    const issue = await create(m, { labelIds: [old.id] });
    m.labels.set(old.id, { ...old, archivedAt: NOW });
    const other = await create(m);
    const error = await failure(update(m, other, { addLabelIds: [old.id] }));
    expect(error.message).toBe('That label is archived. Unarchive it in Settings → Labels.');
    // Re-adding it where it already is changes nothing; other edits keep it.
    const kept = await update(m, issue, { addLabelIds: [old.id], priority: 3 });
    expect(kept.row.labelIds).toEqual([old.id]);
  });

  it('keeps an off-scale estimate it does not change, and checks a changed one (E8)', async () => {
    const m = memoryIssues();
    m.setEstimates(m.eng, { estimateScale: 'fibonacci' });
    const issue = await create(m, { estimate: 8 });
    m.setEstimates(m.eng, { estimateScale: 'linear' });
    expect((await update(m, issue, { priority: 2 })).row.estimate).toBe(8);
    expect((await update(m, issue, { estimate: 8 })).changes).toEqual({});
    expect((await failure(update(m, issue, { estimate: 13 }))).message).toBe(
      "13 is not on ENG's linear scale (1, 2, 3, 4, 5).",
    );
  });

  it('takes key locks on the status and added labels before the issue lock, labels in id order (AC-20)', async () => {
    const m = memoryIssues();
    const labels = ['A', 'B', 'C'].map((name) => m.addLabel({ name }));
    const issue = await create(m);
    m.calls.length = 0;
    const byId = [...labels].sort((x, y) => (x.id < y.id ? -1 : 1));
    await update(m, issue, {
      statusId: m.status(m.eng, 'Todo').id,
      addLabelIds: [...labels].reverse().map((l) => l.id),
    });
    expect(m.calls).toEqual([
      'readTeam',
      'shareStatus:Todo',
      `shareLabels:${byId.map((l) => l.name).join(',')}`,
      'lockIssue',
      'statusCategory',
    ]);
  });

  it('answers CONFLICT when the status or a label was deleted meanwhile (AC-15, E19, E22)', async () => {
    const m = memoryIssues();
    const issue = await create(m);
    const todo = m.status(m.eng, 'Todo');
    m.statuses.delete(todo.id);
    const status = await failure(update(m, issue, { statusId: todo.id }));
    expect([status.code, status.message]).toEqual(['CONFLICT', STATUS_GONE]);
    const label = m.addLabel({ name: 'Gone' });
    m.labels.delete(label.id);
    const gone = await failure(update(m, issue, { addLabelIds: [label.id] }));
    expect([gone.code, gone.message, gone.details.issues?.[0]?.path]).toEqual([
      'CONFLICT',
      LABEL_GONE,
      ['addLabels', 0],
    ]);
    expect(m.issues.get(issue.id)?.statusId).toBe(issue.statusId);
  });

  it('refuses any edit of an archived or deleted issue, even a no-op, and writes nothing (AC-23)', async () => {
    const m = memoryIssues();
    const archived = await create(m);
    const deleted = await create(m);
    m.issues.set(archived.id, { ...archived, archivedAt: NOW });
    m.issues.set(deleted.id, { ...deleted, deletedAt: NOW, deletedById: ADA });
    m.writes.length = 0;
    const a = await failure(update(m, archived, { title: archived.title }));
    expect([a.code, a.message]).toEqual(['CONFLICT', 'ENG-1 is archived. Restore it to edit it.']);
    const d = await failure(update(m, deleted, { priority: 3 }));
    expect([d.code, d.message]).toEqual(['CONFLICT', 'ENG-2 was deleted. Restore it to edit it.']);
    expect(m.writes).toEqual([]);
    expect(m.issues.get(archived.id)?.archivedAt).toEqual(NOW);
  });
});

// AC-7: the optimistic row equals the server's, apart from the server-computed number and
// sortOrder. The store holds the memory workspace's rows as the client does (ISO timestamps).

const USERS: StoreRow[] = [{ id: ADA, name: 'Ada', displayName: 'ada', active: true }];

function clientRow(row: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]),
  );
}

function storeOf(m: MemoryIssues): OptimisticStore & { issues: Map<string, StoreRow> } {
  const issues = new Map<string, StoreRow>();
  for (const [id, r] of m.issues) issues.set(id, { ...clientRow(r), groups: r.syncGroups });
  const teams: StoreRow[] = [m.eng, m.des].map((t) => ({ ...t, groups: ['workspace'] }));
  const tables: Record<string, () => StoreRow[]> = {
    Team: () => teams,
    WorkflowStatus: () => [...m.statuses.values()].map((s) => ({ ...s })),
    Label: () => [...m.labels.values()].map(clientRow),
    Issue: () => [...issues.values()],
    User: () => USERS,
  };
  const rows = (model: string) => tables[model]?.() ?? [];
  return {
    issues,
    now: NOW,
    get: (model, ref) =>
      model === 'User' && ref === 'me'
        ? USERS[0]
        : rows(model).find((r) => r['id'] === ref || r['key'] === ref),
    find: (model, fields) =>
      rows(model).filter((r) => Object.entries(fields).every(([f, v]) => r[f] === v)),
    patch: (model, ref, changes) => {
      const row = issues.get(ref);
      if (model === 'Issue' && row) issues.set(ref, { ...row, ...changes });
    },
    insert: (model, row) => void (model === 'Issue' && issues.set(row.id, row)),
    remove: () => undefined,
    archive: () => undefined,
    unarchive: () => undefined,
  };
}

function comparable(row: StoreRow | undefined) {
  if (row === undefined) return undefined;
  const { number: _n, sortOrder: _s, syncGroups: _g, groups: _h, ...rest } = row;
  return rest;
}

describe('optimistic equals the server (AC-7)', () => {
  it('for issue.create: defaults, a started status, labels with an exclusive group, an estimate', async () => {
    const m = memoryIssues();
    m.setEstimates(m.eng, { estimateScale: 'linear' });
    const size = m.addLabel({ name: 'Size', isGroup: true });
    const small = m.addLabel({ name: 'Small', parentId: size.id });
    const large = m.addLabel({ name: 'Large', parentId: size.id });
    const bug = m.addLabel({ name: 'Bug', teamId: null });
    const named: Record<string, string> = { Bug: bug.id, 'Size/Small': small.id };
    const cases = [
      {},
      { status: 'In Progress', priority: 2, assignee: ADA, dueDate: '2026-12-01' },
      { labels: ['Bug', 'Size/Small', large.id], estimate: 3 },
    ];
    for (const extra of cases) {
      const store = storeOf(m);
      const id = '0192f0c1-7e5a-7b3c-9d4e-' + randomUUID().slice(-12);
      const input = issueCreate.input.parse({ id, team: 'ENG', title: ' Fix\nlogin ', ...extra });
      issueCreate.optimistic?.(store, input);
      const labelIds = (input.labels ?? []).map((ref) => named[ref] ?? ref);
      const row = await create(m, {
        id,
        title: input.title,
        statusId: input.status === undefined ? undefined : m.status(m.eng, input.status).id,
        priority: input.priority,
        assigneeId: input.assignee ?? null,
        labelIds,
        estimate: input.estimate ?? null,
        dueDate: input.dueDate ?? null,
      });
      expect(comparable(store.issues.get(id))).toEqual(comparable(clientRow(row)));
      expect(store.issues.get(id)?.['number']).toBeNull();
    }
  });

  it('for issue.update: status, labels, assignee, estimate and a no-op', async () => {
    const m = memoryIssues();
    m.setEstimates(m.eng, { estimateScale: 'linear' });
    const size = m.addLabel({ name: 'Size', isGroup: true });
    const small = m.addLabel({ name: 'Small', parentId: size.id });
    const large = m.addLabel({ name: 'Large', parentId: size.id });
    const issue = await create(m, { labelIds: [small.id] });
    const steps = [
      { status: 'In Progress', assignee: ADA },
      { addLabels: [large.id], estimate: 2 },
      { status: 'Done', removeLabels: [large.id], dueDate: '2026-12-24' },
      { title: 'Fix login', priority: 0 },
    ];
    for (const step of steps) {
      const store = storeOf(m);
      const input = issueUpdate.input.parse({ issue: issue.id, ...step });
      issueUpdate.optimistic?.(store, input);
      await update(m, issue, {
        title: input.title,
        statusId: input.status === undefined ? undefined : m.status(m.eng, input.status).id,
        priority: input.priority,
        assigneeId: input.assignee,
        estimate: input.estimate,
        dueDate: input.dueDate,
        addLabelIds: input.addLabels ?? [],
        removeLabelIds: input.removeLabels ?? [],
      });
      const server = m.issues.get(issue.id);
      expect(comparable(store.issues.get(issue.id))).toEqual(
        comparable(server && clientRow(server)),
      );
    }
  });
});
