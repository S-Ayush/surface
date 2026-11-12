// PLAN-001 S5, SPEC-001 §3.4, §6.1, E3–E5: showing and accepting an invite over HTTP, against a
// fake store (the unit parts of AC-3 and AC-4; their e2e tests are held, plans README §6). The
// store's SQL was checked by hand against Postgres.
import { CSRF_COOKIE, CSRF_HEADER } from '@surface/sync-protocol';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { csrfToken } from '../src/auth/csrf.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { SessionAuth } from '../src/auth/sessions.js';
import type { SessionSelection } from '../src/auth/store.js';
import type { WithTransaction } from '../src/executor/transaction.js';
import { registerInviteRoutes } from '../src/handlers/invites/routes.js';
import {
  TakenError,
  type ClaimedInvite,
  type InviteStore,
  type NewMember,
} from '../src/handlers/invites/store.js';
import { Lifecycle } from '../src/lifecycle.js';
import { createLogger } from '../src/logger.js';
import { hashLinkToken } from '../src/mail/link-tokens.js';
import { FakeAttempts, FakeAuthStore } from './auth-fakes.js';
import { captureLogs, fakeWebDir, testConfig } from './helpers.js';

const ADA = 'ada-0000-0000-0000-000000000001';
const BEN = 'ben-0000-0000-0000-000000000002';
const TOKEN = 'an-invite-token-of-forty-three-characters-x';
const NO_EMAIL_TOKEN = 'another-invite-token-that-has-no-email-on-it';
const PASSWORD = 'a long enough passphrase';
const NOW = new Date('2026-11-12T10:00:00Z');

interface StoredInvite extends ClaimedInvite {
  tokenHash: string;
  state: 'pending' | 'accepted' | 'revoked' | 'expired';
}

/** Invites and users in memory. A transaction that throws puts them back as they were. */
class FakeInvites {
  invites: StoredInvite[] = [
    {
      id: 'invite-1',
      tokenHash: hashLinkToken(TOKEN),
      email: 'zoe@example.com',
      role: 'member',
      teamIds: ['eng'],
      invitedById: ADA,
      state: 'pending',
    },
    {
      id: 'invite-2',
      tokenHash: hashLinkToken(NO_EMAIL_TOKEN),
      email: null,
      role: 'admin',
      teamIds: [],
      invitedById: ADA,
      state: 'pending',
    },
  ];
  users: { id: string; email: string; displayName: string }[] = [
    { id: ADA, email: 'ada@example.com', displayName: 'ada' },
    { id: BEN, email: 'ben@example.com', displayName: 'iris' },
  ];
  created: NewMember[] = [];
  /** Throw this from createMember, as a unique index would in a race. */
  race: TakenError | undefined;

  constructor(readonly sessions: FakeAuthStore) {}

  withTransaction: WithTransaction = async (fn) => {
    const invites = this.invites.map((i) => ({ ...i }));
    const users = [...this.users];
    const created = [...this.created];
    const sessions = new Map(this.sessions.sessions);
    try {
      return await fn(Object.create(null) as never);
    } catch (error) {
      Object.assign(this, { invites, users, created });
      this.sessions.sessions.clear();
      for (const [k, v] of sessions) this.sessions.sessions.set(k, v);
      throw error;
    }
  };

  private find(tokenHash: string) {
    return this.invites.find((i) => i.tokenHash === tokenHash && i.state === 'pending');
  }

