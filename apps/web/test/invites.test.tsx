// PLAN-001 S5 web half (SPEC-001 §3.4, §7): the invite modal shows the link once, emailed or not
// (E7, D7); the pending list revokes and reloads; the invite page suggests a display name from
// the name until it is edited (D9), checks the fields in form order, puts the server's refusals on
// their field (E3, E5) and says when the invite is no longer valid (E4); "Invite member…" in the
// command menu opens the modal on Settings → Members. The browser flow (AC-2) is held e2e
// (plans README §6) and was checked by hand.
import { EMAIL_TAKEN_MESSAGE, INVITE_INVALID_MESSAGE } from '@surface/domain';
import { CSRF_HEADER } from '@surface/sync-protocol';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../src/command-menu/model.js';
import {
  ACCEPT_IDLE,
  AcceptFlow,
  acceptBody,
  acceptProblems,
  EMPTY_ACCEPT_FORM,
  invitedText,
  withDisplayName,
  withEmail,
  withName,
  type AcceptView,
} from '../src/features/invites/accept.js';
import {
  httpInvitesApi,
  InvitesApiContext,
  UNREACHABLE,
  type AcceptResult,
  type CreateInviteResult,
  type Invite,
  type InvitesApi,
} from '../src/features/invites/api.js';
import { INVITE_COMMANDS, MEMBERS_PATH, openInvite } from '../src/features/invites/commands.js';
import {
  EMPTY_INVITE_FORM,
  expiresText,
  INVITE_FORM,
  InviteFlow,
  inviteShownNote,
  inviteTeamChoices,
  mayCloseInvite,
  pendingInviteRow,
  withTeam,
  type InviteView,
} from '../src/features/invites/invite-form.js';
import { AcceptInvite, INVITE_TITLE } from '../src/features/invites/InviteScreen.js';
import {
  PENDING_LOADING,
  PendingInvites,
  type PendingView,
} from '../src/features/invites/pending.js';
import { InviteRequests } from '../src/features/invites/requests.js';

