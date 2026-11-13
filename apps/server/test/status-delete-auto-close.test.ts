// PLAN-015 S1, SPEC-015 E22 and SPEC-010 AC-5 (the auto-close clause): the `status.delete`
// handler reads the team's `autoCloseStatusId` under the team row lock it takes first, refuses
// the auto-close status with the E22 message, and deletes it once auto-close points elsewhere (or
// is off). The handler runs on a stand-in connection that answers its SQL; the rule itself is also
// covered on the in-memory workflow (`status-handlers.test.ts`).
import type { Actor } from '@surface/domain';
import { getTableColumns } from 'drizzle-orm';
import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import { workflowStatuses } from '../src/db/schema/index.js';
import type { HandlerContext } from '../src/executor/context.js';
import { SurfaceError } from '../src/executor/errors.js';
import statusDelete from '../src/handlers/statuses/delete.js';
import type { Repo } from '../src/sync/repo.js';
import { recordingDb } from './support/scripted-db.js';

const TEAM = '0190f0c0-0000-7000-8000-00000000e000';
const ADA = '0190f0c0-0000-7000-8000-0000000000a1';
const AT = new Date('2026-11-13T10:00:00.000Z');

/** The default workflow's statuses, plus a second Canceled status ("Won’t fix"). */
const STATUSES = [
  ['Backlog', 'backlog'],
  ['Todo', 'unstarted'],
  ['In Progress', 'started'],
  ['Done', 'completed'],
  ['Canceled', 'canceled'],
  ['Won’t fix', 'canceled'],
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
const byName = (name: string) => {
  const status = STATUSES.find((s) => s.name === name);
  if (!status) throw new Error(name);
  return status;
};
const BACKLOG = byName('Backlog').id;
const columns = Object.keys(getTableColumns(workflowStatuses));
const asArray = (row: Record<string, unknown>) => columns.map((c) => row[c] ?? null);

/** Runs `status.delete` of `name` for a team whose auto-close status is `autoCloseStatusId`. */
async function deleteStatus(name: string, autoCloseStatusId: string | null) {
  const target = byName(name);
  const { db, statements } = recordingDb((text, params) => {
    if (text.includes('from "teams"')) return [[TEAM, 'ENG', BACKLOG, autoCloseStatusId]];
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
    groups: ['workspace'],
    publicTeams: [TEAM],
    memberOf: [TEAM],
  };
  // Only what this handler touches; the rest of the context is never called.
  const ctx = {
    actor,
    tx: db,
    repo,
    refs: { team: { id: TEAM, key: 'ENG', private: false }, status: { id: target.id } },
    now: () => AT,
    log: {} as Logger,
  } as unknown as HandlerContext;
  const outcome = await statusDelete.run(ctx, { team: 'ENG', status: name }).then(
    () => undefined,
    (error: unknown) => error,
  );
  return { outcome, purged, statements };
}

describe('status.delete and the auto-close status (SPEC-015 E22, SPEC-010 AC-5)', () => {
  it('reads autoCloseStatusId under the team row lock, before anything else', async () => {
    const { statements } = await deleteStatus('Won’t fix', null);
    expect(statements[0]?.text).toMatch(
      /^select "id", "key", "default_status_id", "auto_close_status_id" from "teams" where .* for update$/,
    );
  });

  it('refuses to delete the team’s auto-close status with the E22 message', async () => {
    const wontFix = byName('Won’t fix').id;
    const { outcome, purged } = await deleteStatus('Won’t fix', wontFix);
    expect(outcome).toBeInstanceOf(SurfaceError);
    expect(outcome).toMatchObject({
      code: 'CONFLICT',
      message:
        'This status closes stale issues. Choose another one in Settings → Automations first.',
    });
    expect(purged).toEqual([]);
  });

  it('deletes it once auto-close points at another status, or is off', async () => {
    const wontFix = byName('Won’t fix').id;
    const elsewhere = await deleteStatus('Won’t fix', byName('Canceled').id);
    expect(elsewhere.outcome).toBeUndefined();
    expect(elsewhere.purged).toEqual([`WorkflowStatus:${wontFix}`]);
    const off = await deleteStatus('Won’t fix', null);
    expect(off.outcome).toBeUndefined();
    expect(off.purged).toEqual([`WorkflowStatus:${wontFix}`]);
  });
});
