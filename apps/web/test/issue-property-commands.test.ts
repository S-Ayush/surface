/**
 * @vitest-environment jsdom
 */
// PLAN-012 S6 (SPEC-012 §3.8, AC-7, AC-16, AC-25): the property commands of `features/issues/commands.ts`
// against the real operation registry and a fake replica: which are offered for which issue, what
// their sub-pages list, and the one partial `issue.update` each sends.
import { userActor } from '@surface/domain';
import { Issue, Label, Team, TeamMembership, User, WorkflowStatus } from '@surface/domain/model';
import { registry } from '@surface/operations';
import type { SyncStore } from '@surface/sync-client';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommandContext, CommandTarget } from '../src/command-menu/model.js';
import { propertySource } from '../src/command-menu/sources/properties.js';
import { ISSUE_PROPERTY_COMMANDS } from '../src/features/issues/commands.js';
import { pickerRequests } from '../src/features/issues/pickers/picker-request.js';

type Row = Record<string, unknown>;
const ME = 'u-me';
const issueRow = (id: string, extra: Row = {}): Row => ({
  id,
  teamId: 'eng',
  number: 42,
  title: 'Fix login',
  statusId: 'eng-todo',
  priority: 2,
  assigneeId: null,
  labelIds: [],
  estimate: null,
  dueDate: null,
  archivedAt: null,
  deletedAt: null,
  ...extra,
});

function fakeStore(issues: Row[], scale = 'linear') {
  const dispatched: { op: string; input: unknown }[] = [];
  const models = new Map<unknown, Row[]>([
    [Issue, issues],
    [
      Team,
      [
        {
          id: 'eng',
          key: 'ENG',
          name: 'Engineering',
          private: false,
          defaultStatusId: 'eng-todo',
          estimateScale: scale,
          estimateExtended: false,
          estimateAllowZero: false,
        },
      ],
    ],
    [TeamMembership, [{ teamId: 'eng', userId: ME }]],
    [
      WorkflowStatus,
      [
        {
          id: 'eng-todo',
          teamId: 'eng',
          name: 'Todo',
          category: 'unstarted',
          position: 'a1',
          color: 'gray',
        },
        {
          id: 'eng-done',
          teamId: 'eng',
          name: 'Done',
          category: 'completed',
          position: 'a2',
          color: 'green',
        },
      ],
    ],
    [
      Label,
      [
        {
          id: 'l-bug',
          name: 'Bug',
          teamId: null,
          archivedAt: null,
          isGroup: false,
          parentId: null,
          exclusive: false,
          color: 'red',
        },
        {
          id: 'g-size',
          name: 'Size',
          teamId: null,
          archivedAt: null,
          isGroup: true,
          parentId: null,
          exclusive: true,
          color: 'blue',
        },
        {
          id: 'l-s',
          name: 'Small',
          teamId: null,
          archivedAt: null,
          isGroup: false,
          parentId: 'g-size',
          exclusive: false,
          color: 'blue',
        },
        {
          id: 'l-l',
          name: 'Large',
          teamId: null,
          archivedAt: null,
          isGroup: false,
          parentId: 'g-size',
          exclusive: false,
          color: 'blue',
        },
      ],
    ],
    [User, [{ id: ME, name: 'Me', displayName: 'me', email: 'me@x.test', active: true }]],
  ]);
  const store = {
    connection: 'online',
    dispatch: (op: { name: string }, input: unknown) => {
      dispatched.push({ op: op.name, input });
      return Promise.resolve({ status: 'confirmed' });
    },
    pool: {
      all: (model: unknown) => models.get(model) ?? [],
      get: (model: unknown, id: string) => (models.get(model) ?? []).find((r) => r['id'] === id),
    },
  } as unknown as SyncStore;
  return { store, dispatched };
}

const target = (...ids: string[]): CommandTarget => ({ kind: 'issue', ids, label: 'ENG-42' });
const ctxOf = (store: SyncStore, ids: string[] = ['i1']): CommandContext => ({
  route: '/',
  target: target(...ids),
  actor: userActor({
    userId: ME,
    role: 'member',
    memberships: [{ teamId: 'eng', private: false }],
  }),
  store,
  teams: () => [],
});

