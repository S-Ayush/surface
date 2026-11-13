// SPEC-012 §3.4 items 7 to 11, AC-28, E3, E9, E27: an
// issue the replica doesn't hold is read with `issue.get`; what the page shows is decided by
// `chooseIssueSource`.
import { Issue, Team } from '@surface/domain/model';
import type { ReadonlyPool, SyncStore, TeamLoadState } from '@surface/sync-client';
import { describe, expect, it } from 'vitest';
import type { OperationAnswer } from '../src/features/files/operation.js';
import {
  chooseIssueSource,
  heldRejection,
  loadMissingIssue,
  NO_TEAM_SUBSCRIPTION,
  storeTeamSubscription,
  type IssueLoaderDeps,
} from '../src/features/issues/issue-loader.js';
import {
  issueViewFromOutput,
  type IssueOutput,
  type IssueView,
} from '../src/features/issues/issue-view.js';

const ID = '0192f0c1-7e5a-7b3c-9d4e-0000000000b1';
const AT = '2026-11-12T10:00:00.000Z';

const OUTPUT: IssueOutput = {
  id: ID,
  identifier: 'ENG-42',
  teamKey: 'ENG',
  title: 'Login page flickers',
  status: { id: ID, name: 'Todo', category: 'unstarted' },
  priority: 2,
  assignee: { id: ID, name: 'Ada' },
  labels: [{ id: ID, name: 'Bug', color: 'red' }],
  estimate: 3,
  dueDate: null,
  createdAt: AT,
  updatedAt: AT,
  completedAt: null,
  archivedAt: null,
  deletedAt: null,
  deletedBy: null,
  url: 'http://x/issue/ENG-42/login-page-flickers',
  creator: { id: ID, name: 'Ada' },
  startedAt: null,
  canceledAt: null,
};

function deps(
  answer: OperationAnswer<IssueOutput>,
  extra: Partial<IssueLoaderDeps> = {},
): IssueLoaderDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    get: (ref) => {
      asked.push(ref);
      return Promise.resolve(answer);
    },
    online: () => true,
    subscribeTeam: NO_TEAM_SUBSCRIPTION,
    ...extra,
  };
}

describe('loadMissingIssue (AC-28)', () => {
  it('shows a live issue the replica lacks read-only from the answer, until the team can be subscribed', async () => {
    const result = await loadMissingIssue('ENG-42', deps({ ok: true, result: OUTPUT }));
    expect(result).toMatchObject({
      kind: 'remote',
      view: { identifier: 'ENG-42', lifecycle: 'live' },
    });
  });

  it('subscribes the team of a live issue and reads the row from the replica (E27)', async () => {
    const subscribed: string[][] = [];
    const result = await loadMissingIssue(
      'ENG-42',
      deps(
        { ok: true, result: OUTPUT },
        {
          subscribeTeam: (key, id) => {
            subscribed.push([key, id]);
            return Promise.resolve('local');
          },
        },
      ),
    );
    expect(result).toEqual({ kind: 'in-replica' });
    expect(subscribed).toEqual([['ENG', ID]]);
  });

  it('opens an archived or deleted issue read-only without subscribing', async () => {
    for (const patch of [{ archivedAt: AT }, { deletedAt: AT }]) {
      const subscribed: string[] = [];
      const result = await loadMissingIssue(
        'ENG-42',
        deps(
          { ok: true, result: { ...OUTPUT, ...patch } },
          {
            subscribeTeam: (key) => {
              subscribed.push(key);
              return Promise.resolve('local');
            },
          },
        ),
      );
      expect(result.kind).toBe('remote');
      expect(subscribed).toEqual([]);
    }
  });

  it('answers not found for NOT_FOUND, whatever the reason', async () => {
    const notFound = { ok: false, code: 'NOT_FOUND', message: 'No such issue.' } as const;
    expect(await loadMissingIssue('ENG-99', deps(notFound))).toEqual({ kind: 'not-found' });
  });

  it('says "not found" only for NOT_FOUND; any other failure is an error to retry', async () => {
    for (const code of ['INTERNAL', 'RATE_LIMITED', 'UNAUTHENTICATED', 'FORBIDDEN']) {
      const failed = deps({ ok: false, code, message: 'x' });
      expect(await loadMissingIssue('ENG-42', failed), code).toEqual({ kind: 'error' });
    }
    const none = chooseIssueSource({
      replica: undefined,
      rejected: undefined,
      last: undefined,
      loaded: { kind: 'error' },
    });
    expect(none).toEqual({ kind: 'error' });
  });

  it('passes the pool on, so a team the replica holds fills the view', async () => {
    const team = {
      id: 'team-1',
      key: 'ENG',
      estimateScale: 'fibonacci',
      estimateExtended: false,
      estimateAllowZero: false,
    };
    const pool = { findBy: () => [team] } as unknown as ReadonlyPool;
    const result = await loadMissingIssue('ENG-42', deps({ ok: true, result: OUTPUT }, { pool }));
    expect(result).toMatchObject({
      kind: 'remote',
      view: { teamId: 'team-1', estimateConfig: { scale: 'fibonacci' } },
    });
    // Without the team there is no id, never an empty string.
    const without = await loadMissingIssue('ENG-42', deps({ ok: true, result: OUTPUT }));
    expect(without).toMatchObject({ view: { teamId: null, estimateConfig: null } });
  });

  it('does not ask the server about a ref that names no issue', async () => {
    const d = deps({ ok: true, result: OUTPUT });
    expect(await loadMissingIssue('not an issue', d)).toEqual({ kind: 'not-found' });
    expect(d.asked).toEqual([]);
  });

  it('says "available when online" offline, without asking, and when the server is unreachable', async () => {
    const offline = deps({ ok: true, result: OUTPUT }, { online: () => false });
    expect(await loadMissingIssue('ENG-42', offline)).toEqual({ kind: 'offline' });
    expect(offline.asked).toEqual([]);
    const unreachable = deps({ ok: false, code: 'UNREACHABLE', message: 'x' });
    expect(await loadMissingIssue('ENG-42', unreachable)).toEqual({ kind: 'offline' });
  });
});

