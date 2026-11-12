// PLAN-001 S4, SPEC-001 §3.2, §3.3, §6.1: magic links and password reset over HTTP, against
// fake stores (the unit parts of AC-3 to AC-5; their e2e tests are held, plans README §6). The
// SQL behind the fakes (single use, expiry, E9) is in link-tokens.ts, tested in link-tokens.test.ts.
import { CSRF_COOKIE, CSRF_HEADER } from '@surface/sync-protocol';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { csrfToken } from '../src/auth/csrf.js';
import { verifyPassword } from '../src/auth/password.js';
import { SESSION_COOKIE, type NewSession } from '../src/auth/session.js';
import { SessionAuth } from '../src/auth/sessions.js';
import type { SessionSelection } from '../src/auth/store.js';
import type { WithTransaction } from '../src/executor/transaction.js';
import { registerAccountRoutes, type AccountStore } from '../src/handlers/account/routes.js';
import type { EmailOutbox } from '../src/jobs/email.js';
import { Lifecycle } from '../src/lifecycle.js';
import { createLogger } from '../src/logger.js';
import type { EmailJob } from '../src/mail/job.js';
import { LINK_REQUEST_COOLDOWN_MS, type LinkKind } from '../src/mail/link-tokens.js';
import { FakeAttempts, FakeAuthStore } from './auth-fakes.js';
import { captureLogs, fakeWebDir, testConfig } from './helpers.js';

const ADA = 'ada-0000-0000-0000-000000000001';
const BEN = 'ben-0000-0000-0000-000000000002';
const NEW_PASSWORD = 'a brand new passphrase';

interface StoredLink {
  kind: LinkKind;
  userId: string;
  token: string;
  used: boolean;
}

/** The account tables in memory. A transaction that throws puts them back as they were. */
class FakeAccounts {
  links: StoredLink[] = [];
  passwords = new Map<string, string>();
  queued: EmailJob[] = [];
  /** Each `issueLink` call's options, to check the cooldown is asked for. */
  issued: { kind: LinkKind; cooldownMs: number | undefined }[] = [];
  /** Holds every email lookup until it resolves (the answer must not wait for it). */
  lookupGate: Promise<void> | undefined;
  lookups = 0;
  failEnqueue = false;

  constructor(readonly sessions: FakeAuthStore) {}

  readonly users = new Map([
    ['ada@example.com', { id: ADA, email: 'ada@example.com' }],
    ['ben@example.com', { id: BEN, email: 'ben@example.com' }],
  ]);

  withTransaction: WithTransaction = async (fn) => {
    const links = this.links.map((l) => ({ ...l }));
    const passwords = new Map(this.passwords);
    const queued = [...this.queued];
    const sessions = new Map(this.sessions.sessions);
    try {
      return await fn(Object.create(null) as never);
    } catch (error) {
      Object.assign(this, { links, passwords, queued });
      this.sessions.sessions.clear();
      for (const [k, v] of sessions) this.sessions.sessions.set(k, v);
      throw error;
    }
  };

  email: EmailOutbox = {
    enabled: true,
    enqueue: (_client, job) => {
      if (this.failEnqueue) return Promise.reject(new Error('queue down'));
      this.queued.push(job);
      return Promise.resolve(true);
    },
  };

