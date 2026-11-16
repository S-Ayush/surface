// PLAN-012 S4 part 1, SPEC-012 §3.4 (AC-11 minus the activity stream, AC-17 rendering, E9 page
// part): the issue page renders from the replica's rows. Server-rendered markup, so no effects run
// here; keys, navigation and the not-found page are `issue-page-keys.test.tsx` and
// `issue-not-found.test.tsx` (jsdom), and the decisions behind it are unit-tested in
// issue-loader.test.ts, issue-source-list.test.ts and issue-url.test.ts.
import { userActor, type Actor } from '@surface/domain';
import { Issue, Team, TeamMembership, User, WorkflowStatus } from '@surface/domain/model';
import type { SyncStore } from '@surface/sync-client';
import { NO_CONTENT } from './content-stub.js';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppModel } from '../src/app/AppModel.js';
import { AuthState, type Session } from '../src/app/auth.js';
import { AppContext } from '../src/app/context.js';
import { TargetContext, TargetStore } from '../src/command-menu/context.js';
import { IssuePage } from '../src/features/issues/IssuePage.js';
import { LIST_SOURCE_STATE_KEY } from '../src/features/issues/focus-model.js';
import { ShellContext } from '../src/shell/ShellContext.js';
import { ShellStore } from '../src/shell/ShellStore.js';
import { ShortcutProvider } from '../src/shortcuts/ShortcutProvider.js';

const AT = '2026-11-12T10:00:00.000Z';
const TEAM = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
const STATUS = '0192f0c1-7e5a-7b3c-9d4e-0000000000c1';
const ISSUE_A = '0192f0c1-7e5a-7b3c-9d4e-0000000000b1';
const ISSUE_B = '0192f0c1-7e5a-7b3c-9d4e-0000000000b2';
const ISSUE_C = '0192f0c1-7e5a-7b3c-9d4e-0000000000b3';
const PENDING = '0192f0c1-7e5a-7b3c-9d4e-0000000000b4';
const LOST = '0192f0c1-7e5a-7b3c-9d4e-0000000000b5';

type Row = Record<string, unknown>;

const team = (extra: Row = {}): Row => ({
  id: TEAM,
  key: 'ENG',
  name: 'Engineering',
  private: false,
  estimateScale: 'fibonacci',
  estimateExtended: false,
  estimateAllowZero: false,
  ...extra,
});

const issue = (id: string, number: number | null, extra: Row = {}): Row => ({
  id,
  teamId: TEAM,
  number,
  title: 'Login page flickers',
  statusId: STATUS,
  priority: 2,
  assigneeId: 'u-ada',
  labelIds: [],
  estimate: null,
  dueDate: null,
  creatorId: 'u-ada',
  archivedAt: null,
  deletedAt: null,
  createdAt: '2026-11-06T10:00:00.000Z',
  updatedAt: AT,
  ...extra,
});

class FakeApp extends AppModel {
  readonly #store: SyncStore;

  constructor(rows: { issues: Row[]; team?: Row; rejections?: unknown[] }) {
    const unused = () => Promise.reject(new Error('unused'));
    super(new AuthState({ capabilities: unused, session: unused, login: unused, logout: unused }));
    const byModel = new Map<unknown, readonly Row[]>([
      [Team, [rows.team ?? team()]],
      [TeamMembership, [{ teamId: TEAM, userId: 'u-ada' }]],
      [User, [{ id: 'u-ada', name: 'Ada Lovelace', displayName: 'Ada', email: 'a@x.test' }]],
      [
        WorkflowStatus,
        [{ id: STATUS, teamId: TEAM, name: 'In Progress', category: 'started', color: 'yellow' }],
      ],
      [Issue, rows.issues],
    ]);
    this.#store = {
      status: 'ready',
      connection: 'online',
      rejections: rows.rejections ?? [],
      content: NO_CONTENT,
      pool: {
        all: (model: unknown) => byModel.get(model) ?? [],
        get: (model: unknown, id: string) =>
          (byModel.get(model) ?? []).find((row) => row['id'] === id),
        findBy: (model: unknown, field: string, value: unknown) =>
          (byModel.get(model) ?? []).filter((row) => row[field] === value),
      },
    } as unknown as SyncStore;
  }

  override get store(): SyncStore | null {
    return this.#store;
  }

  override get session(): Session {
    return { userId: 'u-ada', workspaceId: 'w-1' };
  }

  override actor = (): Actor | null =>
    userActor({ userId: 'u-ada', role: 'member', memberships: [{ teamId: TEAM, private: false }] });
}

async function render(
  app: AppModel,
  ref: string,
  state?: Record<string, unknown>,
): Promise<string> {
  const rootRoute = createRootRoute({ component: () => <IssuePage issueRef={ref} /> });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: [`/issue/${ref}`] }),
    origin: 'http://localhost',
    isServer: false,
    scrollRestoration: false,
  });
  await router.load();
  if (state !== undefined) await router.navigate({ to: `/issue/${ref}`, state });
  return renderToString(
    <AppContext value={app}>
      <ShellContext value={new ShellStore(null)}>
        <TargetContext value={new TargetStore()}>
          <ShortcutProvider>
            <RouterProvider router={router} />
          </ShortcutProvider>
        </TargetContext>
      </ShellContext>
    </AppContext>,
  );
}