  store: InviteStore = {
    pendingInvite: (_db, tokenHash) => {
      const invite = this.find(tokenHash);
      return Promise.resolve(
        invite && {
          workspaceName: 'Acme',
          inviterName: 'Ada Lovelace',
          email: invite.email,
          role: invite.role,
        },
      );
    },
    claim: (_db, tokenHash) => {
      const invite = this.find(tokenHash);
      if (invite) invite.state = 'accepted';
      return Promise.resolve(invite);
    },
    emailTaken: (_db, email) => Promise.resolve(this.users.some((u) => u.email === email)),
    displayNamesLike: (_db, name) =>
      Promise.resolve(
        this.users
          .map((u) => u.displayName)
          .filter((d) => d.toLowerCase().startsWith(name.toLowerCase())),
      ),
    createMember: (_db, member) => {
      if (this.race) return Promise.reject(this.race);
      this.created.push(member);
      const userId = `user-${String(this.users.length + 1)}`;
      this.users.push({ id: userId, email: member.email, displayName: member.displayName });
      return Promise.resolve({ userId, teamIds: [...member.invite.teamIds] });
    },
    createSession: (_db, session) => this.sessions.createSession(session),
    endSessions: (_db, userId: string, which: SessionSelection) => {
      const ended: string[] = [];
      for (const [hash, s] of this.sessions.sessions) {
        if (s.userId === userId && 'only' in which && s.id === which.only) {
          ended.push(s.id);
          this.sessions.sessions.delete(hash);
        }
      }
      return Promise.resolve(ended);
    },
  };
}

let apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

async function inviteApp() {
  const config = testConfig({ logLevel: 'info', webDir: fakeWebDir() });
  const origin = new URL(config.publicUrl).origin;
  const logs = captureLogs();
  const lifecycle = new Lifecycle();
  const sessions = new FakeAuthStore();
  const fake = new FakeInvites(sessions);
  const now = () => NOW;
  const auth = new SessionAuth(sessions, { now });
  const closed: string[] = [];
  const hashed: string[] = [];
  const app = await buildApp({
    config,
    lifecycle,
    logger: createLogger(config, logs.stream),
    auth: { auth, store: sessions, attempts: new FakeAttempts(), now },
  });
  registerInviteRoutes(app, {
    auth,
    lifecycle,
    secureCookies: config.secureCookies,
    sessionSecret: config.sessionSecret,
    allowedOrigin: origin,
    withTransaction: fake.withTransaction,
    store: fake.store,
    closeSessions: (ids) => void closed.push(...ids),
    now,
    // argon2 is tested elsewhere; a marker keeps these tests fast.
    hashPassword: (password) => {
      hashed.push(password);
      return Promise.resolve(`hashed:${password.length}`);
    },
  });
  apps.push(app);
  lifecycle.markReady();

  const accept = (token: string, payload: object, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: `/api/invite/${token}/accept`,
      payload,
      headers: { origin, ...headers },
    });
  const browserOf = async (userId: string) => {
    const session = await sessions.createSession({
      userId,
      userAgent: undefined,
      ip: undefined,
      now: NOW,
    });
    const csrf = csrfToken(config.sessionSecret, session.id);
    return {
      id: session.id,
      headers: {
        cookie: `${SESSION_COOKIE}=${session.token}; ${CSRF_COOKIE}=${csrf}`,
        [CSRF_HEADER]: csrf,
      },
    };
  };
  return { app, origin, logs, sessions, fake, closed, hashed, accept, browserOf };
}

const ZOE = { name: 'Zoë Ng', displayName: 'zoe', password: PASSWORD, timezone: 'Europe/Berlin' };
const cookieNames = (res: { headers: { 'set-cookie'?: string | string[] | undefined } }) =>
  [res.headers['set-cookie'] ?? []].flat().map((c) => c.split('=')[0]);
const INVALID = {
  ok: false,
  error: {
    code: 'NOT_FOUND',
    message: 'This invite is no longer valid. Ask an Admin for a new one.',
  },
};