const NOW = new Date('2026-11-12T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const invite = (extra: Partial<Invite> = {}): Invite => ({
  id: '01930000-0000-7000-8000-000000000501',
  email: 'zoe@example.com',
  role: 'member',
  teamIds: [],
  invitedById: '01930000-0000-7000-8000-000000000001',
  status: 'pending',
  createdAt: NOW.toISOString(),
  expiresAt: new Date(NOW.getTime() + 7 * DAY).toISOString(),
  ...extra,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const refusal = (status: number, code: string, message: string, field?: string) =>
  json(status, {
    ok: false,
    error: {
      code,
      message,
      correlationId: 'c',
      ...(field === undefined ? {} : { issues: [{ path: [field], message }] }),
    },
  });

type Sent = { url: string; init: RequestInit | undefined };

function apiAnswering(answer: (url: string) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const api = httpInvitesApi(
    async (url, init) => {
      sent.push({ url, init });
      return answer(url);
    },
    () => 'surface_csrf=tok',
  );
  const bodyOf = (index: number): unknown => {
    const body = sent[index]?.init?.body;
    return typeof body === 'string' ? JSON.parse(body) : body;
  };
  return { api, sent, bodyOf };
}

describe('httpInvitesApi', () => {
  it('runs invite.create with the CSRF token and returns the link and whether it was emailed', async () => {
    const { api, sent, bodyOf } = apiAnswering(() =>
      json(200, {
        ok: true,
        result: { invite: invite(), url: 'https://s.example.com/invite/abc', emailed: true },
      }),
    );
    const result = await api.create({ email: 'zoe@example.com', role: 'member', teams: ['t-1'] });
    expect(result).toMatchObject({
      ok: true,
      url: 'https://s.example.com/invite/abc',
      emailed: true,
    });
    expect(sent[0]?.url).toBe('/api/ops/invite.create');
    expect(new Headers(sent[0]?.init?.headers).get(CSRF_HEADER)).toBe('tok');
    expect(bodyOf(0)).toEqual({
      input: { email: 'zoe@example.com', role: 'member', teams: ['t-1'] },
    });
    await api.create({ role: 'admin', teams: [] });
    expect(bodyOf(1)).toEqual({ input: { role: 'admin', teams: [] } });
  });

  it('shows a refusal’s message, never a server failure’s, and says when Surface is unreachable', async () => {
    const refused = apiAnswering(() => refusal(409, 'CONFLICT', EMAIL_TAKEN_MESSAGE, 'email')).api;
    expect(await refused.create({ role: 'member', teams: [] })).toEqual({
      ok: false,
      message: EMAIL_TAKEN_MESSAGE,
      field: 'email',
    });
    const general = apiAnswering(() => refusal(403, 'FORBIDDEN', 'Only Admins can do this.')).api;
    expect(await general.create({ role: 'member', teams: [] })).toEqual({
      ok: false,
      message: 'Only Admins can do this.',
    });
    const failed = apiAnswering(() => refusal(500, 'INTERNAL', 'db exploded')).api;
    expect(await failed.revoke('i-1')).toEqual({ ok: false, message: UNREACHABLE });
    const offline = httpInvitesApi(
      () => Promise.reject(new TypeError('fetch failed')),
      () => '',
    );
    expect(await offline.pending()).toEqual({ ok: false, message: UNREACHABLE });
    const odd = apiAnswering(() => json(200, { ok: true, result: { url: 'nope' } })).api;
    expect(await odd.create({ role: 'member', teams: [] })).toEqual({
      ok: false,
      message: UNREACHABLE,
    });
  });

  it('lists pending invites with invite.list and revokes with invite.revoke', async () => {
    const { api, sent, bodyOf } = apiAnswering((url) =>
      url.endsWith('invite.list')
        ? json(200, {
            ok: true,
            result: { nodes: [invite()], pageInfo: { hasNextPage: true, endCursor: 'x' } },
          })
        : json(200, { ok: true, result: invite({ status: 'revoked' }) }),
    );
    expect(await api.pending()).toEqual({ ok: true, invites: [invite()], more: true });
    expect(bodyOf(0)).toEqual({
      input: { filter: { field: 'status', op: 'eq', value: 'pending' }, limit: 100 },
    });
    expect(await api.revoke('i-1')).toEqual({ ok: true });
    expect(sent[1]?.url).toBe('/api/ops/invite.revoke');
    expect(bodyOf(1)).toEqual({ input: { invite: 'i-1' } });
  });

  it('reads the invite page’s details, and tells an invalid invite (E4) from a failure', async () => {
    const details = { workspaceName: 'Acme', inviterName: 'Ada', email: null, role: 'member' };
    const ok = apiAnswering(() => json(200, { ok: true, result: details }));
    expect(await ok.api.details('to/ken')).toEqual({ ok: true, invite: details });
    expect(ok.sent[0]?.url).toBe('/api/invite/to%2Fken');
    const gone = apiAnswering(() => refusal(404, 'NOT_FOUND', INVITE_INVALID_MESSAGE)).api;
    expect(await gone.details('t')).toEqual({
      ok: false,
      invalid: true,
      message: INVITE_INVALID_MESSAGE,
    });
    const failed = apiAnswering(() => refusal(503, 'UNAVAILABLE', 'starting')).api;
    expect(await failed.details('t')).toEqual({ ok: false, invalid: false, message: UNREACHABLE });
  });

  it('accepts with the CSRF token, and names the field a refusal is about', async () => {
    const ok = apiAnswering(() => json(200, { ok: true }));
    const body = { name: 'Zoe', displayName: 'zoe', password: 'long enough pw' };
    expect(await ok.api.accept('tok1', body)).toEqual({ ok: true });
    expect(ok.sent[0]?.url).toBe('/api/invite/tok1/accept');
    expect(new Headers(ok.sent[0]?.init?.headers).get(CSRF_HEADER)).toBe('tok');
    expect(ok.bodyOf(0)).toEqual(body);

    const taken = apiAnswering(() =>
      refusal(409, 'CONFLICT', 'That display name is taken. Try zoe2', 'displayName'),
    ).api;
    expect(await taken.accept('t', body)).toEqual({
      ok: false,
      message: 'That display name is taken. Try zoe2',
      field: 'displayName',
    });
    const gone = apiAnswering(() => refusal(404, 'NOT_FOUND', INVITE_INVALID_MESSAGE)).api;
    expect(await gone.accept('t', body)).toEqual({
      ok: false,
      message: INVITE_INVALID_MESSAGE,
      invalid: true,
    });
    const odd = apiAnswering(() => refusal(400, 'INVALID_INPUT', 'Bad', 'tokenHash')).api;
    expect(await odd.accept('t', body)).toEqual({ ok: false, message: 'Bad' });
    const failed = apiAnswering(() => refusal(500, 'INTERNAL', 'secret')).api;
    expect(await failed.accept('t', body)).toEqual({ ok: false, message: UNREACHABLE });
  });
});

describe('the invite page’s form', () => {
  it('suggests a display name from the name until it is edited (D9)', () => {
    let form = withName(EMPTY_ACCEPT_FORM, 'Zoë Ng', 'zoe@example.com');
    expect(form.displayName).toBe('zoe');
    form = withName(form, '', 'zoe.n@example.com');
    expect(form.displayName).toBe('zoen');
    form = withDisplayName(form, 'zn');
    form = withName(form, 'Zoe Ng', null);
    expect(form.displayName).toBe('zn');
  });

  it('suggests from the typed email when the invite has none', () => {
    const form = withEmail(EMPTY_ACCEPT_FORM, 'kai@example.com');
    expect(form.displayName).toBe('kai');
    expect(withName(form, 'Kai Lee', null).displayName).toBe('kai');
    expect(withEmail(EMPTY_ACCEPT_FORM, '').displayName).toBe('');
  });

  it('checks the fields in form order, worded as the server words them', () => {
    const problems = acceptProblems(EMPTY_ACCEPT_FORM, true);
    expect(Object.keys(problems)).toEqual(['email', 'name', 'displayName', 'password']);
    expect(problems.name).toBe('Name is required.');
    expect(acceptProblems(EMPTY_ACCEPT_FORM, false).email).toBeUndefined();
    const good = {
      ...withName(EMPTY_ACCEPT_FORM, 'Zoe', 'zoe@example.com'),
      password: 'long enough pw',
    };
    expect(acceptProblems(good, false)).toEqual({});
    expect(acceptProblems({ ...good, displayName: 'zoe ng' }, false).displayName).toMatch(
      /letters, digits/,
    );
  });

  it('sends the email only when the invite has none, trimmed, with the time zone', () => {
    const form = { ...EMPTY_ACCEPT_FORM, name: ' Zoe ', displayName: 'zoe', email: ' z@x.io ' };
    expect(acceptBody(form, false, 'Europe/Paris')).toEqual({
      name: 'Zoe',
      displayName: 'zoe',
      password: '',
      timezone: 'Europe/Paris',
    });
    expect(acceptBody(form, true)).toMatchObject({ email: 'z@x.io' });
  });

  it('says who invited whom where', () => {
    expect(invitedText('Ada', 'Acme')).toBe('Ada invited you to join Acme on Surface.');
  });
});

describe('AcceptFlow', () => {
  const ready = {
    ...withName(EMPTY_ACCEPT_FORM, 'Zoe', 'zoe@example.com'),
    password: 'long enough pw',
  };

  function flowWith(answer: () => Promise<AcceptResult>) {
    const views: AcceptView[] = [];
    const accept = vi.fn(answer);
    const flow = new AcceptFlow({ accept }, (view) => views.push(view));
    return { flow, views, accept };
  }

  it('shows the problems without sending', async () => {
    const { flow, views, accept } = flowWith(() => Promise.resolve({ ok: true }));
    await flow.submit('t', EMPTY_ACCEPT_FORM, false, () => undefined);
    expect(accept).not.toHaveBeenCalled();
    expect(views.at(-1)?.problems.name).toBe('Name is required.');
  });

  it('accepts once, then moves on while staying busy', async () => {
    let finish: (result: AcceptResult) => void = () => undefined;
    const { flow, views, accept } = flowWith(
      () => new Promise<AcceptResult>((resolve) => (finish = resolve)),
    );
    const then = vi.fn();
    const first = flow.submit('t', ready, false, then, 'UTC');
    void flow.submit('t', ready, false, then, 'UTC');
    finish({ ok: true });
    await first;
    expect(accept).toHaveBeenCalledTimes(1);
    expect(accept.mock.calls[0]).toEqual([
      't',
      { name: 'Zoe', displayName: 'zoe', password: 'long enough pw', timezone: 'UTC' },
    ]);
    expect(then).toHaveBeenCalledTimes(1);
    expect(views.at(-1)).toEqual({ ...ACCEPT_IDLE, pending: true });
  });

  it('puts a refusal on its field (E3, E5), says when the invite is gone (E4), else on the form', async () => {
    const cases: [AcceptResult, Partial<AcceptView>][] = [
      [
        { ok: false, message: 'That display name is taken. Try zoe2', field: 'displayName' },
        { problems: { displayName: 'That display name is taken. Try zoe2' } },
      ],
      [
        { ok: false, message: INVITE_INVALID_MESSAGE, invalid: true },
        { invalid: INVITE_INVALID_MESSAGE },
      ],
      [{ ok: false, message: UNREACHABLE }, { error: UNREACHABLE }],
    ];
    for (const [result, shown] of cases) {
      const { flow, views } = flowWith(() => Promise.resolve(result));
      await flow.submit('t', ready, false, () => undefined);
      expect(views.at(-1)).toEqual({ ...ACCEPT_IDLE, ...shown });
    }
  });
});

describe('InviteFlow', () => {
  const created: CreateInviteResult = {
    ok: true,
    invite: invite(),
    url: 'https://s.example.com/invite/abc',
    emailed: false,
  };

  function flowWith(answer: () => Promise<CreateInviteResult>) {
    const views: InviteView[] = [];
    const create = vi.fn(answer);
    const onCreated = vi.fn();
    const flow = new InviteFlow({ create }, (view) => views.push(view), onCreated);
    return { flow, views, create, onCreated };
  }

  it('creates the invite once and shows the link, then reloads the pending list', async () => {
    const { flow, views, create, onCreated } = flowWith(() => Promise.resolve(created));
    const form = withTeam({ ...EMPTY_INVITE_FORM, email: ' zoe@example.com ' }, 't-1', true);
    const first = flow.create(form);
    void flow.create(form);
    await first;
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]).toEqual([
      { email: 'zoe@example.com', role: 'member', teams: ['t-1'] },
    ]);
    expect(views.at(-1)).toEqual({
      phase: 'shown',
      invite: created.ok ? created.invite : undefined,
      url: created.ok ? created.url : undefined,
      emailed: false,
    });
    expect(onCreated).toHaveBeenCalledTimes(1);
  });

  it('sends no email when none is typed, and checks one that is', async () => {
    const { flow, views, create } = flowWith(() => Promise.resolve(created));
    await flow.create({ ...EMPTY_INVITE_FORM, email: 'nope' });
    expect(create).not.toHaveBeenCalled();
    const shown = views.at(-1);
    expect(shown?.phase === 'form' ? shown.emailError : undefined).toMatch(/^Email .*\.$/);
    await flow.create({ ...EMPTY_INVITE_FORM, email: '  ' });
    expect(create.mock.calls[0]).toEqual([{ role: 'member', teams: [] }]);
  });

  it('shows E3 under the email and other refusals on the form', async () => {
    // By the field the refusal names, not its words.
    const taken = flowWith(() =>
      Promise.resolve({ ok: false, message: 'Reworded E3', field: 'email' as const }),
    );
    await taken.flow.create({ ...EMPTY_INVITE_FORM, email: 'ada@example.com' });
    expect(taken.views.at(-1)).toEqual({ ...INVITE_FORM, emailError: 'Reworded E3' });
    const noField = flowWith(() => Promise.resolve({ ok: false, message: EMAIL_TAKEN_MESSAGE }));
    await noField.flow.create({ ...EMPTY_INVITE_FORM, email: 'ada@example.com' });
    expect(noField.views.at(-1)).toEqual({ ...INVITE_FORM, error: EMAIL_TAKEN_MESSAGE });
    const other = flowWith(() => Promise.resolve({ ok: false, message: UNREACHABLE }));
    await other.flow.create(EMPTY_INVITE_FORM);
    expect(other.views.at(-1)).toEqual({ ...INVITE_FORM, error: UNREACHABLE });
    expect(other.onCreated).not.toHaveBeenCalled();
  });

  it('keeps the modal open while the invite is being made', () => {
    expect(mayCloseInvite(INVITE_FORM)).toBe(true);
    expect(mayCloseInvite({ ...INVITE_FORM, busy: true })).toBe(false);
  });
});

