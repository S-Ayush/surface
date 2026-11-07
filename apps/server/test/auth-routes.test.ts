// PLAN-001 S3, SPEC-001 §3.2, §6.1: sign-in, sessions, CSRF and the lockout, against fake stores
// (unit parts of AC-5 to AC-8; their integration and e2e tests are held, plans README §6).
// Passwords are hashed with the real argon2id, so AC-5 compares the real work.
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { CSRF_COOKIE } from '@surface/sync-protocol';
import { csrfToken } from '../src/auth/csrf.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';
import { SESSION_COOKIE, SESSION_TTL_MS } from '../src/auth/session.js';
import { SessionAuth } from '../src/auth/sessions.js';
import type { Config } from '../src/config.js';
import { Lifecycle } from '../src/lifecycle.js';
import { createLogger } from '../src/logger.js';
import { FakeAttempts, FakeAuthStore, WORKSPACE } from './auth-fakes.js';
import { captureLogs, fakeWebDir, testConfig } from './helpers.js';

const PASSWORD = 'correct horse battery';
const ADA = 'ada-0000-0000-0000-000000000001';
const ORIGIN = 'https://surface.example.com';

let apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

const passwordHash = hashPassword(PASSWORD);

async function authApp({
  config: overrides = {},
  verifyGate,
  ready = true,
}: {
  config?: Partial<Config>;
  ready?: boolean;
  /** Holds every password check until it resolves, so requests can overlap. */
  verifyGate?: Promise<void>;
} = {}) {
  const config = testConfig({ logLevel: 'info', webDir: fakeWebDir(), ...overrides });
  const logs = captureLogs();
  const lifecycle = new Lifecycle();
  const store = new FakeAuthStore();
  store.users.set('ada@example.com', { userId: ADA, passwordHash: await passwordHash });
  const attempts = new FakeAttempts();
  const clock = { now: new Date('2026-11-07T10:00:00Z') };
  const now = () => clock.now;
  const auth = new SessionAuth(store, { now });
  const closed: string[] = [];
  const verified: string[] = [];
  const app = await buildApp({
    config,
    lifecycle,
    logger: createLogger(config, logs.stream),
    auth: {
      auth,
      store,
      attempts,
      now,
      closeSessions: (ids) => void closed.push(...ids),
      verify: async (hash, password) => {
        verified.push(hash);
        await verifyGate;
        return verifyPassword(hash, password);
      },
    },
  });
  // Stand-ins for routes that need a signed-in user, like `/api/ops`.
  app.post('/api/echo', async (request, reply) => {
    const actor = await auth.resolveActor(request);
    return actor ? reply.send({ userId: actor.userId }) : reply.code(401).send({});
  });
  app.get('/api/echo', async (request) => {
    const actor = await auth.resolveActor(request);
    return { userId: actor?.userId, groups: actor?.groups };
  });
  apps.push(app);
  if (ready) lifecycle.markReady();

  const login = (body: unknown, headers: Record<string, string> = {}, ip = '127.0.0.1') =>
    app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: body as object,
      headers,
      remoteAddress: ip,
    });

  /** Signs Ada in; returns the Cookie header and CSRF token a browser would send. */
  const signIn = async () => {
    const res = await login({ email: 'ada@example.com', password: PASSWORD });
    expect(res.statusCode).toBe(200);
    const set = [res.headers['set-cookie'] ?? []].flat();
    const value = (name: string) =>
      set
        .find((c) => c.startsWith(`${name}=`))
        ?.split(';')[0]
        ?.slice(name.length + 1) ?? '';
    const token = value(SESSION_COOKIE);
    const csrf = value(CSRF_COOKIE);
    return { cookie: `${SESSION_COOKIE}=${token}; ${CSRF_COOKIE}=${csrf}`, token, csrf };
  };

  return {
    app,
    store,
    attempts,
    clock,
    logs,
    closed,
    verified,
    login,
    signIn,
    config,
    lifecycle,
  };
}