describe('GET /api/invite/:token', () => {
  it('shows the workspace, who invited, the email and the role of a pending invite', async () => {
    const { app } = await inviteApp();
    const res = await app.inject({ method: 'GET', url: `/api/invite/${TOKEN}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({
      ok: true,
      result: {
        workspaceName: 'Acme',
        inviterName: 'Ada Lovelace',
        email: 'zoe@example.com',
        role: 'member',
      },
    });
  });

  it('answers a used, revoked, expired or unknown link alike (E4)', async () => {
    const { app, fake } = await inviteApp();
    const [first, second] = fake.invites;
    if (first) first.state = 'revoked';
    if (second) second.state = 'expired';
    for (const token of [TOKEN, NO_EMAIL_TOKEN, 'unknown', 'x'.repeat(100)]) {
      const res = await app.inject({ method: 'GET', url: `/api/invite/${token}` });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject(INVALID);
    }
  });
});

describe('POST /api/invite/:token/accept (SPEC-001 §3.4 step 4)', () => {
  it('creates the user with the invite’s email and role, and signs in', async () => {
    const { accept, fake, sessions } = await inviteApp();
    const res = await accept(TOKEN, { ...ZOE, email: 'someone.else@example.com' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, result: { userId: 'user-3' } });
    expect(cookieNames(res)).toEqual([SESSION_COOKIE, CSRF_COOKIE]);
    // The invite's email wins: it is locked on the page.
    expect(fake.created).toMatchObject([
      {
        invite: { id: 'invite-1', role: 'member', teamIds: ['eng'] },
        email: 'zoe@example.com',
        name: 'Zoë Ng',
        displayName: 'zoe',
        timezone: 'Europe/Berlin',
        passwordHash: `hashed:${PASSWORD.length}`,
      },
    ]);
    expect([...sessions.sessions.values()].map((s) => s.userId)).toEqual(['user-3']);
  });

  it('works once: the link is then no longer valid (E4)', async () => {
    const { accept } = await inviteApp();
    expect((await accept(TOKEN, ZOE)).statusCode).toBe(200);
    const again = await accept(TOKEN, { ...ZOE, displayName: 'zoe2' });
    expect(again.statusCode).toBe(404);
    expect(again.json()).toMatchObject(INVALID);
  });

  it('asks for the email when the invite has none, and normalises it (E2)', async () => {
    const { accept, fake } = await inviteApp();
    const missing = await accept(NO_EMAIL_TOKEN, ZOE);
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({
      error: {
        code: 'INVALID_INPUT',
        message: 'Email is required.',
        issues: [{ path: ['email'], message: 'Email is required.' }],
      },
    });
    // Refused inside the transaction: the invite is still pending.
    expect(fake.invites[1]?.state).toBe('pending');
    const res = await accept(NO_EMAIL_TOKEN, { ...ZOE, email: ' Zoe@Example.com ' });
    expect(res.statusCode).toBe(200);
    expect(fake.created[0]).toMatchObject({ email: 'zoe@example.com', invite: { role: 'admin' } });
  });

  it('refuses an email that has an account, keeping the invite (E3)', async () => {
    const { accept, fake } = await inviteApp();
    const res = await accept(NO_EMAIL_TOKEN, { ...ZOE, email: 'ben@example.com' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: {
        code: 'CONFLICT',
        message: 'A user with this email already exists. Log in instead.',
        issues: [{ path: ['email'] }],
      },
    });
    expect([fake.created, fake.invites[1]?.state]).toEqual([[], 'pending']);
  });

  it('checks the link before the costly password hash', async () => {
    const { accept, hashed } = await inviteApp();
    const res = await accept('no-such-invite-token', ZOE);
    expect(res.statusCode).toBe(404);
    expect(hashed).toEqual([]);
  });

  it('asks for the email first when the invite has none', async () => {
    const { accept, hashed } = await inviteApp();
    const res = await accept(NO_EMAIL_TOKEN, { ...ZOE, name: ' ' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: { message: 'Email is required.', issues: [{ path: ['email'] }] },
    });
    expect(hashed).toEqual([]);
  });

  it('ignores a typed email when the invite has its own', async () => {
    const { accept, fake } = await inviteApp();
    const res = await accept(TOKEN, { ...ZOE, email: 'not an email' });
    expect(res.statusCode).toBe(200);
    expect(fake.created[0]?.email).toBe('zoe@example.com');
  });

  it('suggests a free display name at the 32-character limit (E5)', async () => {
    const { accept, fake } = await inviteApp();
    const long = 'a'.repeat(32);
    fake.users.push(
      { id: 'x1', email: 'x1@example.com', displayName: long },
      { id: 'x2', email: 'x2@example.com', displayName: `${'a'.repeat(31)}2` },
    );
    const res = await accept(TOKEN, { ...ZOE, displayName: long });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: { message: `That display name is taken. Try ${'a'.repeat(31)}3.` },
    });
  });

  it('refuses a taken display name with the first free one, any case (E5)', async () => {
    const { accept, fake } = await inviteApp();
    fake.users.push({ id: 'x', email: 'x@example.com', displayName: 'Iris2' });
    const res = await accept(TOKEN, { ...ZOE, displayName: 'IRIS' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: {
        code: 'CONFLICT',
        message: 'That display name is taken. Try IRIS3.',
        issues: [{ path: ['displayName'], message: 'That display name is taken. Try IRIS3.' }],
      },
    });
    expect(fake.invites[0]?.state).toBe('pending');
  });

  it('answers a race on the email or display name like the checks do', async () => {
    const { accept, fake } = await inviteApp();
    fake.race = new TakenError('displayName');
    const res = await accept(TOKEN, ZOE);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      error: { message: 'That display name was just taken. Try another one.' },
    });
    fake.race = new TakenError('email');
    expect((await accept(TOKEN, ZOE)).json()).toMatchObject({
      error: { message: 'A user with this email already exists. Log in instead.' },
    });
    expect(fake.invites[0]?.state).toBe('pending');
  });

  it('checks the fields in the form’s order, before using the link', async () => {
    const { accept, fake } = await inviteApp();
    // The invite without an email: the page asks for one, first.
    const typed = { ...ZOE, email: 'kai@example.com' };
    const cases: [object, string, string][] = [
      [{ ...typed, email: 'nope', name: ' ' }, 'email', 'Email must look like name@example.com.'],
      [{ ...typed, name: ' ' }, 'name', 'Name is required.'],
      [
        { ...typed, displayName: 'zoe ng' },
        'displayName',
        'Display name can use letters, digits, dots, dashes and underscores, like ada.l.',
      ],
      [
        { ...typed, password: 'short' },
        'password',
        'Password must be at least 10 characters long.',
      ],
    ];
    for (const [body, field, message] of cases) {
      const res = await accept(NO_EMAIL_TOKEN, body);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { message, issues: [{ path: [field] }] } });
    }
    expect(fake.invites.map((i) => i.state)).toEqual(['pending', 'pending']);
  });

  it('uses UTC for a time zone it doesn’t know', async () => {
    const { accept, fake } = await inviteApp();
    await accept(TOKEN, { ...ZOE, timezone: 'Mars/Olympus' });
    expect(fake.created[0]?.timezone).toBe('UTC');
  });

  it('refuses another site’s page, using nothing (login CSRF)', async () => {
    const { accept, fake } = await inviteApp();
    const res = await accept(TOKEN, ZOE, { origin: 'https://evil.example' });
    expect(res.statusCode).toBe(403);
    expect(fake.invites[0]?.state).toBe('pending');
  });

  it('ends the session this browser had, closing its sockets after the answer (Q11)', async () => {
    const { accept, sessions, closed, browserOf } = await inviteApp();
    const ben = await browserOf(BEN);
    const res = await accept(TOKEN, ZOE, ben.headers);
    expect(res.statusCode).toBe(200);
    expect(closed).toEqual([ben.id]);
    expect([...sessions.sessions.values()].map((s) => s.userId)).toEqual(['user-3']);
  });

  it('needs the CSRF token from a signed-in browser, like every cookie POST (Q7)', async () => {
    const { accept, browserOf } = await inviteApp();
    const ben = await browserOf(BEN);
    const res = await accept(TOKEN, ZOE, { cookie: ben.headers.cookie });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'CSRF_INVALID' } });
  });

  it('logs the join as an audit line by ids, never the token, email or password (SPEC-001 §10)', async () => {
    const { accept, logs, sessions } = await inviteApp();
    await accept(TOKEN, ZOE);
    const audits = logs.lines.filter((line) => line['audit'] === true);
    expect(audits).toEqual([
      expect.objectContaining({
        level: 'info',
        event: 'user.joined',
        userId: 'user-3',
        actorId: ADA,
        reason: 'invite',
        sessionId: sessions.inserted.at(-1)?.['id'],
        ip: '127.0.0.1',
      }),
    ]);
    for (const secret of [TOKEN, 'zoe@example.com', PASSWORD]) {
      expect(logs.text()).not.toContain(secret);
    }
  });
});