describe('invite texts and choices', () => {
  it('always shows the link, saying whether it was emailed (E7, D7)', () => {
    expect(inviteShownNote('zoe@example.com', true)).toMatch(
      /^We’re emailing the invite to zoe@example\.com\. You can also send them this link\./,
    );
    expect(inviteShownNote('zoe@example.com', false)).toMatch(
      /^This server doesn’t send email\. Send this link to zoe@example\.com yourself\./,
    );
    expect(inviteShownNote(null, false)).toMatch(/^Send this link to the person you’re inviting\./);
    expect(inviteShownNote(null, false)).toContain('It works once, for 7 days.');
  });

  it('describes a pending invite by email, role, teams and expiry', () => {
    const keys = new Map([
      ['t-eng', 'ENG'],
      ['t-des', 'DES'],
    ]);
    expect(
      pendingInviteRow(invite({ teamIds: ['t-eng', 't-des', 't-gone'], role: 'admin' }), keys, NOW),
    ).toEqual({ title: 'zoe@example.com', meta: 'Admin · DES, ENG · Expires in 7 days' });
    expect(pendingInviteRow(invite({ email: null }), keys, NOW)).toEqual({
      title: 'Link without an email',
      meta: 'Member · No teams · Expires in 7 days',
    });
    // A new invite, read a moment later, still has 7 days.
    expect(expiresText(new Date(NOW.getTime() + 7 * DAY - 60_000), NOW)).toBe('Expires in 7 days');
    expect(expiresText(new Date(NOW.getTime() + DAY + 1), NOW)).toBe('Expires tomorrow');
    expect(expiresText(new Date(NOW.getTime() + 1000), NOW)).toBe('Expires today');
  });

  it('picks teams in order and offers the ones not archived, by key', () => {
    let form = withTeam(EMPTY_INVITE_FORM, 'b', true);
    form = withTeam(form, 'a', true);
    expect(form.teams).toEqual(['b', 'a']);
    expect(withTeam(form, 'b', false).teams).toEqual(['a']);
    expect(
      inviteTeamChoices([
        { id: '2', key: 'OPS', name: 'Ops' },
        { id: '1', key: 'ENG', name: 'Engineering' },
        { id: '3', key: 'OLD', name: 'Old', $archived: true },
      ]).map((team) => team.key),
    ).toEqual(['ENG', 'OPS']);
  });
});