/** Polls with a deadline (no fixed sleep). */
async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in 5 s');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** A response's SPEC-003 error, without its per-request correlation id. */
function errorOf(res: { json: <T>() => T }) {
  const { error } = res.json<{ error: { code: string; message: string; correlationId: string } }>();
  const { correlationId: _id, ...rest } = error;
  return rest;
}

describe('POST /auth/login', () => {
  it('signs in with the right password: session and CSRF cookies, only the hash stored (AC-7)', async () => {
    const { store, signIn } = await authApp();
    const { token, csrf } = await signIn();
    const [stored] = store.inserted;
    expect(stored?.['tokenHash']).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(store.inserted)).not.toContain(token);
    expect(csrf).toBe(csrfToken(testConfig().sessionSecret, 'session-1'));
  });

  it('sets HttpOnly on the session cookie only, Secure on https (AC-7)', async () => {
    const { login } = await authApp();
    const res = await login({ email: 'ada@example.com', password: PASSWORD });
    const [session, csrf] = [res.headers['set-cookie'] ?? []].flat();
    expect(session).toMatch(
      /^surface_session=[\w-]{43}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure$/,
    );
    expect(csrf).toMatch(
      /^surface_csrf=[\w-]{43}; Path=\/; Max-Age=2592000; SameSite=Lax; Secure$/,
    );
    const http = await (
      await authApp({ config: { secureCookies: false } })
    ).login({
      email: 'ada@example.com',
      password: PASSWORD,
    });
    expect(String(http.headers['set-cookie'])).not.toContain('Secure');
  });

  it('answers a wrong password and an unknown email alike, after the same work (AC-5)', async () => {
    const { login, verified } = await authApp();
    const wrong = await login({ email: 'ada@example.com', password: 'not the password' });
    const unknown = await login({ email: 'nobody@example.com', password: 'not the password' });
    expect([wrong.statusCode, unknown.statusCode]).toEqual([401, 401]);
    expect(errorOf(wrong)).toEqual({
      code: 'UNAUTHENTICATED',
      message: 'Email or password is incorrect',
    });
    expect(errorOf(unknown)).toEqual(errorOf(wrong));
    expect(wrong.headers['set-cookie']).toBeUndefined();
    expect(unknown.headers['set-cookie']).toBeUndefined();
    // One argon2id verify each, with the same parameters: the unknown email against a dummy hash.
    expect(verified).toHaveLength(2);
    for (const hash of verified) expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(verified[1]).not.toBe(verified[0]);
  });

  it('accepts the email in any case and with spaces (E2)', async () => {
    const { login } = await authApp();
    const res = await login({ email: '  Ada@Example.COM ', password: PASSWORD });
    expect(res.statusCode).toBe(200);
  });

  it('after 5 failures in 15 minutes refuses even the right password, until the lockout ends (AC-6, E13)', async () => {
    const { login, clock, attempts } = await authApp();
    for (let i = 0; i < 5; i++) {
      expect((await login({ email: 'ada@example.com', password: `guess ${i}` })).statusCode).toBe(
        401,
      );
      clock.now = new Date(clock.now.getTime() + 60_000);
    }
    const locked = await login({ email: 'ada@example.com', password: PASSWORD });
    expect(locked.statusCode).toBe(429);
    expect(locked.headers['retry-after']).toBe(String(10 * 60));
    expect(errorOf(locked)).toEqual({
      code: 'RATE_LIMITED',
      message: 'Too many sign-in attempts. Try again in 10 minutes.',
    });
    // Guessing while locked isn't counted, so it can't keep the account locked.
    const rows = attempts.rows.length;
    await login({ email: 'ada@example.com', password: 'another guess' });
    expect(attempts.rows).toHaveLength(rows);

    clock.now = new Date(clock.now.getTime() + 10 * 60_000);
    expect((await login({ email: 'ada@example.com', password: PASSWORD })).statusCode).toBe(200);
  });

  it('lets at most 5 guesses through when they arrive at once (AC-6, guesses in parallel)', async () => {
    let open!: () => void;
    const verifyGate = new Promise<void>((resolve) => (open = resolve));
    const { login, verified } = await authApp({ verifyGate });
    const statuses: number[] = [];
    const guesses = Array.from({ length: 10 }, (_, i) =>
      login({ email: 'ada@example.com', password: `guess ${i}` }, {}, `10.0.1.${i}`).then((res) =>
        statuses.push(res.statusCode),
      ),
    );
    try {
      // Every guess has either reached the (held) password check or been answered.
      await eventually(() => verified.length + statuses.length === 10);
      expect(verified).toHaveLength(5);
    } finally {
      open();
      await Promise.all(guesses);
    }
    expect(statuses.sort()).toEqual([401, 401, 401, 401, 401, 429, 429, 429, 429, 429]);
  });

  it('also locks an IP address after 20 failures, whatever the emails, but not after 5 (Q8)', async () => {
    const { login } = await authApp();
    for (let i = 0; i < 19; i++) {
      expect((await login({ email: `user${i}@x.io`, password: 'guess' })).statusCode).toBe(401);
    }
    // Colleagues behind one office address can still sign in after a few typos.
    expect((await login({ email: 'ada@example.com', password: PASSWORD })).statusCode).toBe(200);
    await login({ email: 'user19@x.io', password: 'guess' });
    await login({ email: 'user20@x.io', password: 'guess' });
    expect((await login({ email: 'ada@example.com', password: PASSWORD })).statusCode).toBe(429);
  });

  it('forgets an account’s failures once it signs in', async () => {
    const { login } = await authApp();
    // A new address each time, so only the account's count matters.
    let n = 0;
    const attempt = (password: string) =>
      login({ email: 'ada@example.com', password }, {}, `10.0.0.${++n}`);
    for (let i = 0; i < 4; i++) expect((await attempt('typo')).statusCode).toBe(401);
    expect((await attempt(PASSWORD)).statusCode).toBe(200);
    // Counting from zero again: 4 more failures still leave the account open.
    for (let i = 0; i < 4; i++) expect((await attempt('typo')).statusCode).toBe(401);
    expect((await attempt(PASSWORD)).statusCode).toBe(200);
  });

  it('refuses a sign-in posted from another site (login CSRF)', async () => {
    const { login, logs } = await authApp();
    const res = await login(
      { email: 'ada@example.com', password: PASSWORD },
      { origin: 'https://evil.example' },
    );
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).message).toBe(`Sign in at ${ORIGIN}.`);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(logs.text()).toContain('sign-in from another origin refused');
    const same = await login({ email: 'ada@example.com', password: PASSWORD }, { origin: ORIGIN });
    expect(same.statusCode).toBe(200);
  });

  it('asks for both fields when the body is not { email, password }', async () => {
    const { login } = await authApp();
    const res = await login({ email: 'ada@example.com' });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res)).toEqual({
      code: 'INVALID_INPUT',
      message: 'Enter your email and password.',
    });
  });

  it('logs failed and locked sign-ins without the email (SPEC-001 §10 auth.login_failed)', async () => {
    const { login, logs } = await authApp();
    for (let i = 0; i < 6; i++) await login({ email: 'ada@example.com', password: `guess ${i}` });
    const failed = logs.lines.filter((l) => l['event'] === 'auth.login_failed');
    expect(failed.map((l) => l['reason'])).toEqual([
      ...Array<string>(5).fill('incorrect'),
      'locked',
    ]);
    expect(logs.text()).not.toContain('ada@example.com');
    await login({ email: 'nobody@example.com', password: 'guess' }, {}, '10.9.9.9');
    expect(logs.text()).not.toContain('nobody@example.com');
  });

  it('never logs the password or the session token', async () => {
    const { login, signIn, logs } = await authApp();
    await login({ email: 'ada@example.com', password: 'a wrong password' });
    const { token } = await signIn();
    expect(logs.text()).not.toContain('a wrong password');
    expect(logs.text()).not.toContain(PASSWORD);
    expect(logs.text()).not.toContain(token);
  });
});

