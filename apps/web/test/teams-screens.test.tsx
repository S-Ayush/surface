// PLAN-001 S8 web half: the team screens render from the store's rows (SPEC-001 §3.7). Settings →
// Teams lists every visible team with Join or Leave; E12/D3: the last member of a private team
// can't leave or be removed; non-members see a team's settings read-only; a team the user can't
// see is not found (permissions.md §5).
import { userActor, type Actor } from '@surface/domain';
import { Team, TeamMembership, User } from '@surface/domain/model';
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
import { AuthState, preAuthClient, type Session } from '../src/app/auth.js';
import { AppContext } from '../src/app/context.js';
import type { MembershipRow, TeamRow, UserRow } from '../src/features/teams/model.js';
import { TeamGeneralScreen } from '../src/features/teams/TeamGeneralScreen.js';
import { TeamMembersScreen } from '../src/features/teams/TeamMembersScreen.js';
import { LEAVE_BLOCKED_LABEL, TeamMenu, teamMenuItems } from '../src/features/teams/TeamMenu.js';
import { TeamsScreen } from '../src/features/teams/TeamsScreen.js';
import { canCreateTeam, TeamsHost } from '../src/features/teams/TeamsHost.js';
import { SHELL_HOSTS, TEAM_MENU } from '../src/features/hosts.js';
import { ShellContext } from '../src/shell/ShellContext.js';
import { ShellStore } from '../src/shell/ShellStore.js';
import { ShortcutProvider, useCommandRegistry } from '../src/shortcuts/ShortcutProvider.js';

type Rows = {
  readonly teams: TeamRow[];
  readonly memberships: MembershipRow[];
  readonly users: UserRow[];
};

/** An AppModel over fixed rows; `rows: null` is a store that is still loading. */
class FakeApp extends AppModel {
  readonly #store: SyncStore | null;

  constructor(
    rows: Rows | null,
    private readonly me: string,
    private readonly role: 'admin' | 'member' = 'member',
  ) {
    super(new AuthState(preAuthClient(() => Promise.reject(new Error('unused')))));
    const byModel = new Map<unknown, readonly unknown[]>(
      rows === null
        ? []
        : [
            [Team, rows.teams],
            [TeamMembership, rows.memberships],
            [User, rows.users],
          ],
    );
    const pool = {
      all: (model: unknown) => byModel.get(model) ?? [],
      get: (model: unknown, id: string) =>
        (byModel.get(model) ?? []).find((row) => (row as { id?: string }).id === id),
    };
    // Only what the team screens read; the real store is covered by sync-client's own tests.
    this.#store = {
      status: rows === null ? 'loading' : 'ready',
      connection: 'online',
      pool,
    } as unknown as SyncStore;
    this.rows = rows;
  }

  readonly rows: Rows | null;

  override get store(): SyncStore | null {
    return this.#store;
  }

  override get session(): Session {
    return { userId: this.me, workspaceId: 'w-1' };
  }

  override actor = (): Actor | null =>
    this.rows === null
      ? null
      : userActor({
          userId: this.me,
          role: this.role,
          memberships: this.rows.memberships
            .filter((m) => m.userId === this.me)
            .map((m) => ({
              teamId: m.teamId,
              private: this.rows?.teams.find((t) => t.id === m.teamId)?.private ?? false,
            })),
        });
}

/** Stands in for TeamsHost: registers Create team during render (SSR runs no effects). */
function CreateTeamHandler() {
  useCommandRegistry().register('form:create-team', { run: () => undefined });
  return null;
}

async function render(
  app: AppModel,
  page: () => ReactNode,
  { createTeam = true }: { readonly createTeam?: boolean } = {},
): Promise<string> {
  const rootRoute = createRootRoute({ component: page });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ['/settings/teams'] }),
    origin: 'http://localhost',
    isServer: false,
    scrollRestoration: false,
  });
  await router.load();
  const html = renderToString(
    <AppContext value={app}>
      <ShellContext value={new ShellStore(null)}>
        <ShortcutProvider>
          {createTeam && <CreateTeamHandler />}
          <RouterProvider router={router} />
        </ShortcutProvider>
      </ShellContext>
    </AppContext>,
  );
  // React separates adjacent text with comments; drop them so text reads as shown.
  return html.replaceAll('<!-- -->', '');
}

const team = (id: string, key: string, name: string, priv = false): TeamRow => ({
  id,
  key,
  name,
  icon: null,
  color: 'blue',
  timezone: 'UTC',
  private: priv,
});
const user = (id: string, name: string): UserRow => ({
  id,
  name,
  displayName: name.toLowerCase(),
  email: `${name.toLowerCase()}@example.com`,
  active: true,
});