describe('PendingInvites', () => {
  function listWith(api: Pick<InvitesApi, 'pending' | 'revoke'>) {
    const views: PendingView[] = [];
    const list = new PendingInvites(api, (view) => views.push(view));
    return { list, views };
  }

  it('loads the pending invites, keeping only the newest answer', async () => {
    const answers: ((result: Awaited<ReturnType<InvitesApi['pending']>>) => void)[] = [];
    const { list, views } = listWith({
      pending: () => new Promise((resolve) => answers.push(resolve)),
      revoke: () => Promise.resolve({ ok: true }),
    });
    const older = list.load();
    const newer = list.load();
    answers[1]?.({ ok: true, invites: [invite({ id: 'new' })], more: false });
    answers[0]?.({ ok: true, invites: [invite({ id: 'old' })], more: false });
    await Promise.all([older, newer]);
    expect(list.view.invites.map((i) => i.id)).toEqual(['new']);
    expect(views[0]).toEqual(PENDING_LOADING);
  });

  it('revokes, then reloads; a refusal shows', async () => {
    const pending = vi.fn(() => Promise.resolve({ ok: true as const, invites: [], more: false }));
    const ok = listWith({ pending, revoke: () => Promise.resolve({ ok: true }) });
    await ok.list.revoke('i-1');
    expect(ok.views).toContainEqual(expect.objectContaining({ revoking: 'i-1' }));
    expect(pending).toHaveBeenCalledTimes(1);
    expect(ok.list.view).toMatchObject({ revoking: null, error: null, loading: false });
    const refused = listWith({
      pending,
      revoke: () => Promise.resolve({ ok: false, message: 'This invite was already accepted.' }),
    });
    await refused.list.revoke('i-1');
    expect(refused.list.view.error).toBe('This invite was already accepted.');
  });
});

