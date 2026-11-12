// PLAN-001 S7 web half: Settings → Members lists everyone from the store's rows with role, teams
// and join date, filtered by role (SPEC-001 §3.6); the last Admin can't be made a Member, and the
// screen says why (INV-01, E6, AC-10); the reset-link modal asks first, then shows the link once
// (§3.3, AC-3). Settings → Workspace renames the workspace. That Members get not-found on both
// pages is settings-page.test.tsx (AC-14).
import { LAST_ADMIN_MESSAGE, userActor, type Actor, type UserRole } from '@surface/domain';
import { Team, TeamMembership, User, Workspace } from '@surface/domain/model';
import { CSRF_HEADER } from '@surface/sync-protocol';
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
import { httpMembersApi, UNREACHABLE, type MembersApi } from '../src/features/members/api.js';
import { memberMenuItems, MembersScreen } from '../src/features/members/MembersScreen.js';
import {
  joinedText,
  memberCountText,
  memberList,
  type MemberMembershipRow,
  type MemberTeamRow,
  type MemberUserRow,
} from '../src/features/members/model.js';
import type { AnyOperation } from '@surface/operations';
import type { MutationOutcome } from '@surface/sync-client';
import { changeRole, demoteSelf, roleChoice } from '../src/features/members/actions.js';
import {
  ASK,
  copyText,
  mayClose,
  ResetLinkFlow,
  resetLinkIntro,
  resetLinkShownNote,
  type ResetLinkView,
} from '../src/features/members/reset-link.js';
import { QUEUED_NOTE, saveWorkspaceName } from '../src/features/workspace/save.js';
import {
  NO_WORKSPACE,
  workspaceNameProblem,
  WorkspaceScreen,
} from '../src/features/workspace/WorkspaceScreen.js';

const JOINED = '2026-11-07T12:00:00.000Z';

const person = (
  id: string,
  name: string,
  role: UserRole = 'member',
  extra: Partial<MemberUserRow> = {},
): MemberUserRow => ({
  id,
  name,
  displayName: name.toLowerCase(),
  email: `${name.toLowerCase()}@example.com`,
  role,
  active: true,
  createdAt: JOINED,
  ...extra,
});

const TEAMS: MemberTeamRow[] = [
  { id: 't-eng', key: 'ENG' },
  { id: 't-des', key: 'DES' },
  { id: 't-old', key: 'OLD', $archived: true },
];
const MEMBERSHIPS: MemberMembershipRow[] = [
  { teamId: 't-eng', userId: 'u-ada' },
  { teamId: 't-des', userId: 'u-ada' },
  { teamId: 't-old', userId: 'u-ada' },
  { teamId: 't-eng', userId: 'u-iris' },
];

describe('memberList', () => {
  const users = [
    person('u-zoe', 'Zoe'),
    person('u-ada', 'Ada', 'admin'),
    person('u-iris', 'Iris'),
    person('u-gone', 'Gone', 'admin', { active: false }),
    person('u-arch', 'Archived', 'member', { $archived: true }),
  ];

  it('lists active people by name, with their teams’ keys and join date', () => {
    const list = memberList(users, TEAMS, MEMBERSHIPS, 'u-iris');
    expect(list.map((m) => m.name)).toEqual(['Ada', 'Iris', 'Zoe']);
    expect(list.map((m) => m.teams)).toEqual([['DES', 'ENG'], ['ENG'], []]);
    expect(list[0]?.joined.toISOString()).toBe(JOINED);
    expect(list.map((m) => m.self)).toEqual([false, true, false]);
  });

  it('filters by role', () => {
    expect(memberList(users, TEAMS, MEMBERSHIPS, 'u-ada', 'admin').map((m) => m.name)).toEqual([
      'Ada',
    ]);
    expect(memberList(users, TEAMS, MEMBERSHIPS, 'u-ada', 'member').map((m) => m.name)).toEqual([
      'Iris',
      'Zoe',
    ]);
  });

  it('marks the only active Admin as the last one, and nobody once there are two (INV-01)', () => {
    // A deactivated Admin doesn't count.
    const one = memberList(users, TEAMS, MEMBERSHIPS, 'u-ada');
    expect(one.filter((m) => m.lastAdmin).map((m) => m.name)).toEqual(['Ada']);
    const two = memberList(
      [...users, person('u-bea', 'Bea', 'admin')],
      TEAMS,
      MEMBERSHIPS,
      'u-ada',
    );
    expect(two.some((m) => m.lastAdmin)).toBe(false);
  });

  it('marks the last Admin even when the filter hides the other people', () => {
    const admins = memberList(users, TEAMS, MEMBERSHIPS, 'u-ada', 'admin');
    expect(admins.map((m) => m.lastAdmin)).toEqual([true]);
  });
});