describe('signing in again', () => {
  it('ends the session the browser had, and closes its sockets', async () => {
    const { app, signIn, store, closed } = await authApp();
    const first = await signIn();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'ada@example.com', password: PASSWORD },
      headers: { cookie: first.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect([...store.sessions.values()].map((s) => s.id)).toEqual(['session-2']);
    expect(closed).toEqual(['session-1']);
  });
});

describe('a signed-in request', () => {
  it('knows who it is from: GET /auth/session gives the user and workspace', async () => {
    const { app, signIn } = await authApp();
    expect((await app.inject({ url: '/auth/session' })).statusCode).toBe(401);
    const { cookie } = await signIn();
    const res = await app.inject({ url: '/auth/session', headers: { cookie } });
    expect(res.json()).toEqual({ ok: true, result: { userId: ADA, workspaceId: WORKSPACE } });
    expect(String(res.headers['set-cookie'])).toMatch(/^surface_csrf=/);
  });

  it('reads memberships per request, so joining a team applies at once', async () => {
    const { app, store, signIn } = await authApp();
    const { cookie } = await signIn();
    const groups = async () =>
      (await app.inject({ url: '/api/echo', headers: { cookie } })).json<{ groups: string[] }>()
        .groups;
    expect(await groups()).not.toContain('team:sec');
    store.memberships.set(ADA, [{ teamId: 'sec', private: true }]);
    expect(await groups()).toContain('team:sec');
  });

  it('extends the session at most every 5 minutes (sliding expiry)', async () => {
    const { app, store, clock, signIn } = await authApp();
    const { cookie } = await signIn();
    const get = () => app.inject({ url: '/api/echo', headers: { cookie } });
    clock.now = new Date(clock.now.getTime() + 4 * 60_000);
    await get();
    expect(store.touches).toEqual([]);
    clock.now = new Date(clock.now.getTime() + 60_000);
    await get();
    await get();
    expect(store.touches).toEqual(['session-1']);
  });

  it('sends the cookies again when it extends the session, so the browser keeps them 30 days more', async () => {
    const { app, clock, signIn } = await authApp();
    const { cookie, token, csrf } = await signIn();
    const get = () => app.inject({ url: '/api/echo', headers: { cookie } });
    expect((await get()).headers['set-cookie']).toBeUndefined();
    clock.now = new Date(clock.now.getTime() + 5 * 60_000);
    const extended = await get();
    // A response carrying the session token is never kept by a shared cache.
    expect(extended.headers['cache-control']).toBe('no-store');
    const cookies = [extended.headers['set-cookie'] ?? []].flat();
    expect(cookies).toEqual([
      `surface_session=${token}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure`,
      `surface_csrf=${csrf}; Path=/; Max-Age=2592000; SameSite=Lax; Secure`,
    ]);
  });

  it('does not send the session cookie again when the response signs out', async () => {
    const { app, clock, signIn } = await authApp();
    const { cookie, csrf } = await signIn();
    clock.now = new Date(clock.now.getTime() + 5 * 60_000);
    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie, 'x-csrf-token': csrf },
    });
    expect([res.headers['set-cookie'] ?? []].flat()).toEqual([
      'surface_session=; Path=/; Max-Age=0; SameSite=Lax; Secure',
      'surface_csrf=; Path=/; Max-Age=0; SameSite=Lax; Secure',
    ]);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('is signed out once the session expires (E14); the stale cookie is cleared', async () => {
    const { app, clock, signIn } = await authApp();
    const { cookie } = await signIn();
    clock.now = new Date(clock.now.getTime() + SESSION_TTL_MS + 1);
    const res = await app.inject({ url: '/auth/session', headers: { cookie } });
    expect(res.statusCode).toBe(401);
    expect(String(res.headers['set-cookie'])).toContain('surface_session=; Path=/; Max-Age=0');
  });
});

