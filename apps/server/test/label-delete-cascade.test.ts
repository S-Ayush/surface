// PLAN-010 S5, SPEC-010 AC-12, E7, §4.4: `label.delete` takes the scope row, then the label row
// `FOR UPDATE`, then removes the label from every issue that carries it (live, archived and
// recently deleted) through `removeLabelFromIssues` (the repo's bulk path, `touchUpdatedAt:
// false`: no `updatedAt`, history or lifecycle change), and only then deletes the label row.
// `removedFromIssues` counts only the issues the actor can see. The rules run on the in-memory
// scope (`memory-labels.ts`); the registered handler runs on a stand-in connection, which shows the
// SQL order and the visibility filter of the count. Chunking is PLAN-011 S1's
// (`sync-repo-bulk.test.ts`).
import type { Actor } from '@surface/domain';
import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { labels } from '../src/db/schema/index.js';
import type { HandlerContext } from '../src/executor/context.js';
import { SurfaceError } from '../src/executor/errors.js';
import labelDelete from '../src/handlers/labels/delete.js';
import { deleteLabel, type LabelRow } from '../src/handlers/labels/core.js';
import type { Repo } from '../src/sync/repo.js';
import { memoryLabels } from './support/memory-labels.js';
import { recordingDb } from './support/scripted-db.js';

const EARLIER = new Date('2026-10-01T00:00:00.000Z');
const ref = (row: LabelRow) => ({ id: row.id, teamId: row.teamId, name: row.name });

describe('label.delete removes the label from issues, then deletes it (AC-12)', () => {
  it('locks the scope row, then the label, then rewrites the issues, then deletes the label', async () => {
    const m = memoryLabels();
    const bug = m.add({ name: 'Bug' });
    m.addIssue([bug.id]);
    await deleteLabel(m.access, m.repo, { label: ref(bug) });
    expect(m.calls).toEqual([
      'lockTeam',
      'lockLabel:Bug',
      'scopeLabels',
      'removeFromIssues:Bug',
      'visibleIssueCount',
    ]);
    expect(m.writes.map((w) => w.action)).toEqual(['updateWhere', 'purge']);
  });

  it('locks the workspace row first for a workspace label', async () => {
    const m = memoryLabels();
    const bug = m.add({ name: 'Bug', teamId: null });
    m.addIssue([bug.id]);
    await deleteLabel(m.access, m.repo, { label: ref(bug) });
    expect(m.calls.slice(0, 2)).toEqual(['lockWorkspace', 'lockLabel:Bug']);
  });

  it('rewrites live, archived and deleted issues alike, keeps their other labels and updatedAt', async () => {
    const m = memoryLabels();
    const bug = m.add({ name: 'Bug' });
    const ui = m.add({ name: 'UI' });
    const live = m.addIssue([ui.id, bug.id], { updatedAt: EARLIER });
    const archived = m.addIssue([bug.id], { archivedAt: EARLIER, updatedAt: EARLIER });
    const deleted = m.addIssue([bug.id, ui.id], { deletedAt: EARLIER, updatedAt: EARLIER });
    const other = m.addIssue([ui.id], { updatedAt: EARLIER });
    const out = await deleteLabel(m.access, m.repo, { label: ref(bug) });

    expect(out.removedFromIssues).toBe(3);
    expect(m.issues.get(live.id)).toMatchObject({ labelIds: [ui.id], updatedAt: EARLIER });
    expect(m.issues.get(archived.id)).toMatchObject({
      labelIds: [],
      archivedAt: EARLIER,
      deletedAt: null,
      updatedAt: EARLIER,
    });
    expect(m.issues.get(deleted.id)).toMatchObject({
      labelIds: [ui.id],
      deletedAt: EARLIER,
      updatedAt: EARLIER,
    });
    expect(m.issues.get(other.id)?.labelIds).toEqual([ui.id]);
    // One bulk write in ascending id that leaves updatedAt alone, then the label's own delete.
    expect(m.writes).toEqual([
      {
        action: 'updateWhere',
        id: bug.id,
        model: 'Issue',
        ids: [live.id, archived.id, deleted.id].sort(),
        fields: ['labelIds'],
        touchUpdatedAt: false,
      },
      { action: 'purge', id: bug.id, model: 'Label' },
    ]);
    expect(m.rows.has(bug.id)).toBe(false);
  });

  it('refuses a group that still has labels before touching any issue', async () => {
    const m = memoryLabels();
    const size = m.add({ name: 'Size', isGroup: true });
    const small = m.add({ name: 'Small', parentId: size.id });
    m.addIssue([small.id]);
    const error = await deleteLabel(m.access, m.repo, { label: ref(size) }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SurfaceError);
    expect(error).toMatchObject({ code: 'CONFLICT' });
    expect(m.calls).not.toContain('removeFromIssues:Size');
    expect(m.writes).toEqual([]);
  });

  it('refuses a label deleted since resolution before touching any issue', async () => {
    const m = memoryLabels();
    const bug = m.add({ name: 'Bug' });
    m.addIssue([bug.id]);
    m.rows.delete(bug.id);
    const error = await deleteLabel(m.access, m.repo, { label: ref(bug) }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'CONFLICT' });
    expect(m.writes).toEqual([]);
  });
});