describe('heldRejection (E9)', () => {
  const rejections = [
    { op: 'issue.create', input: { id: 'other' }, message: 'Not that one.' },
    { op: 'issue.update', input: { id: ID }, message: 'Wrong operation.' },
    { op: 'issue.create', input: { id: ID }, message: 'Title is required.' },
  ];

  it('finds the reason the issue’s create was rejected', () => {
    expect(heldRejection(rejections, ID)).toBe('Title is required.');
  });

  it('finds nothing for an issue whose create wasn’t rejected, or after a reload', () => {
    expect(heldRejection(rejections, 'unknown')).toBeUndefined();
    expect(heldRejection([], ID)).toBeUndefined();
  });
});

describe('chooseIssueSource', () => {
  const live: IssueView = issueViewFromOutput(OUTPUT);
  const none = { replica: undefined, rejected: undefined, last: undefined, loaded: undefined };

  it('shows the replica’s live row editable, and any server answer yields to it', () => {
    expect(chooseIssueSource({ ...none, replica: live, loaded: { kind: 'not-found' } })).toEqual({
      kind: 'view',
      view: live,
      readOnly: false,
    });
  });

  it('shows an archived row of the replica read-only', () => {
    const archived = { ...live, lifecycle: 'archived' } as const;
    expect(chooseIssueSource({ ...none, replica: archived })).toMatchObject({ readOnly: true });
  });

  it('waits, then follows the server’s answer', () => {
    expect(chooseIssueSource(none)).toEqual({ kind: 'loading' });
    expect(chooseIssueSource({ ...none, loaded: { kind: 'in-replica' } })).toEqual({
      kind: 'loading',
    });
    expect(chooseIssueSource({ ...none, loaded: { kind: 'not-found' } })).toEqual({
      kind: 'not-found',
    });
    expect(chooseIssueSource({ ...none, loaded: { kind: 'offline' } })).toEqual({
      kind: 'offline',
    });
    expect(chooseIssueSource({ ...none, loaded: { kind: 'remote', view: live } })).toEqual({
      kind: 'view',
      view: live,
      readOnly: true,
    });
  });

  it('shows the held rejection of a pending issue’s create (E9)', () => {
    expect(chooseIssueSource({ ...none, rejected: 'Title is required.' })).toEqual({
      kind: 'create-rejected',
      message: 'Title is required.',
    });
  });

  it('keeps the last row, read-only, while an issue that left the replica is looked up (E3)', () => {
    expect(chooseIssueSource({ ...none, last: live })).toEqual({
      kind: 'view',
      view: live,
      readOnly: true,
    });
    expect(chooseIssueSource({ ...none, last: live, loaded: { kind: 'offline' } })).toMatchObject({
      kind: 'view',
      readOnly: true,
    });
    const deleted = issueViewFromOutput({ ...OUTPUT, deletedAt: AT });
    expect(
      chooseIssueSource({ ...none, last: live, loaded: { kind: 'remote', view: deleted } }),
    ).toEqual({
      kind: 'view',
      view: deleted,
      readOnly: true,
    });
  });
});

describe('storeTeamSubscription (PLAN-011 S4c)', () => {
  const ENG_ID = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
  /** A store with team ENG; the issue row appears once the team is loaded as `loaded` says. */
  function store(loaded: TeamLoadState, rowArrives = true) {
    const opened: string[] = [];
    let ready = false;
    const fake = {
      pool: {
        all: (model: unknown) =>
          model === Team ? [{ id: ENG_ID, key: 'ENG', name: 'Engineering', private: false }] : [],
        get: (model: unknown, id: string) =>
          model === Issue && id === ID && ready && rowArrives ? { id } : undefined,
      },
      openTeam: (teamId: string) => opened.push(teamId),
      whenTeamLoaded: () => {
        ready = loaded === 'ready';
        return Promise.resolve(loaded);
      },
    };
    // Only what the subscription reads.
    return { store: fake as unknown as SyncStore, opened };
  }

  it('opens the issue team, waits for its load and reads the row from the replica', async () => {
    const { store: s, opened } = store('ready');
    expect(await storeTeamSubscription(s)('eng', ID)).toBe('local');
    expect(opened).toEqual([ENG_ID]);
  });

  it('is unavailable offline, for a team the replica lacks, or a row the team no longer has', async () => {
    expect(await storeTeamSubscription(store('offline').store)('ENG', ID)).toBe('unavailable');
    expect(await storeTeamSubscription(store('ready').store)('DES', ID)).toBe('unavailable');
    expect(await storeTeamSubscription(store('ready', false).store)('ENG', ID)).toBe('unavailable');
    expect(await storeTeamSubscription(null)('ENG', ID)).toBe('unavailable');
  });
});
