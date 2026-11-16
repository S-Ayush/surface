// PLAN-010 S5, SPEC-010 AC-5 (with issue counts), AC-6 (live, archived and recently deleted
// issues count; permanently deleted ones have no row), E8 and §4.4: the `status.delete` handler
// counts the issues on the status after the team and status row locks, locks no issue, and refuses
// with the count in the message (the " (N archived or recently deleted)" suffix only when some
// are). The handler runs on a stand-in connection that answers its SQL.
import type { Actor } from '@surface/domain';
import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { workflowStatuses } from '../src/db/schema/index.js';
import type { HandlerContext } from '../src/executor/context.js';
import { SurfaceError } from '../src/executor/errors.js';
import statusDelete from '../src/handlers/statuses/delete.js';
import type { Repo } from '../src/sync/repo.js';
import { recordingDb } from './support/scripted-db.js';

const TEAM = '0190f0c0-0000-7000-8000-00000000e000';
const ADA = '0190f0c0-0000-7000-8000-0000000000a1';
const AT = new Date('2026-11-16T10:00:00.000Z');

const STATUSES = [
  ['Backlog', 'backlog'],
  ['Todo', 'unstarted'],
  ['In Progress', 'started'],
  ['In Review', 'started'],
  ['Done', 'completed'],
  ['Canceled', 'canceled'],
  ['Triage', 'triage'],
  ['Duplicate', 'duplicate'],
].map(([name, category], i) => ({
  id: `0190f0c0-0000-7000-8000-0000000005${String(i).padStart(2, '0')}`,
  teamId: TEAM,
  name,
  category,
  color: 'gray',
  description: null,
  position: `a${i}`,
  syncGroups: ['workspace'],
  createdAt: AT,
  updatedAt: AT,
}));
const IN_REVIEW = STATUSES[3] ?? STATUSES[0];
const BACKLOG = STATUSES[0]?.id;
const columns = Object.keys(getTableColumns(workflowStatuses));
const asArray = (row: Record<string, unknown>) => columns.map((c) => row[c] ?? null);

interface Counts {
  readonly live: number;
  readonly archived: number;
  readonly recentlyDeleted: number;
}

/** Runs `status.delete` of In Review while the database holds `counts` issues on it. */
async function deleteInReview(counts: Counts) {
  const { db, statements } = recordingDb((text, params) => {
    if (text.includes('from "teams"')) return [[TEAM, 'ENG', BACKLOG, null]];
    if (text.includes('from "issues"')) {
      return [[counts.live, counts.archived, counts.recentlyDeleted]];
    }
    if (text.includes('from "workflow_statuses"') && text.endsWith('for update')) {
      return STATUSES.filter((s) => params.includes(s.id)).map(asArray);
    }
    if (text.includes('from "workflow_statuses"')) return STATUSES.map(asArray);
    return [];
  });
  const purged: string[] = [];
  const repo = {
    purge: (model: string, id: string) => {
      purged.push(`${model}:${id}`);
      return Promise.resolve();
    },
  } as unknown as Repo;
  const actor: Actor = {
    kind: 'user',
    userId: ADA,
    groups: ['workspace', `user:${ADA}`],
    publicTeams: [TEAM],
    memberOf: [TEAM],
  };
  const ctx = {
    actor,
    tx: db,
    repo,
    refs: { team: { id: TEAM, key: 'ENG', private: false }, status: { id: IN_REVIEW?.id } },
    now: () => AT,
  } as unknown as HandlerContext;
  const outcome = await statusDelete.run(ctx, { team: 'ENG', status: 'In Review' }).then(
    () => undefined,
    (error: unknown) => error,
  );
  return { outcome, purged, statements };
}

const NONE: Counts = { live: 0, archived: 0, recentlyDeleted: 0 };

describe('status.delete counts the issues on the status (AC-5, AC-6, E8)', () => {
  it('counts every issue row on the status, by lifecycle state, after the status lock', async () => {
    const { statements } = await deleteInReview(NONE);
    const texts = statements.map((s) => s.text);
    const statusLock = texts.findIndex(
      (t) => t.includes('from "workflow_statuses"') && t.endsWith('for update'),
    );
    const count = texts.findIndex((t) => t.includes('from "issues"'));
    expect(statusLock).toBeGreaterThan(0);
    expect(count).toBeGreaterThan(statusLock);
    const text = texts[count] ?? '';
    // One row per issue state: live, archived (not deleted), recently deleted (archived or not).
    expect(text).toContain(
      'count(*) filter (where "archived_at" is null and "deleted_at" is null)',
    );
    expect(text).toContain(
      'count(*) filter (where "archived_at" is not null and "deleted_at" is null)',
    );
    expect(text).toContain('count(*) filter (where "deleted_at" is not null)');
    expect(text).toMatch(/where "issues"\."status_id" = \$1$/);
    expect(statements[count]?.params).toEqual([IN_REVIEW?.id]);
    // No issue lock (§4.4) and no visibility filter: the delete must see every issue on the status.
    expect(text).not.toMatch(/ for (update|share|key share|no key update)/);
    expect(text).not.toContain('sync_groups');
  });

  it('deletes a status no issue uses', async () => {
    const { outcome, purged } = await deleteInReview(NONE);
    expect(outcome).toBeUndefined();
    expect(purged).toEqual([`WorkflowStatus:${IN_REVIEW?.id}`]);
  });

  it.each([
    [
      { live: 2, archived: 0, recentlyDeleted: 0 },
      'Can\'t delete the "In Review" status. It has 2 issues. Move them to another status first.',
    ],
    [
      { live: 1, archived: 0, recentlyDeleted: 0 },
      'Can\'t delete the "In Review" status. It has 1 issue. Move it to another status first.',
    ],
    [
      { live: 1, archived: 1, recentlyDeleted: 0 },
      'Can\'t delete the "In Review" status. It has 2 issues (1 archived or recently deleted). Move them to another status first.',
    ],
    [
      { live: 0, archived: 0, recentlyDeleted: 1 },
      'Can\'t delete the "In Review" status. It has 1 issue (1 archived or recently deleted). Move it to another status first.',
    ],
    [
      { live: 2, archived: 1, recentlyDeleted: 2 },
      'Can\'t delete the "In Review" status. It has 5 issues (3 archived or recently deleted). Move them to another status first.',
    ],
  ])('refuses with CONFLICT and the count while issues use it (%o)', async (counts, message) => {
    const { outcome, purged } = await deleteInReview(counts);
    expect(outcome).toBeInstanceOf(SurfaceError);
    expect(outcome).toMatchObject({ code: 'CONFLICT', message });
    expect(purged).toEqual([]);
  });
});