describe('Invite member… in the command menu', () => {
  it('opens Members and asks it for the invite modal', () => {
    const requests = new InviteRequests();
    const navigate = vi.fn();
    openInvite({ navigate } as unknown as CommandContext, requests);
    expect(navigate).toHaveBeenCalledWith(MEMBERS_PATH);
    expect(requests.take()).toBe(true);
    expect(requests.take()).toBe(false);
    expect(Object.keys(INVITE_COMMANDS)).toEqual(['invite.create']);
  });

  it('forgets an ask that no screen took within a few seconds', () => {
    let now = 1_000;
    const requests = new InviteRequests(() => now);
    requests.request();
    now += 4_000;
    expect(requests.take()).toBe(true);
    requests.request();
    now += 6_000;
    expect(requests.take()).toBe(false);
  });

  it('opens the modal at once when Members is already listening', () => {
    const requests = new InviteRequests();
    const opened = vi.fn();
    const stop = requests.listen(opened);
    requests.request();
    expect(opened).toHaveBeenCalledTimes(1);
    expect(requests.take()).toBe(false);
    stop();
    requests.request();
    expect(opened).toHaveBeenCalledTimes(1);
    expect(requests.take()).toBe(true);
  });
});

async function render(page: () => ReactNode): Promise<string> {
  const router = createRouter({
    routeTree: createRootRoute({ component: page }),
    history: createMemoryHistory({ initialEntries: ['/invite/tok'] }),
    origin: 'http://localhost',
    isServer: false,
    scrollRestoration: false,
  });
  await router.load();
  const api: InvitesApi = {
    create: () => Promise.reject(new Error('unused')),
    pending: () => Promise.reject(new Error('unused')),
    revoke: () => Promise.reject(new Error('unused')),
    details: () => Promise.reject(new Error('unused')),
    accept: () => Promise.reject(new Error('unused')),
  };
  return renderToString(
    <InvitesApiContext value={api}>
      <RouterProvider router={router} />
    </InvitesApiContext>,
  )
    .replaceAll('<!-- -->', '')
    .replaceAll('&#x27;', "'");
}

