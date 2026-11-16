// PLAN-015 S1, SPEC-015 §6.1–§6.2: AC-13 (unit part: `issue.delete`'s optimistic removes the
// Issue, the result the server's `U` brings once the client drops deleted issues (PLAN-011 S4c);
// `issue.restore` predicts nothing, since the replica holds no archived or deleted issue), the
// operation shapes, and `ui.available` (§7: Delete hidden on a deleted issue, Restore only on an
// archived one or a deleted one before its purgeAfter). The registry lint runs registry-wide in `test/lint.test.ts`.
// PLAN-015 S2: `issue.purge` (Admin only, AC-10; predicts nothing, AC-13; Permanently delete only
// on a deleted issue).
import { bindPredicates, systemActor, userActor } from '@surface/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lintOperations } from '../lint.js';
import type { OptimisticStore, StoreRow } from '../optimistic.js';
import { issueDelete, issuePurge, issueRestore } from './issue-lifecycle.js';

const ISSUE = '0192f0c1-7e5a-7b3c-9d4e-0000000000b1';
const NOW = new Date('2026-11-13T10:00:00.000Z');

function issueRow(fields: Partial<StoreRow> = {}): StoreRow {
  return {
    id: ISSUE,
    teamId: '0192f0c1-7e5a-7b3c-9d4e-0000000000e1',
    number: 42,
    title: 'Fix login',
    archivedAt: null,
    deletedAt: null,
    deletedById: null,
    ...fields,
  };
}

/** A store holding `rows` by id (and `ENG-42`), recording every write. */
function fakeStore(rows: StoreRow[]) {
  const issues = new Map(rows.map((row) => [String(row['id']), row]));
  const writes: string[] = [];
  const get = (model: string, ref: string) =>
    model !== 'Issue'
      ? undefined
      : (issues.get(ref) ?? (ref === 'ENG-42' ? issues.get(ISSUE) : undefined));
  const store: OptimisticStore = {
    now: NOW,
    get,
    find: () => [],
    patch: (model, ref) => void writes.push(`patch ${model} ${ref}`),
    insert: (model, row) => void writes.push(`insert ${model} ${row.id}`),
    archive: (model, ref) => void writes.push(`archive ${model} ${ref}`),
    unarchive: (model, ref) => void writes.push(`unarchive ${model} ${ref}`),
    remove: (model, ref) => {
      writes.push(`remove ${model} ${ref}`);
      issues.delete(ref);
    },
  };
  return { store, issues, writes };
}

describe('issue.delete (§6.1, §6.2)', () => {
  it('is a destructive mutation on an IssueRef that returns the issue and purgeAfter', () => {
    expect(issueDelete).toMatchObject({ kind: 'mutation', domain: 'issue', destructive: true });
    expect(issueDelete.input.safeParse({ issue: 'ENG-42' }).success).toBe(true);
    // Only the issue is wrong here: purgeAfter is a valid timestamp.
    const output = issueDelete.output.safeParse({
      issue: {},
      purgeAfter: '2026-12-13T10:00:00.000Z',
    });
    expect(new Set(output.error?.issues.map((i) => i.path[0]))).toEqual(new Set(['issue']));
    expect(issueDelete.ui).toMatchObject({ title: 'Delete issue', contexts: ['issue'] });
  });

  it('removes a live or archived issue from the overlay, so it leaves every list at once (AC-13)', () => {
    for (const fields of [{}, { archivedAt: '2026-10-01T00:00:00.000Z' }]) {
      const { store, issues, writes } = fakeStore([issueRow(fields)]);
      issueDelete.optimistic?.(store, { issue: 'ENG-42' });
      expect(writes).toEqual([`remove Issue ${ISSUE}`]);
      // What the server's `U` (deletedAt set) leaves in the replica: no Issue (PLAN-011 S4c).
      expect(issues.has(ISSUE)).toBe(false);
    }
  });

  it('predicts nothing for a deleted issue (a no-op on the server) or one the store lacks', () => {
    const deleted = fakeStore([issueRow({ deletedAt: '2026-11-12T10:00:00.000Z' })]);
    issueDelete.optimistic?.(deleted.store, { issue: ISSUE });
    expect(deleted.writes).toEqual([]);
    const missing = fakeStore([]);
    issueDelete.optimistic?.(missing.store, { issue: ISSUE });
    expect(missing.writes).toEqual([]);
  });
});

describe('issue.restore (§6.1, §6.2)', () => {
  it('is a non-destructive mutation that returns the full issue', () => {
    expect(issueRestore).toMatchObject({ kind: 'mutation', domain: 'issue', destructive: false });
    expect(issueRestore.ui).toMatchObject({ title: 'Restore issue', contexts: ['issue'] });
  });

  it('predicts nothing: the row returns with the server’s V or U (AC-13, D17)', () => {
    for (const fields of [{}, { archivedAt: '2026-10-01T00:00:00.000Z' }]) {
      const { store, writes } = fakeStore([issueRow(fields)]);
      issueRestore.optimistic?.(store, { issue: ISSUE });
      expect(writes).toEqual([]);
    }
    // Registry rule 3 still needs one (§6.2).
    expect('optimistic' in issueRestore).toBe(true);
  });
});