describe('member texts', () => {
  it('counts what the filter shows', () => {
    expect(memberCountText(1, 'all')).toBe('1 person');
    expect(memberCountText(3, 'all')).toBe('3 people');
    expect(memberCountText(1, 'admin')).toBe('1 Admin');
    expect(memberCountText(2, 'member')).toBe('2 Members');
  });

  it('says when someone joined', () => {
    expect(joinedText(new Date(JOINED), 'en-US')).toBe('Joined Nov 7, 2026');
  });
});

describe('memberMenuItems', () => {
  const [ada] = memberList([person('u-ada', 'Ada', 'admin')], [], [], 'u-ada');
  const [iris] = memberList(
    [person('u-ada', 'Ada', 'admin'), person('u-iris', 'Iris')],
    [],
    [],
    'u-ada',
  ).filter((m) => m.name === 'Iris');

  function itemsFor(member: typeof ada) {
    if (member === undefined) throw new Error('missing member');
    const calls: string[] = [];
    const items = memberMenuItems(member, {
      setRole: (role) => calls.push(`role:${role}`),
      resetLink: () => calls.push('reset'),
    });
    return { items, calls };
  }

  it('offers the role, with Member disabled for the last Admin (E6)', () => {
    const { items } = itemsFor(ada);
    const role = items[0];
    expect(role?.type).toBe('radio');
    if (role?.type !== 'radio') return;
    expect(role.value).toBe('admin');
    expect(role.options).toEqual([
      { value: 'admin', label: 'Admin' },
      { value: 'member', label: 'Member', disabled: true },
    ]);
  });

  it('changes the role and opens the reset link', () => {
    const { items, calls } = itemsFor(iris);
    const [role, reset] = items;
    if (role?.type !== 'radio' || reset?.type !== 'item') throw new Error('unexpected items');
    expect(role.options[1]?.disabled).toBe(false);
    role.onValueChange('admin');
    role.onValueChange('owner');
    reset.onSelect();
    expect(reset.label).toBe('Generate reset link…');
    expect(calls).toEqual(['role:admin', 'reset']);
  });
});