describe('the invite page', () => {
  const details = { workspaceName: 'Acme', inviterName: 'Ada', role: 'member' as const };

  it('says who invited, and locks the invite’s email', async () => {
    const html = await render(() => (
      <AcceptInvite token="tok" invite={{ ...details, email: 'zoe@example.com' }} />
    ));
    expect(html).toContain(INVITE_TITLE);
    expect(html).toContain('Ada invited you to join Acme on Surface.');
    expect(html).toMatch(
      /value="zoe@example.com"[^>]*readOnly|readOnly[^>]*value="zoe@example.com"/,
    );
    expect(html).toContain('Join Acme');
  });

  it('asks for the email when the invite has none', async () => {
    const html = await render(() => (
      <AcceptInvite token="tok" invite={{ ...details, email: null }} />
    ));
    expect(html).not.toContain('readOnly');
    expect(html).not.toContain('This invite is for this email.');
  });

  it('says the invite is no longer valid (E4), with a way to log in', async () => {
    const html = await render(() => (
      <AcceptInvite
        token="tok"
        invite={{ ...details, email: null }}
        initialView={{ ...ACCEPT_IDLE, invalid: INVITE_INVALID_MESSAGE }}
      />
    ));
    expect(html).toContain(INVITE_INVALID_MESSAGE);
    expect(html).toContain('href="/login"');
    expect(html).not.toContain('Join Acme');
  });
});