const text = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replaceAll('&#x27;', "'")
    .replace(/\s+/g, ' ');

describe('IssuePage (AC-11)', () => {
  const app = new FakeApp({
    issues: [
      issue(ISSUE_A, 41),
      issue(ISSUE_B, 42, { estimate: 5, creatorId: 'u-ada' }),
      issue(ISSUE_C, 43, { estimate: 4 }),
    ],
  });

  it('shows the breadcrumb, title and properties of the replica’s row', async () => {
    const html = await render(app, 'ENG-42');
    const shown = text(html);
    expect(shown).toContain('ENG');
    expect(shown).toContain('ENG-42 Login page flickers');
    expect(html).toContain('Status: In Progress');
    expect(html).toContain('Priority: High');
    expect(html).toContain('Assignee: Ada');
    expect(shown).toContain('Created by Ada · Nov 6');
    expect(shown).toMatch(/Updated /);
    // The pills of a live issue open their pickers (PLAN-012 S6).
    expect(html).toContain('Status: In Progress, change');
  });

  it('shows an estimate on the team’s scale plainly and an off-scale one with a hint', async () => {
    expect(text(await render(app, 'ENG-42'))).not.toContain('Off scale');
    expect(text(await render(app, 'ENG-43'))).toContain('Off scale');
  });

  it('hides the estimate row when the team has no estimates and the issue has none', async () => {
    const off = new FakeApp({
      issues: [issue(ISSUE_A, 41), issue(ISSUE_B, 42, { estimate: 3 })],
      team: team({ estimateScale: 'off' }),
    });
    expect(await render(off, 'ENG-41')).not.toContain('Estimate');
    // An issue with a value still shows it, as off scale.
    const withValue = text(await render(off, 'ENG-42'));
    expect(withValue).toContain('Estimate');
    expect(withValue).toContain('Off scale');
  });

  it('shows the title as an edit button for a live issue', async () => {
    expect(await render(app, 'ENG-42')).toContain('Edit title');
  });

  it('shows no number for a pending issue and names it "New issue"', async () => {
    const pending = new FakeApp({ issues: [issue(PENDING, null)] });
    expect(text(await render(pending, PENDING))).toContain('New issue Login page flickers');
  });
});

describe('IssuePage source list (AC-17)', () => {
  const app = new FakeApp({ issues: [issue(ISSUE_A, 41), issue(ISSUE_B, 42), issue(ISSUE_C, 43)] });
  const state = {
    [LIST_SOURCE_STATE_KEY]: {
      href: '/team/ENG',
      routeKey: 'team:ENG',
      issueIds: [ISSUE_A, ISSUE_B, ISSUE_C],
    },
  };

  it('shows "2 / 3" with both step buttons in the middle of the list', async () => {
    const html = await render(app, 'ENG-42', state);
    expect(text(html)).toContain('2 / 3');
    expect(html).not.toMatch(/aria-label="Next issue"[^>]*disabled/);
    expect(html).not.toMatch(/aria-label="Previous issue"[^>]*disabled/);
  });

  it('disables the button at each end (E10)', async () => {
    const first = await render(app, 'ENG-41', state);
    expect(text(first)).toContain('1 / 3');
    expect(first).toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="Previous issue"|<button[^>]*aria-label="Previous issue"[^>]*disabled=""/,
    );
    const last = await render(app, 'ENG-43', state);
    expect(last).toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="Next issue"|<button[^>]*aria-label="Next issue"[^>]*disabled=""/,
    );
  });

  it('hides the position without a source list', async () => {
    const html = await render(app, 'ENG-42');
    expect(text(html)).not.toMatch(/\d+ \/ \d+/);
    expect(html).not.toContain('Next issue');
  });
});

describe('IssuePage read-only and held states (SPEC-012 §3.4 items 8; E9)', () => {
  it('shows an archived row of the replica with its badge, its crumb and pills that don’t open', async () => {
    const app = new FakeApp({ issues: [issue(ISSUE_A, 41, { archivedAt: AT })] });
    const html = await render(app, 'ENG-41');
    const shown = text(html);
    expect(shown).toContain('Archived issues');
    expect(shown).toContain('Archived');
    expect(html).not.toContain('Edit title');
    expect(html).not.toContain(', change');
  });

  it('shows a deleted row with the Deleted badge and the Recently deleted crumb', async () => {
    const app = new FakeApp({ issues: [issue(ISSUE_A, 41, { deletedAt: AT })] });
    const shown = text(await render(app, 'ENG-41'));
    expect(shown).toContain('Recently deleted issues');
    expect(shown).toContain('Deleted');
  });

  it('says why a pending issue’s create was rejected, with Restore in composer (E9)', async () => {
    const app = new FakeApp({
      issues: [],
      rejections: [{ op: 'issue.create', input: { id: LOST }, message: 'Title is required.' }],
    });
    const shown = text(await render(app, LOST));
    expect(shown).toContain("This issue couldn't be created: Title is required.");
    expect(shown).toContain('Restore in composer');
  });
});