describe('CSRF on cookie-authenticated POSTs', () => {
  it('refuses a POST without the token, or with another session’s', async () => {
    const { app, signIn } = await authApp();
    const { cookie, csrf } = await signIn();
    const other = await signIn();
    const post = (headers: Record<string, string>) =>
      app.inject({ method: 'POST', url: '/api/echo', headers: { cookie, ...headers } });
    const attempts: Record<string, string>[] = [
      {},
      { 'x-csrf-token': 'forged' },
      { 'x-csrf-token': other.csrf },
    ];
    for (const headers of attempts) {
      const res = await post(headers);
      expect(res.statusCode).toBe(403);
      // A code of its own, so the client refreshes the token instead of retrying (SPEC-001 Q7).
      expect(errorOf(res)).toEqual({
        code: 'CSRF_INVALID',
        message: 'This request is missing its security token. Reload the page and try again.',
      });
    }
    const ok = await post({ 'x-csrf-token': csrf });
    expect([ok.statusCode, ok.json<{ userId: string }>().userId]).toEqual([200, ADA]);
  });

  it('answers 503 when shutdown began before the server was ever ready (tables may not exist)', async () => {
    const { signIn, lifecycle, store } = await authApp();
    const { cookie } = await signIn();
    // A fresh lifecycle that never got ready, as when startup fails or a signal arrives early.
    const early = await authApp({ ready: false });
    early.lifecycle.beginDraining();
    early.store.session = () => Promise.reject(new Error('relation "sessions" does not exist'));
    const login = await early.login({ email: 'ada@example.com', password: PASSWORD });
    expect([login.statusCode, errorOf(login).code]).toEqual([503, 'UNAVAILABLE']);
    // The CSRF check doesn't read the sessions table either: the route answers.
    const logout = await early.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie },
    });
    expect([logout.statusCode, errorOf(logout).code]).toEqual([503, 'UNAVAILABLE']);
    // The ready app is unaffected.
    expect(lifecycle.state).toBe('ready');
    expect(store.sessions.size).toBe(1);
  });

  it('still checks the token while the server shuts down (operations still run then)', async () => {
    const { app, signIn, lifecycle } = await authApp();
    const { cookie } = await signIn();
    lifecycle.beginDraining();
    const res = await app.inject({ method: 'POST', url: '/api/echo', headers: { cookie } });
    expect(res.statusCode).toBe(403);
  });

  it('needs no token to read, or without a session cookie (the route then answers 401)', async () => {
    const { app, signIn } = await authApp();
    const { cookie } = await signIn();
    expect((await app.inject({ url: '/api/echo', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/echo' })).statusCode).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  it('ends the session, closes its sockets, and the next request is 401 (AC-8, unit part)', async () => {
    const { app, signIn, closed } = await authApp();
    const { cookie, csrf } = await signIn();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie, 'x-csrf-token': csrf },
    });
    expect(res.statusCode).toBe(200);
    expect(closed).toEqual(['session-1']);
    expect(String(res.headers['set-cookie'])).toContain('surface_session=; Path=/; Max-Age=0');
    expect((await app.inject({ url: '/auth/session', headers: { cookie } })).statusCode).toBe(401);
  });

  it('needs the CSRF token, so another site can’t sign you out', async () => {
    const { app, signIn, closed } = await authApp();
    const { cookie } = await signIn();
    const res = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });
    expect(res.statusCode).toBe(403);
    expect(closed).toEqual([]);
  });
});

describe('GET /auth/capabilities', () => {
  it('says whether email sign-in is available and setup is done', async () => {
    const off = await authApp({ config: { smtp: null } });
    expect((await off.app.inject({ url: '/auth/capabilities' })).json()).toEqual({
      ok: true,
      result: { smtp: false, setupComplete: true },
    });
    const on = await authApp({
      config: { smtp: { url: 'smtp://mail.example.com:587', from: 'Surface <s@example.com>' } },
    });
    expect((await on.app.inject({ url: '/auth/capabilities' })).json()).toMatchObject({
      result: { smtp: true },
    });
  });
});
