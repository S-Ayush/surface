// PLAN-010 S2 web half (SPEC-010 §3.1, §7.1): the workflow page renders from the replica's rows.
// Statuses are grouped by category in page order, Triage is hidden, Duplicate is marked "System"
// and has no menu, the default status has its badge, issue counts show "—" until S5, each category
// but Duplicate has a "+", and a reader of a public team sees the page read-only. Server-rendered
// markup, as apps/web has no DOM test environment; the keys are `settings-row-keys.test.tsx` and
// the form and menu behaviour is covered by the model tests.
import { userActor, type Actor } from '@surface/domain';
import { Team, TeamMembership, User, WorkflowStatus } from '@surface/domain/model';
import type { SyncStore } from '@surface/sync-client';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppModel } from '../src/app/AppModel.js';
import { AuthState, type Session } from '../src/app/auth.js';
import { AppContext } from '../src/app/context.js';
import { WorkflowScreen } from '../src/features/statuses/WorkflowScreen.js';
import { ShellContext } from '../src/shell/ShellContext.js';
import { ShellStore } from '../src/shell/ShellStore.js';
import { ShortcutProvider } from '../src/shortcuts/ShortcutProvider.js';

const AT = '2026-11-12T10:00:00.000Z';
const TEAM = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
const BACKLOG = '0192f0c1-7e5a-7b3c-9d4e-0000000000b1';

const team = {
  id: TEAM,
  key: 'ENG',
  name: 'Engineering',
  icon: null,
  color: 'blue',
  timezone: 'UTC',
  private: false,
  defaultStatusId: BACKLOG,
};

let n = 0;
const status = (
  name: string,
  category: string,
  position: string,
  extra: { id?: string; description?: string | null } = {},
) => ({
  id: extra.id ?? `0192f0c1-7e5a-7b3c-9d4e-00000000${String(++n).padStart(4, '0')}`,
  teamId: TEAM,
  name,
  category,
  color: 'gray',
  description: extra.description ?? null,
  position,
  groups: ['workspace'],
  createdAt: AT,
  updatedAt: AT,
});

const STATUSES = [
  status('Triage', 'triage', 'a0'),
  status('Backlog', 'backlog', 'a0', { id: BACKLOG }),
  status('Todo', 'unstarted', 'a0'),
  status('In Review', 'started', 'a1', { description: 'Waiting for eyes' }),
  status('In Progress', 'started', 'a0'),
  status('Done', 'completed', 'a0'),
  status('Canceled', 'canceled', 'a0'),
  status('Duplicate', 'duplicate', 'a0'),
];

class FakeApp extends AppModel {
  readonly #store: SyncStore;

  constructor(
    private readonly memberOf: readonly string[],
    private readonly role: 'admin' | 'member' = 'member',
  ) {
    const unused = () => Promise.reject(new Error('unused'));
    super(new AuthState({ capabilities: unused, session: unused, login: unused, logout: unused }));
    const byModel = new Map<unknown, readonly unknown[]>([
      [Team, [team]],
      [TeamMembership, memberOf.map((teamId) => ({ teamId, userId: 'u-ada' }))],
      [
        User,
        [{ id: 'u-ada', name: 'Ada', displayName: 'ada', email: 'a@example.com', active: true }],
      ],
      [WorkflowStatus, STATUSES],
    ]);
    this.#store = {
      status: 'ready',
      connection: 'online',
      pool: {
        all: (model: unknown) => byModel.get(model) ?? [],
        get: (model: unknown, id: string) =>
          (byModel.get(model) ?? []).find((row) => (row as { id?: string }).id === id),
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
    userActor({
      userId: 'u-ada',
      role: this.role,
      memberships: this.memberOf.map((teamId) => ({ teamId, private: false })),
    });
}

async function render(app: AppModel, page: () => ReactNode): Promise<string> {
  const rootRoute = createRootRoute({ component: page });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/settings/teams/ENG/workflow'] }),
    origin: 'http://localhost',
    isServer: false,
    scrollRestoration: false,
  });
  await router.load();
  const html = renderToString(
    <AppContext value={app}>
      <ShellContext value={new ShellStore(null)}>
        <ShortcutProvider>
          <RouterProvider router={router} />
        </ShortcutProvider>
      </ShellContext>
    </AppContext>,
  );
  return html.replaceAll('<!-- -->', '');
}

const page = () => <WorkflowScreen params={{ key: 'ENG' }} />;

describe('Settings → Team → Workflow', () => {
  it('lists the categories in page order, with Triage hidden', async () => {
    const html = await render(new FakeApp([TEAM]), page);
    const titles = ['Backlog', 'Unstarted', 'Started', 'Completed', 'Canceled', 'Duplicate'];
    const at = titles.map((title) => html.indexOf(`>${title}</h3>`));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html).not.toContain('>Triage</h3>');
    expect(html).not.toContain('>Triage</span>');
  });

  it('orders statuses within a category by position', async () => {
    const html = await render(new FakeApp([TEAM]), page);
    expect(html.indexOf('In Progress</span>')).toBeLessThan(html.indexOf('In Review</span>'));
  });

  it('shows the description after the name, and the Default badge on the default status', async () => {
    const html = await render(new FakeApp([TEAM]), page);
    expect(html).toContain('· Waiting for eyes');
    expect(html).toMatch(/Backlog<\/span><span[^>]*>Default<\/span>/);
    expect(html.match(/>Default</g)).toHaveLength(1);
  });

  it('shows "—" for the issue count of every status until the server’s count arrives', async () => {
    const html = await render(new FakeApp([TEAM]), page);
    expect(html.match(/aria-label="Issue count not available">—</g)).toHaveLength(7);
  });

  it('offers "+" on every category but Duplicate, and a menu on every status but Duplicate', async () => {
    const html = await render(new FakeApp([TEAM]), page);
    for (const title of ['Backlog', 'Unstarted', 'Started', 'Completed', 'Canceled']) {
      expect(html, title).toContain(`aria-label="Add ${title} status"`);
    }
    expect(html).not.toContain('aria-label="Add Duplicate status"');
    expect(html).toContain('aria-label="Actions for In Review"');
    expect(html).not.toContain('aria-label="Actions for Duplicate"');
    expect(html).toContain('>System</span>');
  });

  it('makes each status an option of one listbox in the settings-row scope', async () => {
    const html = await render(new FakeApp([TEAM]), page);
    expect(html).toContain('role="listbox"');
    expect(html.match(/role="option"/g)).toHaveLength(7);
    expect(html.match(/data-shortcut-scope="settings-row"/g)).toHaveLength(7);
    // Roving tab stop: one row is tabbable, the others are not.
    expect(html.match(/role="option"[^>]*tabindex="0"/g)).toHaveLength(1);
  });

  it('is read-only for someone who is not a member, with "Join the team to edit"', async () => {
    const html = await render(new FakeApp([]), page);
    expect(html).toContain('Join the team to edit');
    expect(html).not.toContain('aria-label="Add Backlog status"');
    expect(html).not.toContain('aria-label="Actions for In Review"');
    expect(html).toContain('In Review</span>');
  });

  it('lets an Admin who is not a member edit', async () => {
    const html = await render(new FakeApp([], 'admin'), page);
    expect(html).not.toContain('Join the team to edit');
    expect(html).toContain('aria-label="Add Backlog status"');
  });
});