const ROWS: Rows = {
  teams: [
    team('t-eng', 'ENG', 'Engineering'),
    team('t-sec', 'SEC', 'Security', true),
    team('t-des', 'DES', 'Design'),
  ],
  memberships: [
    { teamId: 't-eng', userId: 'u-ada' },
    { teamId: 't-eng', userId: 'u-iris' },
    { teamId: 't-sec', userId: 'u-ada' },
  ],
  users: [user('u-ada', 'Ada'), user('u-iris', 'Iris'), user('u-zoe', 'Zoe')],
};

const NOT_FOUND = 'This page doesn&#x27;t exist';
const REASON = 'A private team needs at least one member.';

/**
 * The opening tag of the one button with this accessible name or text. Fails the test when there
 * is none, so "not disabled" can't pass on a missing button.
 */
function buttonTag(html: string, name: string): string {
  const tags = [
    ...html.matchAll(new RegExp(`<button[^>]*aria-label="${name}"[^>]*>`, 'g')),
    ...html.matchAll(new RegExp(`<button[^>]*>(?=<span[^>]*>${name}</span>)`, 'g')),
  ].map((match) => match[0]);
  expect(tags, `one button "${name}"`).toHaveLength(1);
  return tags[0] ?? '';
}
const hasButton = (html: string, name: string): boolean =>
  new RegExp(`<button[^>]*aria-label="${name}"|<button[^>]*><span[^>]*>${name}</span>`).test(html);

describe('Settings → Teams', () => {
  it('lists every visible team with its member count and Join or Leave', async () => {
    const html = await render(new FakeApp(ROWS, 'u-ada'), () => <TeamsScreen params={{}} />);
    expect(html.indexOf('Design')).toBeLessThan(html.indexOf('Engineering'));
    expect(html).toContain('2 members');
    expect(html).toContain('1 member · Private');
    expect(buttonTag(html, 'Join Design')).not.toContain('disabled');
    expect(buttonTag(html, 'Leave Engineering')).not.toContain('disabled');
  });

  it('won’t let the last member of a private team leave, and says why (E12, D3)', async () => {
    const html = await render(new FakeApp(ROWS, 'u-ada'), () => <TeamsScreen params={{}} />);
    const leave = buttonTag(html, 'Leave Security');
    expect(leave).toContain('disabled=""');
    // The reason is visible text the button points to, not only a tooltip.
    const describedBy = /aria-describedby="([^"]+)"/.exec(leave)?.[1];
    expect(describedBy).toBeDefined();
    expect(html).toContain(`id="${describedBy ?? ''}" class="_reason`);
    expect(html).toMatch(new RegExp(`id="${describedBy ?? ''}"[^>]*>${REASON}`));
  });

  it('offers Create team through the shell’s command, only while it is available', async () => {
    const ready = await render(new FakeApp(ROWS, 'u-ada'), () => <TeamsScreen params={{}} />);
    expect(buttonTag(ready, 'Create team')).not.toContain('disabled');
    const unavailable = await render(
      new FakeApp(ROWS, 'u-ada'),
      () => <TeamsScreen params={{}} />,
      {
        createTeam: false,
      },
    );
    expect(buttonTag(unavailable, 'Create team')).toContain('disabled=""');
  });

  it('shows a loading state, then an empty state with no teams', async () => {
    const loading = await render(new FakeApp(null, 'u-ada'), () => <TeamsScreen params={{}} />);
    expect(loading).toContain('aria-label="Loading teams"');
    const empty = { teams: [], memberships: [], users: ROWS.users };
    const none = await render(new FakeApp(empty, 'u-ada'), () => <TeamsScreen params={{}} />);
    expect(none).toContain('No teams yet');
  });
});

describe('Team settings → General', () => {
  it('lets a member edit everything but the key', async () => {
    const html = await render(new FakeApp(ROWS, 'u-iris'), () => (
      <TeamGeneralScreen params={{ key: 'eng' }} />
    ));
    expect(html).toContain('value="Engineering"');
    expect(hasButton(html, 'Save changes')).toBe(true);
    expect(html).toContain('aria-label="Team color"');
    expect(html).not.toContain('Only members of ENG and Admins');
    expect(html).toMatch(
      /<input[^>]*readOnly=""[^>]*value="ENG"|<input[^>]*value="ENG"[^>]*readOnly=""/,
    );
  });

  it('shows a non-member the settings read-only, with no picker to operate', async () => {
    const zoe = await render(new FakeApp(ROWS, 'u-zoe'), () => (
      <TeamGeneralScreen params={{ key: 'ENG' }} />
    ));
    expect(zoe).toContain('Only members of ENG and Admins can change these settings.');
    expect(hasButton(zoe, 'Save changes')).toBe(false);
    expect(zoe).not.toContain('aria-label="Team color"');
    expect(zoe).toMatch(/class="_swatch[^"]*"[^>]*><\/span>blue/);
  });

  it('lets an Admin who isn’t a member edit', async () => {
    const admin = await render(new FakeApp(ROWS, 'u-zoe', 'admin'), () => (
      <TeamGeneralScreen params={{ key: 'ENG' }} />
    ));
    expect(hasButton(admin, 'Save changes')).toBe(true);
  });

  it('is not found for a team the user can’t see (permissions.md §5)', async () => {
    const html = await render(new FakeApp(ROWS, 'u-zoe'), () => (
      <TeamGeneralScreen params={{ key: 'OPS' }} />
    ));
    expect(html).toContain(NOT_FOUND);
  });
});