describe('issue.purge (§6.1, §6.2; PLAN-015 S2)', () => {
  it('is a destructive mutation on an IssueRef that answers { purged: true }', () => {
    expect(issuePurge).toMatchObject({ kind: 'mutation', domain: 'issue', destructive: true });
    expect(issuePurge.input.safeParse({ issue: 'ENG-42' }).success).toBe(true);
    expect(issuePurge.output.safeParse({ purged: true }).success).toBe(true);
    expect(issuePurge.output.safeParse({ purged: false }).success).toBe(false);
    // D14: a plain confirm dialog, no shortcut.
    expect(issuePurge.ui).toMatchObject({
      title: 'Permanently delete…',
      contexts: ['issue'],
      shortcut: null,
    });
  });

  it('is for Admins only, and for the system actor the job runs as (§5.3, AC-10)', () => {
    const allowed = (actor: Parameters<typeof bindPredicates>[0]) =>
      issuePurge.permission(bindPredicates(actor).p, {}, { issue: ISSUE });
    const member = userActor({ userId: 'u-1', role: 'member', memberships: [] });
    const admin = userActor({ userId: 'u-2', role: 'admin', memberships: [] });
    expect(allowed(member)).toBe(false);
    expect(allowed(admin)).toBe(true);
    expect(allowed(systemActor())).toBe(true);
  });

  it('predicts nothing: the replica holds no deleted issue (AC-13, D17)', () => {
    const { store, writes } = fakeStore([issueRow({ deletedAt: '2026-11-12T10:00:00.000Z' })]);
    issuePurge.optimistic?.(store, { issue: ISSUE });
    expect(writes).toEqual([]);
    expect('optimistic' in issuePurge).toBe(true);
  });
});

describe('ui.available (§7)', () => {
  /** The client `SyncStore` as the predicate sees it: a `pool` with `get`. */
  const syncStore = (rows: StoreRow[]) => ({
    pool: {
      get: (model: string, id: string) =>
        model === 'Issue' ? rows.find((r) => r['id'] === id) : undefined,
    },
  });
  const target = { kind: 'issue' as const, ids: [ISSUE] };
  const deleteAvailable = (store: unknown) => issueDelete.ui?.available?.(target, store);
  const restoreAvailable = (store: unknown) => issueRestore.ui?.available?.(target, store);
  const purgeAvailable = (store: unknown) => issuePurge.ui?.available?.(target, store);
  /** `hours` before NOW, the predicates' clock. */
  const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('offers Delete on a live or archived issue, and not on a deleted one', () => {
    expect(deleteAvailable(syncStore([issueRow()]))).toBe(true);
    expect(deleteAvailable(syncStore([issueRow({ archivedAt: '2026-10-01T00:00:00Z' })]))).toBe(
      true,
    );
    expect(deleteAvailable(syncStore([issueRow({ deletedAt: '2026-11-12T10:00:00Z' })]))).toBe(
      false,
    );
  });

  it('offers Restore on an archived issue and a deleted one before purgeAfter, never on a live one', () => {
    expect(restoreAvailable(syncStore([issueRow()]))).toBe(false);
    expect(restoreAvailable(syncStore([issueRow({ archivedAt: '2026-10-01T00:00:00Z' })]))).toBe(
      true,
    );
    expect(restoreAvailable(syncStore([issueRow({ deletedAt: '2026-11-12T10:00:00Z' })]))).toBe(
      true,
    );
  });

  it('hides Restore on a deleted issue once purgeAfter has passed (D6, E4)', () => {
    // Restorable until 1 ms before `deletedAt + 720 h`, not at it (AC-3).
    const deletedAt = (ms: number) =>
      issueRow({ deletedAt: new Date(NOW.getTime() - ms).toISOString() });
    expect(restoreAvailable(syncStore([deletedAt(720 * 3_600_000 - 1)]))).toBe(true);
    expect(restoreAvailable(syncStore([deletedAt(720 * 3_600_000)]))).toBe(false);
    expect(restoreAvailable(syncStore([issueRow({ deletedAt: hoursAgo(1000) })]))).toBe(false);
    // An archived and deleted one follows the deleted rule (§4.2).
    expect(
      restoreAvailable(
        syncStore([issueRow({ archivedAt: hoursAgo(2000), deletedAt: hoursAgo(1000) })]),
      ),
    ).toBe(false);
  });

  it('offers Permanently delete only on a deleted issue', () => {
    expect(purgeAvailable(syncStore([issueRow()]))).toBe(false);
    expect(purgeAvailable(syncStore([issueRow({ archivedAt: '2026-10-01T00:00:00Z' })]))).toBe(
      false,
    );
    expect(purgeAvailable(syncStore([issueRow({ deletedAt: hoursAgo(1) })]))).toBe(true);
  });

  it('leaves an issue the replica doesn’t hold to the server (it is shown from the server)', () => {
    for (const store of [syncStore([]), null, {}]) {
      expect(deleteAvailable(store)).toBe(true);
      expect(restoreAvailable(store)).toBe(true);
      expect(purgeAvailable(store)).toBe(true);
    }
  });
});

describe('registry lint', () => {
  it('passes for the lifecycle operations', () => {
    expect(lintOperations([issueDelete, issueRestore, issuePurge])).toEqual([]);
  });
});