const source = propertySource(registry, ISSUE_PROPERTY_COMMANDS);
const offered = (ctx: CommandContext) =>
  source(ctx)
    .filter((c) => c.when?.(ctx) ?? true)
    .map((c) => c.title);
const command = (ctx: CommandContext, title: string) => {
  const found = source(ctx).find((c) => c.title === title);
  if (found === undefined) throw new Error(`no command ${title}`);
  return found;
};
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

afterEach(() => {
  pickerRequests.close();
});

describe('which property commands a context offers (§3.8, AC-16)', () => {
  it('offers every editing command for a live issue; Remove due date only when it has one', () => {
    const { store } = fakeStore([issueRow('i1')]);
    expect(offered(ctxOf(store))).toEqual([
      'Change status…',
      'Set priority…',
      'Assign…',
      'Assign to me',
      'Labels…',
      'Set estimate…',
      'Set due date…',
    ]);
    const dated = fakeStore([issueRow('i1', { dueDate: '2026-12-03' })]);
    expect(offered(ctxOf(dated.store))).toContain('Remove due date');
  });

  it('hides Set estimate… on a team that does not use estimates', () => {
    const { store } = fakeStore([issueRow('i1')], 'off');
    expect(offered(ctxOf(store))).not.toContain('Set estimate…');
  });

  it('offers none for an archived or deleted issue, or one the replica does not hold (AC-25)', () => {
    for (const row of [
      issueRow('i1', { archivedAt: '2026-11-01T00:00:00.000Z' }),
      issueRow('i1', { deletedAt: '2026-11-01T00:00:00.000Z' }),
    ]) {
      expect(offered(ctxOf(fakeStore([row]).store))).toEqual([]);
    }
    expect(offered(ctxOf(fakeStore([]).store))).toEqual([]);
  });
});

describe('what a property command sends (AC-7)', () => {
  it('Change status… opens a page with the issue chip and the bound picker, not a list', () => {
    const { store } = fakeStore([issueRow('i1')]);
    const ctx = ctxOf(store);
    const picker = command(ctx, 'Change status…');
    const page = 'page' in picker ? picker.page?.(ctx) : undefined;
    expect(page?.chip).toBe('ENG-42 · Fix login');
    expect(page?.body).toBeTypeOf('function');
    // The options, quick keys and updates belong to the picker (issue-pickers.test.tsx).
    expect(page?.items()).toEqual([]);
  });

  it('every list picker command opens a body page; the due date stays a run command', () => {
    const { store } = fakeStore([issueRow('i1')]);
    const ctx = ctxOf(store);
    for (const title of ['Set priority…', 'Assign…', 'Labels…']) {
      const picker = command(ctx, title);
      expect('page' in picker ? picker.page?.(ctx).body : undefined).toBeTypeOf('function');
    }
    expect('run' in command(ctx, 'Set due date…')).toBe(true);
  });

  it('Assign to me and Remove due date send one update; Set due date… opens the picker', async () => {
    const { store, dispatched } = fakeStore([issueRow('i1', { dueDate: '2026-12-03' })]);
    const ctx = ctxOf(store);
    const run = (title: string) => {
      const found = command(ctx, title);
      if (!('run' in found) || found.run === undefined) throw new Error('not a run command');
      return found.run(ctx);
    };
    await run('Assign to me');
    await run('Remove due date');
    expect(dispatched.map((d) => d.input)).toEqual([
      { issue: 'i1', assignee: ME },
      { issue: 'i1', dueDate: null },
    ]);
    await run('Set due date…');
    await settle();
    expect(pickerRequests.snapshot()).toMatchObject({ kind: 'dueDate', issueId: 'i1' });
  });

  it('uses the pre-check of issue.update: hidden for a user who cannot sign in to the app', () => {
    const { store } = fakeStore([issueRow('i1')]);
    expect(offered({ ...ctxOf(store), actor: null })).toEqual([]);
  });
});