describe('ResetLinkFlow', () => {
  const EXPIRES = new Date('2026-11-07T13:00:00.000Z');

  function flowWith(answer: () => ReturnType<MembersApi['createResetLink']>) {
    const views: ResetLinkView[] = [];
    const asked: string[] = [];
    const api: MembersApi = {
      createResetLink: (userId) => {
        asked.push(userId);
        return answer();
      },
    };
    return { flow: new ResetLinkFlow(api, (view) => views.push(view)), views, asked };
  }

  it('asks first, then shows the link', async () => {
    const { flow, views, asked } = flowWith(() =>
      Promise.resolve({ ok: true, url: 'https://s.example/reset?token=t', expiresAt: EXPIRES }),
    );
    expect(flow.view).toEqual(ASK);
    await flow.generate('u-iris');
    expect(asked).toEqual(['u-iris']);
    expect(views).toEqual([
      { phase: 'ask', busy: true, error: null },
      { phase: 'shown', url: 'https://s.example/reset?token=t', expiresAt: EXPIRES },
    ]);
  });

  it('sends one request at a time, and none once the link is shown', async () => {
    let resolve: (value: Awaited<ReturnType<MembersApi['createResetLink']>>) => void = () => {};
    const { flow, asked } = flowWith(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const first = flow.generate('u-iris');
    void flow.generate('u-iris');
    resolve({ ok: true, url: 'https://s.example/reset?token=t', expiresAt: EXPIRES });
    await first;
    await flow.generate('u-iris');
    expect(asked).toEqual(['u-iris']);
  });

  it('shows a refusal and lets the Admin try again', async () => {
    const { flow, views } = flowWith(() =>
      Promise.resolve({ ok: false, message: 'Only Admins can do this.' }),
    );
    await flow.generate('u-iris');
    expect(views.at(-1)).toEqual({ phase: 'ask', busy: false, error: 'Only Admins can do this.' });
  });

  it('says what the link does, for someone else and for yourself', () => {
    expect(resetLinkIntro('Iris', false)).toBe(
      'Generate a link for Iris to choose a new password. It works once, for 1 hour. Their earlier reset links stop working.',
    );
    expect(resetLinkIntro('Ada', true)).toContain('for you to choose');
    expect(resetLinkShownNote('Iris', false)).toBe(
      'Shown only this once. Send it to Iris directly. Using it logs them out everywhere.',
    );
    expect(resetLinkShownNote('Ada', true)).toBe(
      'Shown only this once. Using it logs you out everywhere.',
    );
  });
});

describe('httpMembersApi.createResetLink', () => {
  const LINK = {
    url: 'https://surface.example.com/reset?token=abc',
    expiresAt: '2026-11-07T13:00:00.000Z',
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  it('runs user.createResetLink with the CSRF token, and returns the link', async () => {
    const sent: { url: string; init: RequestInit | undefined }[] = [];
    const api = httpMembersApi(
      (url, init) => {
        sent.push({ url, init });
        return Promise.resolve(json(200, { ok: true, result: LINK }));
      },
      () => 'surface_csrf=tok',
    );
    expect(await api.createResetLink('u-iris')).toEqual({
      ok: true,
      url: LINK.url,
      expiresAt: new Date(LINK.expiresAt),
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('/api/ops/user.createResetLink');
    expect(sent[0]?.init?.method).toBe('POST');
    const body = sent[0]?.init?.body;
    expect(typeof body === 'string' ? JSON.parse(body) : body).toEqual({
      input: { user: 'u-iris' },
    });
    expect(new Headers(sent[0]?.init?.headers).get(CSRF_HEADER)).toBe('tok');
  });

  it('shows a refusal’s message, but never a server failure’s', async () => {
    const refused = httpMembersApi(
      () =>
        Promise.resolve(
          json(403, {
            ok: false,
            error: { code: 'FORBIDDEN', message: 'Only Admins can do this.', correlationId: 'c' },
          }),
        ),
      () => '',
    );
    expect(await refused.createResetLink('u-iris')).toEqual({
      ok: false,
      message: 'Only Admins can do this.',
    });
    const failed = httpMembersApi(
      () =>
        Promise.resolve(
          json(500, { ok: false, error: { code: 'INTERNAL', message: 'db exploded' } }),
        ),
      () => '',
    );
    expect(await failed.createResetLink('u-iris')).toEqual({ ok: false, message: UNREACHABLE });
  });

  it('says it couldn’t reach Surface when offline or the answer isn’t a link', async () => {
    const offline = httpMembersApi(
      () => Promise.reject(new TypeError('fetch failed')),
      () => '',
    );
    expect(await offline.createResetLink('u-iris')).toEqual({ ok: false, message: UNREACHABLE });
    const odd = httpMembersApi(
      () => Promise.resolve(json(200, { ok: true, result: { url: 'not a url' } })),
      () => '',
    );
    expect(await odd.createResetLink('u-iris')).toEqual({ ok: false, message: UNREACHABLE });
  });
});

describe('workspaceNameProblem', () => {
  it('uses the operation’s words', () => {
    expect(workspaceNameProblem('Acme')).toBeUndefined();
    expect(workspaceNameProblem('   ')).toBe('Workspace name is required, like Acme');
    expect(workspaceNameProblem('x'.repeat(81))).toBe(
      'Workspace name must be 80 characters or fewer',
    );
  });
});

describe('the reset-link modal', () => {
  it('stays open while a link is being generated, and only then', () => {
    expect(mayClose(ASK)).toBe(true);
    expect(mayClose({ phase: 'ask', busy: true, error: null })).toBe(false);
    expect(mayClose({ phase: 'ask', busy: false, error: 'No such user.' })).toBe(true);
    expect(
      mayClose({ phase: 'shown', url: 'https://s.example/reset?token=t', expiresAt: new Date() }),
    ).toBe(true);
  });

  it('copies the link, and says so when the browser can’t', async () => {
    const written: string[] = [];
    expect(
      await copyText('u', {
        writeText: (text) => {
          written.push(text);
          return Promise.resolve();
        },
      }),
    ).toBe(true);
    expect(written).toEqual(['u']);
    // A plain-http address has no clipboard at all (not a secure context).
    expect(await copyText('u', undefined)).toBe(false);
    expect(await copyText('u', { writeText: () => Promise.reject(new Error('denied')) })).toBe(
      false,
    );
    expect(
      await copyText('u', {
        writeText: () => {
          throw new Error('not allowed');
        },
      }),
    ).toBe(false);
  });
});

/** A store for the mutation helpers: records what it is sent, answers with `outcome`. */
function fakeStore(
  outcome: MutationOutcome | Error = { status: 'confirmed' },
  connection = 'online',
) {
  const sent: { op: string; input: unknown }[] = [];
  const store = {
    connection,
    dispatch: (op: AnyOperation, input: unknown) => {
      if (outcome instanceof Error) throw outcome;
      sent.push({ op: op.name, input });
      return Promise.resolve(outcome);
    },
  };
  return { store, sent };
}

describe('the role menu’s actions', () => {
  it('does nothing for the role someone has, and asks before you make yourself a Member', () => {
    expect(roleChoice({ role: 'admin', self: false }, 'admin')).toBe('nothing');
    expect(roleChoice({ role: 'member', self: false }, 'admin')).toBe('change');
    expect(roleChoice({ role: 'admin', self: false }, 'member')).toBe('change');
    expect(roleChoice({ role: 'admin', self: true }, 'member')).toBe('confirm');
    expect(roleChoice({ role: 'admin', self: true }, 'admin')).toBe('nothing');
  });

  it('sends user.setRole for the person', async () => {
    const { store, sent } = fakeStore();
    expect(await changeRole(store, 'u-iris', 'admin')).toEqual({ kind: 'confirmed' });
    expect(sent).toEqual([{ op: 'user.setRole', input: { user: 'u-iris', role: 'admin' } }]);
  });

  it('leaves Members before making you a Member', async () => {
    const steps: string[] = [];
    const { store, sent } = fakeStore();
    const dispatch = store.dispatch;
    store.dispatch = (op, input) => {
      steps.push('dispatch');
      return dispatch(op, input);
    };
    await demoteSelf(store, 'u-ada', () => steps.push('leave'));
    expect(steps).toEqual(['leave', 'dispatch']);
    expect(sent).toEqual([{ op: 'user.setRole', input: { user: 'u-ada', role: 'member' } }]);
  });
});

describe('saveWorkspaceName', () => {
  it('sends nothing for the saved name or an invalid one', async () => {
    const { store, sent } = fakeStore();
    expect(await saveWorkspaceName(store, ' Acme ', 'Acme')).toEqual({ kind: 'skipped' });
    expect(await saveWorkspaceName(store, '  ', 'Acme')).toEqual({ kind: 'skipped' });
    expect(sent).toEqual([]);
  });

  it('is saved once the server confirms it', async () => {
    const { store, sent } = fakeStore();
    expect(await saveWorkspaceName(store, 'Acme Labs', 'Acme')).toEqual({ kind: 'saved' });
    expect(sent).toEqual([{ op: 'workspace.update', input: { name: 'Acme Labs' } }]);
  });

  it('shows the server’s refusal, or why the store didn’t take it', async () => {
    const rejected = fakeStore({
      status: 'rejected',
      error: { code: 'FORBIDDEN', message: 'Only Admins can rename the workspace.' },
    });
    expect(await saveWorkspaceName(rejected.store, 'Acme Labs', 'Acme')).toEqual({
      kind: 'error',
      message: 'Only Admins can rename the workspace.',
    });
    const failed = fakeStore(new Error('The store is not ready.'));
    expect(await saveWorkspaceName(failed.store, 'Acme Labs', 'Acme')).toEqual({
      kind: 'error',
      message: 'The store is not ready.',
    });
  });

  it('keeps the edit with a note while offline', async () => {
    const { store, sent } = fakeStore({ status: 'confirmed' }, 'offline');
    expect(await saveWorkspaceName(store, 'Acme Labs', 'Acme')).toEqual({
      kind: 'queued',
      note: QUEUED_NOTE,
    });
    expect(sent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
// The screens, rendered from fixed store rows

type Rows = {
  readonly users: MemberUserRow[];
  readonly teams: MemberTeamRow[];
  readonly memberships: MemberMembershipRow[];
  readonly workspace: { readonly id: string; readonly name: string }[];
};

/** An AppModel over fixed rows; `rows: null` is a store that is still loading. */
class FakeApp extends AppModel {
  readonly #store: SyncStore | null;

  constructor(
    private readonly rows: Rows | null,
    private readonly me: string,
  ) {
    const unused = () => Promise.reject(new Error('unused'));
    super(new AuthState({ capabilities: unused, session: unused, login: unused, logout: unused }));
    const byModel = new Map<unknown, readonly unknown[]>(
      rows === null
        ? []
        : [
            [User, rows.users],
            [Team, rows.teams],
            [TeamMembership, rows.memberships],
            [Workspace, rows.workspace],
          ],
    );
    // Only what these screens read; the real store is covered by sync-client's own tests.
    this.#store = {
      status: rows === null ? 'loading' : 'ready',
      connection: 'online',
      pool: { all: (model: unknown) => byModel.get(model) ?? [] },
    } as unknown as SyncStore;
  }

  override get store(): SyncStore | null {
    return this.#store;
  }

  override get session(): Session {
    return { userId: this.me, workspaceId: 'w-1' };
  }

  override actor = (): Actor | null =>
    this.rows === null ? null : userActor({ userId: this.me, role: 'admin', memberships: [] });
}

async function render(app: AppModel, page: () => ReactNode): Promise<string> {
  const router = createRouter({
    routeTree: createRootRoute({ component: page }),
    history: createMemoryHistory({ initialEntries: ['/settings/members'] }),
    origin: 'http://localhost',
    isServer: false,
    scrollRestoration: false,
  });
  await router.load();
  const html = renderToString(
    <AppContext value={app}>
      <RouterProvider router={router} />
    </AppContext>,
  );
  // React separates adjacent text with comments; drop them so text reads as shown.
  return html.replaceAll('<!-- -->', '');
}

const ROWS: Rows = {
  users: [person('u-ada', 'Ada', 'admin'), person('u-iris', 'Iris'), person('u-zoe', 'Zoe')],
  teams: TEAMS,
  memberships: MEMBERSHIPS,
  workspace: [{ id: 'w-1', name: 'Acme' }],
};

describe('MembersScreen', () => {
  it('lists everyone with role, teams and join date, marking you', async () => {
    const html = await render(new FakeApp(ROWS, 'u-ada'), () => <MembersScreen params={{}} />);
    expect(html).toContain('Ada (you)');
    expect(html).toContain('@iris · iris@example.com');
    expect(html).toContain('DES, ENG · Joined');
    expect(html).toContain('No teams · Joined');
    expect(html).toContain('>Admin</span>');
    expect(html).toContain('>Member</span>');
    expect(html).toContain('3 people');
    expect(html).toContain('aria-label="More actions for Iris"');
  });

  it('says why the only Admin can’t become a Member (E6)', async () => {
    const html = await render(new FakeApp(ROWS, 'u-ada'), () => <MembersScreen params={{}} />);
    expect(html).toContain(LAST_ADMIN_MESSAGE);
    const two = { ...ROWS, users: [...ROWS.users, person('u-bea', 'Bea', 'admin')] };
    const html2 = await render(new FakeApp(two, 'u-ada'), () => <MembersScreen params={{}} />);
    expect(html2).not.toContain(LAST_ADMIN_MESSAGE);
  });

  it('offers Invite member and lists the pending invites (PLAN-001 S5)', async () => {
    const html = await render(new FakeApp(ROWS, 'u-ada'), () => <MembersScreen params={{}} />);
    expect(html).toContain('>Invite member</span></button>');
    expect(html).toContain('Pending invites');
  });

  it('waits while the store loads', async () => {
    const html = await render(new FakeApp(null, 'u-ada'), () => <MembersScreen params={{}} />);
    expect(html).not.toContain('More actions');
  });
});

describe('WorkspaceScreen', () => {
  it('says so when the store has no workspace row', async () => {
    const html = await render(new FakeApp({ ...ROWS, workspace: [] }, 'u-ada'), () => (
      <WorkspaceScreen params={{}} />
    ));
    expect(html).toContain(NO_WORKSPACE);
  });

  it('shows the workspace’s name to edit', async () => {
    const html = await render(new FakeApp(ROWS, 'u-ada'), () => <WorkspaceScreen params={{}} />);
    expect(html).toContain('Workspace name');
    expect(html).toContain('value="Acme"');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });
});