  store: AccountStore = {
    activeUserByEmail: async (_db, email) => {
      this.lookups += 1;
      await this.lookupGate;
      return this.users.get(email);
    },
    workspaceName: () => Promise.resolve('Acme'),
    issueLink: (_db, kind, userId, { cooldownMs }) => {
      this.issued.push({ kind, cooldownMs });
      // E9: only the newest works.
      for (const l of this.links) if (l.kind === kind && l.userId === userId) l.used = true;
      const token = `${kind}-token-${String(this.links.length + 1)}`;
      this.links.push({ kind, userId, token, used: false });
      return Promise.resolve({ token, expiresAt: new Date(0) });
    },
    useLink: (_db, kind, token) => {
      const link = this.links.find((l) => l.kind === kind && l.token === token && !l.used);
      if (link === undefined) return Promise.resolve(undefined);
      link.used = true;
      return Promise.resolve(link.userId);
    },
    setPasswordHash: (_db, userId, hash) => {
      this.passwords.set(userId, hash);
      return Promise.resolve();
    },
    createSession: (_db, session: NewSession) => this.sessions.createSession(session),
    endSessions: (_db, userId: string, which: SessionSelection) => {
      const ended: string[] = [];
      for (const [hash, s] of this.sessions.sessions) {
        const matches =
          s.userId === userId &&
          ('all' in which || ('only' in which ? s.id === which.only : s.id !== which.except));
        if (matches) {
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

async function accountApp({ smtp = true }: { smtp?: boolean } = {}) {
  const config = testConfig({ logLevel: 'info', webDir: fakeWebDir() });
  const origin = new URL(config.publicUrl).origin;
  const logs = captureLogs();
  const lifecycle = new Lifecycle();
  const sessions = new FakeAuthStore();
  const accounts = new FakeAccounts(sessions);
  const now = () => new Date('2026-11-07T10:00:00Z');
  const auth = new SessionAuth(sessions, { now });
  const closed: string[] = [];
  const background: Promise<void>[] = [];
  const app = await buildApp({
    config,
    lifecycle,
    logger: createLogger(config, logs.stream),
    auth: { auth, store: sessions, attempts: new FakeAttempts(), now },
  });
  registerAccountRoutes(app, {
    auth,
    lifecycle,
    secureCookies: config.secureCookies,
    sessionSecret: config.sessionSecret,
    allowedOrigin: origin,
    publicUrl: config.publicUrl,
    email: smtp ? accounts.email : { enabled: false, enqueue: () => Promise.resolve(false) },
    withTransaction: accounts.withTransaction,
    store: accounts.store,
    closeSessions: (ids) => void closed.push(...ids),
    now,
    background: (work) => void background.push(work),
  });
  apps.push(app);
  lifecycle.markReady();

  const post = (url: string, payload: object, headers: Record<string, string> = {}) =>
    app.inject({ method: 'POST', url, payload, headers });
  /** Lets the work a link request does after answering finish. */
  const settled = () => Promise.all(background);
  /** A session for `userId`, with the cookies a browser would send. */
  const browserOf = async (userId: string) => {
    const session = await sessions.createSession({
      userId,
      userAgent: undefined,
      ip: undefined,
      now: now(),
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
  return { app, config, origin, logs, sessions, accounts, closed, post, settled, browserOf };
}

const cookieNames = (res: { headers: { 'set-cookie'?: string | string[] | undefined } }) =>
  [res.headers['set-cookie'] ?? []].flat().map((c) => c.split('=')[0]);

/** The token in an emailed link. */
const tokenOf = (link: string) => new URL(link).searchParams.get('token') ?? '';

describe('POST /auth/magic-link and /auth/forgot', () => {
  it.each(['/auth/magic-link', '/auth/forgot'])(
    '%s answers an account and an unknown email alike, before looking either up (AC-5)',
    async (path) => {
      const { accounts, post, settled } = await accountApp();
      let open = () => undefined as void;
      accounts.lookupGate = new Promise<void>((resolve) => (open = resolve));
      const known = await post(path, { email: 'Ada@Example.com ' });
      const unknown = await post(path, { email: 'nobody@example.com' });
      // Both answered while their lookups were still waiting.
      expect(accounts.lookups).toBe(2);
      expect(accounts.queued).toEqual([]);
      for (const res of [known, unknown]) {
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ ok: true, result: {} });
        expect(res.headers['cache-control']).toBe('no-store');
      }
      open();
      await settled();
      expect(accounts.queued).toHaveLength(1);
    },
  );

  it('emails a login link to the account, on SURFACE_URL, that signs in once', async () => {
    const { accounts, config, origin, post, settled } = await accountApp();
    await post('/auth/magic-link', { email: 'ada@example.com' });
    await settled();
    const [job] = accounts.queued;
    expect(job).toMatchObject({
      template: 'magicLink',
      to: 'ada@example.com',
      workspaceName: 'Acme',
    });
    const link = new URL(job?.link ?? '');
    expect(`${link.origin}${link.pathname}`).toBe(new URL('/login/magic', config.publicUrl).href);
    expect(accounts.issued).toEqual([{ kind: 'magicLink', cooldownMs: LINK_REQUEST_COOLDOWN_MS }]);

    const used = await post('/auth/magic', { token: tokenOf(job?.link ?? '') }, { origin });
    expect(used.statusCode).toBe(200);
    expect(used.json()).toEqual({ ok: true, result: { userId: ADA } });
    expect(cookieNames(used)).toEqual([SESSION_COOKIE, CSRF_COOKIE]);
    const again = await post('/auth/magic', { token: tokenOf(job?.link ?? '') }, { origin });
    expect(again.statusCode).toBe(401);
    expect(again.json()).toMatchObject({
      ok: false,
      error: {
        code: 'UNAUTHENTICATED',
        message:
          'This login link has expired or was already used. Ask for a new one on the login page.',
      },
    });
  });

  it('emails a reset link to /reset on SURFACE_URL', async () => {
    const { accounts, config, post, settled } = await accountApp();
    await post('/auth/forgot', { email: 'ben@example.com' });
    await settled();
    const [job] = accounts.queued;
    expect(job).toMatchObject({ template: 'passwordReset', to: 'ben@example.com' });
    const link = new URL(job?.link ?? '');
    expect(`${link.origin}${link.pathname}`).toBe(new URL('/reset', config.publicUrl).href);
    expect(tokenOf(job?.link ?? '')).not.toBe('');
  });

  it('sends nothing for an unknown email, and logs no address', async () => {
    const { accounts, logs, post, settled } = await accountApp();
    await post('/auth/forgot', { email: 'nobody@example.com' });
    await settled();
    expect(accounts.links).toEqual([]);
    expect(accounts.queued).toEqual([]);
    expect(logs.text()).not.toContain('nobody@example.com');
  });

  it('keeps the generic answer when queuing fails, and stores no link without its email', async () => {
    const { accounts, logs, post, settled } = await accountApp();
    accounts.failEnqueue = true;
    const res = await post('/auth/magic-link', { email: 'ada@example.com' });
    await settled();
    expect(res.statusCode).toBe(200);
    expect(accounts.links).toEqual([]);
    expect(logs.lines.some((l) => l['msg'] === 'could not queue the link')).toBe(true);
  });

  it.each([
    [{ email: 'not an address' }, 'Email must look like name@example.com.'],
    [{ email: '' }, 'Email is required.'],
    [{}, 'Email is required.'],
  ])('refuses %j the same for everyone, before any lookup', async (body, message) => {
    const { accounts, post } = await accountApp();
    const res = await post('/auth/magic-link', body);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_INPUT', message } });
    expect(accounts.lookups).toBe(0);
  });

  it.each([
    [
      '/auth/magic-link',
      "Login links need email, which isn't set up on this server. Log in with your password.",
    ],
    ['/auth/forgot', 'Email isn’t set up on this server. Ask an Admin for a reset link.'],
  ])(
    'without SMTP, %s says what to do instead and looks nothing up (AC-3)',
    async (path, message) => {
      const { accounts, post } = await accountApp({ smtp: false });
      const res = await post(path, { email: 'ada@example.com' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND', message } });
      expect(accounts.lookups).toBe(0);
    },
  );
});

describe('POST /auth/magic', () => {
  it('ends the session this browser had, closing its sockets after the answer (Q11)', async () => {
    const { accounts, origin, post, sessions, closed, browserOf } = await accountApp();
    const ben = await browserOf(BEN);
    await accounts.store.issueLink(Object.create(null) as never, 'magicLink', ADA, {
      now: new Date(),
    });
    const res = await post(
      '/auth/magic',
      { token: 'magicLink-token-1' },
      { origin, ...ben.headers },
    );
    expect(res.statusCode).toBe(200);
    expect(closed).toEqual([ben.id]);
    expect([...sessions.sessions.values()].map((s) => s.userId)).toEqual([ADA]);
  });

  it('refuses another site’s page, using nothing (login CSRF)', async () => {
    const { accounts, post } = await accountApp();
    await accounts.store.issueLink(Object.create(null) as never, 'magicLink', ADA, {
      now: new Date(),
    });
    const res = await post(
      '/auth/magic',
      { token: 'magicLink-token-1' },
      { origin: 'https://evil.example' },
    );
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(accounts.links[0]?.used).toBe(false);
  });

  it('turns off older links when a new one is asked for (E9)', async () => {
    const { accounts, origin, post, settled } = await accountApp();
    await post('/auth/magic-link', { email: 'ada@example.com' });
    await post('/auth/magic-link', { email: 'ada@example.com' });
    await settled();
    const [first, second] = accounts.queued.map((job) => tokenOf(job.link));
    expect((await post('/auth/magic', { token: first }, { origin })).statusCode).toBe(401);
    expect((await post('/auth/magic', { token: second }, { origin })).statusCode).toBe(200);
  });

  it('says a link that lost its token is incomplete', async () => {
    const { post, origin } = await accountApp();
    const res = await post('/auth/magic', {}, { origin });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: {
        code: 'INVALID_INPUT',
        message: 'This login link is incomplete. Open it from the email again.',
      },
    });
  });
});

describe('POST /auth/reset', () => {
  async function withResetLink() {
    const app = await accountApp();
    await app.post('/auth/forgot', { email: 'ada@example.com' });
    await app.settled();
    return { ...app, token: tokenOf(app.accounts.queued[0]?.link ?? '') };
  }

  it('sets the password, ends every session of the user, and signs this browser in (E10)', async () => {
    const { accounts, origin, post, sessions, closed, browserOf, token } = await withResetLink();
    const laptop = await browserOf(ADA);
    const phone = await browserOf(ADA);
    const res = await post('/auth/reset', { token, password: NEW_PASSWORD }, { origin });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, result: { userId: ADA } });
    expect(cookieNames(res)).toEqual([SESSION_COOKIE, CSRF_COOKIE]);
    expect(await verifyPassword(accounts.passwords.get(ADA) ?? '', NEW_PASSWORD)).toBe(true);
    expect(closed.sort()).toEqual([laptop.id, phone.id].sort());
    // Only the new session is left.
    expect([...sessions.sessions.values()].map((s) => s.id)).toEqual([
      sessions.inserted.at(-1)?.['id'],
    ]);
  });

  it('also ends this browser’s session when it was someone else’s', async () => {
    const { origin, post, closed, browserOf, token } = await withResetLink();
    const ben = await browserOf(BEN);
    const res = await post(
      '/auth/reset',
      { token, password: NEW_PASSWORD },
      { origin, ...ben.headers },
    );
    expect(res.statusCode).toBe(200);
    expect(closed).toEqual([ben.id]);
  });

  it('refuses a password that is too short, keeping the link', async () => {
    const { accounts, origin, post, token } = await withResetLink();
    const res = await post('/auth/reset', { token, password: 'short' }, { origin });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: { code: 'INVALID_INPUT', message: 'Password must be at least 10 characters long.' },
    });
    expect(accounts.links[0]?.used).toBe(false);
    expect(accounts.passwords.size).toBe(0);
  });

  it('refuses a used link, changing nothing', async () => {
    const { accounts, origin, post, token } = await withResetLink();
    await post('/auth/reset', { token, password: NEW_PASSWORD }, { origin });
    const hash = accounts.passwords.get(ADA);
    const again = await post('/auth/reset', { token, password: 'another passphrase' }, { origin });
    expect(again.statusCode).toBe(401);
    expect(again.json()).toMatchObject({
      error: {
        code: 'UNAUTHENTICATED',
        message: 'This reset link has expired or was already used. Ask for a new one.',
      },
    });
    expect(accounts.passwords.get(ADA)).toBe(hash);
  });

  it('refuses another site’s page (login CSRF)', async () => {
    const { accounts, post, token } = await withResetLink();
    const res = await post(
      '/auth/reset',
      { token, password: NEW_PASSWORD },
      { origin: 'https://evil.example' },
    );
    expect(res.statusCode).toBe(403);
    expect(accounts.passwords.size).toBe(0);
  });

  it('needs the CSRF token from a signed-in browser, like every cookie POST (Q7)', async () => {
    const { origin, post, browserOf, token } = await withResetLink();
    const ada = await browserOf(ADA);
    const res = await post(
      '/auth/reset',
      { token, password: NEW_PASSWORD },
      { origin, cookie: ada.headers.cookie },
    );
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'CSRF_INVALID' } });
  });
});