describe('removedFromIssues counts only issues the actor can see (E7)', () => {
  it('leaves the label on no issue, and counts the visible ones only', async () => {
    const m = memoryLabels();
    const bug = m.add({ name: 'Bug', teamId: null });
    const seen = m.addIssue([bug.id]);
    const hidden = m.addIssue([bug.id], { visible: false });
    const out = await deleteLabel(m.access, m.repo, { label: ref(bug) });
    expect(out.removedFromIssues).toBe(1);
    expect(m.issues.get(seen.id)?.labelIds).toEqual([]);
    expect(m.issues.get(hidden.id)?.labelIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The registered handler on a stand-in connection.

const TEAM = '0190f0c0-0000-7000-8000-00000000e000';
const LABEL = '0190f0c0-0000-7000-8000-0000000000b1';
const ISSUES = ['0190f0c0-0000-7000-8000-000000000001', '0190f0c0-0000-7000-8000-000000000002'];
const ADA = '0190f0c0-0000-7000-8000-0000000000a1';
const labelColumns = Object.keys(getTableColumns(labels));
const LABEL_ROW: Record<string, unknown> = {
  id: LABEL,
  teamId: TEAM,
  name: 'Bug',
  color: 'red',
  description: null,
  parentId: null,
  isGroup: false,
  exclusive: true,
  archivedAt: null,
  syncGroups: ['workspace'],
  createdAt: EARLIER,
  updatedAt: EARLIER,
};

async function runHandler(actor: Actor) {
  const { db, statements } = recordingDb((text) => {
    if (text.includes('from "teams"')) return [[TEAM, 'ENG']];
    if (text.startsWith('select "id" from "issues"')) return ISSUES.map((id) => [id]);
    if (text.includes('count(*)')) return [[1]];
    if (text.includes('from "labels"')) return [labelColumns.map((c) => LABEL_ROW[c] ?? null)];
    return [];
  });
  const repo = {
    updateWhere: (model: string, ids: readonly string[]) => {
      statements.push({ text: `repo.updateWhere ${model}`, params: [...ids] });
      return Promise.resolve([...ids]);
    },
    purge: (model: string, id: string) => {
      statements.push({ text: `repo.purge ${model}`, params: [id] });
      return Promise.resolve();
    },
  } as unknown as Repo;
  const ctx = {
    actor,
    tx: db,
    repo,
    refs: { label: { id: LABEL, teamId: TEAM, name: 'Bug' } },
    now: () => EARLIER,
  } as unknown as HandlerContext;
  const output = await labelDelete.run(ctx, { label: 'Bug' });
  return { output, statements };
}

const member: Actor = {
  kind: 'user',
  userId: ADA,
  groups: ['workspace', `user:${ADA}`],
  publicTeams: [TEAM],
  memberOf: [TEAM],
};

describe('the label.delete handler on SQL (AC-12, AC-21 reaching the bulk path)', () => {
  it('locks team and label, reads the issues, rewrites them in bulk, counts, then deletes', async () => {
    const { output, statements } = await runHandler(member);
    const texts = statements.map((s) => s.text);
    expect(texts[0]).toMatch(/^select "id", "key" from "teams" where .* for update$/);
    expect(texts[1]).toMatch(/^select .* from "labels" where "labels"\."id" = \$1 for update$/);
    const read = texts.findIndex((t) => t.startsWith('select "id" from "issues"'));
    const bulk = texts.indexOf('repo.updateWhere Issue');
    const count = texts.findIndex((t) => t.includes('count(*)'));
    const purge = texts.indexOf('repo.purge Label');
    expect(read).toBeGreaterThan(1);
    expect([read < bulk, bulk < count, count < purge]).toEqual([true, true, true]);
    expect(statements[bulk]?.params).toEqual(ISSUES);
    expect(output.removedFromIssues).toBe(1);
  });

  it('counts with the actor’s visible groups and, for a narrowed key, its teams', async () => {
    const keyActor: Actor = {
      ...member,
      kind: 'api',
      apiKey: { id: 'k', scope: 'read_write', teamIds: [TEAM], allowDestructive: true },
    };
    const { statements } = await runHandler(keyActor);
    const count = statements.find((s) => s.text.includes('count(*)'));
    expect(count?.text).toMatch(/"issues"\."sync_groups" && \$\d+/);
    expect(count?.text).toMatch(/"issues"\."team_id" in \(\$\d+\)/);
    // Every public team's group is visible (SPEC-011 §5.6), and the ids go as one array.
    expect(String(count?.params[1])).toContain(`team:${TEAM}`);
    expect(count?.params).toContainEqual(ISSUES);
  });
});