describe('Team settings → Members', () => {
  it('lists the members, with Add member, Remove and Leave for a member', async () => {
    const html = await render(new FakeApp(ROWS, 'u-ada'), () => (
      <TeamMembersScreen params={{ key: 'ENG' }} />
    ));
    expect(html).toContain('2 members');
    expect(html).toContain('Ada (you)');
    expect(html).toContain('@iris · iris@example.com');
    expect(buttonTag(html, 'Add member')).not.toContain('disabled');
    expect(buttonTag(html, 'Leave')).not.toContain('disabled');
    expect(buttonTag(html, 'Remove')).not.toContain('disabled');
    expect(html).not.toContain(REASON);
  });

  it('won’t remove the last member of a private team, and says why (E12, D3)', async () => {
    const html = await render(new FakeApp(ROWS, 'u-ada'), () => (
      <TeamMembersScreen params={{ key: 'SEC' }} />
    ));
    const leave = buttonTag(html, 'Leave');
    expect(leave).toContain('disabled=""');
    const describedBy = /aria-describedby="([^"]+)"/.exec(leave)?.[1];
    expect(html).toMatch(new RegExp(`id="${describedBy ?? 'missing'}"[^>]*>${REASON}`));
  });

  it('shows a non-member the list without add or remove', async () => {
    const html = await render(new FakeApp(ROWS, 'u-zoe'), () => (
      <TeamMembersScreen params={{ key: 'ENG' }} />
    ));
    expect(html).toContain('Only members of ENG and Admins can add or remove members.');
    // The list itself is there; only the controls are not.
    expect(html).toContain('@iris · iris@example.com');
    expect(hasButton(html, 'Add member')).toBe(false);
    expect(hasButton(html, 'Remove')).toBe(false);
    expect(hasButton(html, 'Leave')).toBe(false);
  });
});

describe('TeamMenu', () => {
  it('renders for a visible team and nothing for one the user can’t see', async () => {
    const eng = await render(new FakeApp(ROWS, 'u-ada'), () => (
      <TeamMenu team={{ id: 't-eng', key: 'ENG', name: 'Engineering' }} />
    ));
    expect(buttonTag(eng, 'Engineering options')).not.toBe('');
    const ops = await render(new FakeApp(ROWS, 'u-ada'), () => (
      <TeamMenu team={{ id: 't-ops', key: 'OPS', name: 'Ops' }} />
    ));
    // Only the router's Suspense markers: no menu at all.
    expect(ops.replaceAll(/<!--\/?\$-->/g, '')).toBe('');
  });

  it('offers Join to a non-member, Leave to a member, and says why Leave is blocked (E12)', () => {
    const actions = { join: () => undefined, leave: () => undefined, settings: () => undefined };
    const labels = (member: boolean, canEnd: boolean) =>
      teamMenuItems({ member, canEnd }, actions).map((item): [string, boolean] => [
        'label' in item ? item.label : item.type,
        'disabled' in item && item.disabled === true,
      ]);
    expect(labels(false, true)).toEqual([
      ['Join team', false],
      ['Team settings', false],
    ]);
    expect(labels(true, true)).toEqual([
      ['Leave team', false],
      ['Team settings', false],
    ]);
    expect(labels(true, false)).toEqual([
      [LEAVE_BLOCKED_LABEL, true],
      ['Team settings', false],
    ]);
  });
});

describe('the shell hooks (features/hosts.ts)', () => {
  it('mounts the teams host and sets the team ⋯ menu', () => {
    expect(SHELL_HOSTS).toContain(TeamsHost);
    expect(TEAM_MENU).toBe(TeamMenu);
  });

  it('offers Create team only once the replica is ready and someone is signed in', () => {
    const ready = new FakeApp(ROWS, 'u-ada');
    expect(canCreateTeam(ready)).toBe(true);
    expect(canCreateTeam(new FakeApp(null, 'u-ada'))).toBe(false);
    expect(canCreateTeam({ store: ready.store, session: null })).toBe(false);
    expect(canCreateTeam({ store: null, session: ready.session })).toBe(false);
  });
});