describe('audit lines (SPEC-001 §10)', () => {
  const audits = (logs: { lines: Record<string, unknown>[] }) =>
    logs.lines.filter((line) => line['audit'] === true);
  const lastSessionId = (sessions: FakeAuthStore) => sessions.inserted.at(-1)?.['id'];

  it('logs a sign-in by login link, and a refused link at warn, naming no one', async () => {
    const { accounts, logs, origin, post, sessions } = await accountApp();
    await accounts.store.issueLink(Object.create(null) as never, 'magicLink', ADA, {
      now: new Date(),
    });
    await post('/auth/magic', { token: 'magicLink-token-1' }, { origin });
    const sessionId = lastSessionId(sessions);
    expect(sessionId).toBeDefined();
    await post('/auth/magic', { token: 'magicLink-token-1' }, { origin });
    expect(audits(logs)).toEqual([
      expect.objectContaining({
        level: 'info',
        event: 'auth.login',
        method: 'magic_link',
        userId: ADA,
        sessionId,
        ip: '127.0.0.1',
      }),
      expect.objectContaining({
        level: 'warn',
        event: 'auth.login_failed',
        method: 'magic_link',
        reason: 'invalid_link',
        ip: '127.0.0.1',
      }),
    ]);
    expect(audits(logs)[1]).not.toHaveProperty('userId');
    expect(logs.text()).not.toContain('magicLink-token-1');
  });

  it('logs a password reset, and a refused reset link at warn, without the token', async () => {
    const { logs, origin, post, sessions, token } = await (async () => {
      const app = await accountApp();
      await app.post('/auth/forgot', { email: 'ada@example.com' });
      await app.settled();
      return { ...app, token: tokenOf(app.accounts.queued[0]?.link ?? '') };
    })();
    await post('/auth/reset', { token, password: NEW_PASSWORD }, { origin });
    const sessionId = lastSessionId(sessions);
    await post('/auth/reset', { token, password: NEW_PASSWORD }, { origin });
    expect(audits(logs)).toEqual([
      expect.objectContaining({
        level: 'info',
        event: 'auth.password_reset',
        userId: ADA,
        sessionId,
        ip: '127.0.0.1',
      }),
      expect.objectContaining({
        level: 'warn',
        event: 'auth.password_reset_failed',
        reason: 'invalid_link',
        ip: '127.0.0.1',
      }),
    ]);
    expect(audits(logs)[1]).not.toHaveProperty('userId');
    expect(logs.text()).not.toContain(token);
  });
});
