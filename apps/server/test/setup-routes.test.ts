// PLAN-001 S2, SPEC-001 §3.1 and §6.1: `GET /setup/status`, `POST /setup`, and the guard that
// closes the app until setup is done (AC-1, unit part). The Postgres transaction behind
// `POST /setup` (AC-2, E1) is `setup/store.ts`: its decisions are unit-tested in
// `setup-store.test.ts`; the integration test is held (README §6) and was checked by hand.
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { CSRF_COOKIE } from '@surface/sync-protocol';
import { csrfToken } from '../src/auth/csrf.js';
import { SessionAuth } from '../src/auth/sessions.js';
import { SESSION_COOKIE, type CreatedSession } from '../src/auth/session.js';
import type { Config } from '../src/config.js';
import { Lifecycle } from '../src/lifecycle.js';
import { createLogger } from '../src/logger.js';
import type { SetupInput } from '../src/setup/input.js';
import { SetupGate } from '../src/setup/routes.js';
import type { SetupOutcome, SetupStore } from '../src/setup/store.js';
import { FakeAttempts, FakeAuthStore } from './auth-fakes.js';
import { captureLogs, fakeWebDir, testConfig } from './helpers.js';

const TOKEN = 'ABCD-EFGH-JKMN-PQRS-TVWX-YZ01-2345-6789';
const PASSWORD = 'correct horse battery';
const ADMIN_ID = 'ada-0000-0000-0000-000000000001';

class FakeStore implements SetupStore {
  completed = false;
  completeCalls: SetupInput[] = [];
  stateReads = 0;
  isComplete = () => {
    this.stateReads += 1;
    return Promise.resolve(this.completed);
  };
  tokenValid = (token: string) => Promise.resolve(!this.completed && token === TOKEN);
  issueToken = () => Promise.resolve(!this.completed);
  complete = (input: SetupInput): Promise<SetupOutcome> => {
    this.completeCalls.push(input);
    if (this.completed) return Promise.resolve({ ok: false, reason: 'complete' });
    if (input.token !== TOKEN) return Promise.resolve({ ok: false, reason: 'token' });
    this.completed = true;
    const session: CreatedSession = {
      id: 'session-1',
      token: 'session-token-value',
      expiresAt: new Date(0),
    };
    return Promise.resolve({ ok: true, session, userId: ADMIN_ID, teamKey: input.team.key });
  };
}

let apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.map((a) => a.close()));
  apps = [];
});

async function setupApp({
  ready = true,
  config: overrides = {},
  withAuth = false,
}: { ready?: boolean; config?: Partial<Config>; withAuth?: boolean } = {}) {
  const config = testConfig({ logLevel: 'info', webDir: fakeWebDir(), ...overrides });
  const logs = captureLogs();
  const lifecycle = new Lifecycle();
  const store = new FakeStore();
  const app = await buildApp({
    config,
    lifecycle,
    logger: createLogger(config, logs.stream),
    setup: { store, gate: new SetupGate(store) },
    // The sign-in routes too, for what the login page asks before setup (PLAN-001 S3).
    ...(withAuth
      ? {
          auth: {
            auth: new SessionAuth(new FakeAuthStore()),
            store: new FakeAuthStore(),
            attempts: new FakeAttempts(),
          },
        }
      : {}),
  });
  apps.push(app);
  if (ready) lifecycle.markReady();
  return { app, store, logs, lifecycle };
}

/** The SPEC-003 error of a response (`{ ok: false, error }`). */
function errorOf(res: { json: <T>() => T }) {
  return res.json<{ ok: false; error: { code: string; message: string } }>().error;
}

const page = { accept: 'text/html,application/xhtml+xml' };

function form(over: Record<string, unknown> = {}) {
  return {
    token: TOKEN,
    workspace: { name: 'Acme' },
    admin: { name: 'Ada Lovelace', email: 'Ada@Example.com', password: PASSWORD },
    team: { name: 'Engineering', key: 'eng' },
    ...over,
  };
}

describe('while setup is incomplete', () => {
  it('closes the API, sync, auth, files and MCP with 503 SETUP_REQUIRED', async () => {
    const { app } = await setupApp();
    for (const [method, url] of [
      ['POST', '/api/ops/workspace.get'],
      ['GET', '/sync/bootstrap'],
      ['GET', '/sync/ws'],
      ['POST', '/auth/login'],
      ['GET', '/files/abc'],
      ['POST', '/mcp'],
      // The router percent-decodes before matching, so these reach the same routes.
      ['POST', '/%61pi/ops/workspace.get'],
      ['GET', '/%73ync/bootstrap'],
      ['POST', '/%61uth/login'],
      ['POST', '/%6dcp'],
    ] as const) {
      const res = await app.inject({ method, url });
      expect([url, res.statusCode]).toEqual([url, 503]);
      expect(errorOf(res)).toMatchObject({ code: 'SETUP_REQUIRED' });
      expect(errorOf(res).message).toContain('setup link');
    }
  });

  it('sends a browser asking for any page to /setup, and serves the wizard there', async () => {
    const { app } = await setupApp();
    for (const url of ['/', '/team/ENG', '/settings/members?x=1']) {
      const res = await app.inject({ url, headers: page });
      expect([url, res.statusCode, res.headers.location]).toEqual([url, 302, '/setup']);
    }
    const wizard = await app.inject({ url: `/setup?token=${TOKEN}`, headers: page });
    expect(wizard.statusCode).toBe(200);
    expect(wizard.headers['content-type']).toContain('text/html');
  });

  it('keeps health, readiness, static files and the setup status open', async () => {
    const { app } = await setupApp();
    for (const url of [
      '/healthz',
      '/readyz',
      '/assets/index-abc123.js',
      '/favicon.svg',
      '/setup/status',
    ]) {
      const res = await app.inject({ url });
      expect([url, res.statusCode]).toEqual([url, 200]);
    }
  });

  it('tells the login page that setup isn’t done, so it can send the user to /setup', async () => {
    const { app, store } = await setupApp({ withAuth: true, config: { smtp: null } });
    const capabilities = async () =>
      (await app.inject({ url: '/auth/capabilities' })).json<unknown>();
    expect(await capabilities()).toEqual({
      ok: true,
      result: { smtp: false, setupComplete: false },
    });
    // Every other sign-in route stays closed until then.
    const session = await app.inject({ url: '/auth/session' });
    expect([session.statusCode, session.json<{ error: { code: string } }>().error.code]).toEqual([
      503,
      'SETUP_REQUIRED',
    ]);
    store.completed = true;
    expect(await capabilities()).toMatchObject({ result: { setupComplete: true } });
  });

  it('stays closed while the server shuts down', async () => {
    const { app, lifecycle } = await setupApp();
    lifecycle.beginDraining();
    const res = await app.inject({ method: 'POST', url: '/api/ops/workspace.get' });
    expect([res.statusCode, errorOf(res).code]).toEqual([503, 'SETUP_REQUIRED']);
  });

  it('answers 503, not an error, when shutdown began before the server was ever ready', async () => {
    const { app, store, lifecycle } = await setupApp({ ready: false });
    lifecycle.beginDraining();
    const res = await app.inject({ method: 'POST', url: '/setup', payload: form() });
    expect([res.statusCode, errorOf(res).code]).toEqual([503, 'UNAVAILABLE']);
    const api = await app.inject({ method: 'POST', url: '/api/ops/workspace.get' });
    expect(api.statusCode).not.toBe(500);
    expect(store.stateReads).toBe(0);
  });

  it('leaves startup alone: before the server is ready the routes answer 503 UNAVAILABLE', async () => {
    const { app, store } = await setupApp({ ready: false });
    const res = await app.inject({ method: 'POST', url: '/setup', payload: form() });
    expect([res.statusCode, res.headers['retry-after']]).toEqual([503, '5']);
    expect(res.json()).toMatchObject({ error: { code: 'UNAVAILABLE' } });
    expect(store.stateReads).toBe(0);
  });
});

describe('GET /setup/status', () => {
  it('says whether setup is done and whether the link’s token is valid', async () => {
    const { app, store } = await setupApp();
    const status = async (query = '') =>
      (await app.inject({ url: `/setup/status${query}` })).json<{ result: unknown }>().result;
    expect(await status(`?token=${TOKEN}`)).toEqual({ complete: false, tokenValid: true });
    expect(await status('?token=WRONG')).toEqual({ complete: false, tokenValid: false });
    expect(await status()).toEqual({ complete: false, tokenValid: false });
    store.completed = true;
    expect(await status(`?token=${TOKEN}`)).toEqual({ complete: true, tokenValid: false });
  });
});

describe('POST /setup', () => {
  it('without the setup token cannot complete (AC-1)', async () => {
    const { app, store } = await setupApp();
    const res = await app.inject({
      method: 'POST',
      url: '/setup',
      payload: form({ token: 'GUESS' }),
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).code).toBe('FORBIDDEN');
    expect(errorOf(res).message).toContain('surface setup-token');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(store.completed).toBe(false);
    // Refused before the password is hashed: hashing costs 19 MiB, and anyone can send this.
    expect(store.completeCalls).toEqual([]);
    const missing = await app.inject({
      method: 'POST',
      url: '/setup',
      payload: { ...form(), token: undefined },
    });
    expect(missing.statusCode).toBe(400);
  });

  it('creates the workspace, signs the Admin in with a session cookie, and opens the app', async () => {
    const { app, store, logs } = await setupApp();
    const admin = {
      name: 'Ada Lovelace',
      email: 'Ada@Example.com',
      password: PASSWORD,
      timezone: 'europe/berlin',
    };
    const res = await app.inject({ method: 'POST', url: '/setup', payload: form({ admin }) });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ok: true, result: { next: '/team/ENG' } });
    // SPEC-001 AC-7: HttpOnly, SameSite=Lax and Secure on an https SURFACE_URL. The CSRF cookie
    // comes with the session, readable by the page (PLAN-001 S3).
    expect(res.headers['set-cookie']).toEqual([
      `${SESSION_COOKIE}=session-token-value; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax; Secure`,
      `${CSRF_COOKIE}=${csrfToken(testConfig().sessionSecret, 'session-1')}; Path=/; Max-Age=2592000; SameSite=Lax; Secure`,
    ]);
    // Normalised before the store sees them: email lowercase (INV-02), key uppercase, the zone
    // spelled canonically.
    expect(store.completeCalls[0]).toMatchObject({
      admin: { email: 'ada@example.com', timezone: 'Europe/Berlin' },
      team: { key: 'ENG' },
    });
    // Open now, without asking the database again.
    const reads = store.stateReads;
    expect((await app.inject({ url: '/', headers: page })).statusCode).toBe(200);
    expect((await app.inject({ url: '/setup', headers: page })).headers.location).toBe('/');
    expect((await app.inject({ method: 'POST', url: '/api/ops/x' })).statusCode).not.toBe(503);
    expect(store.stateReads).toBe(reads);
    // Neither the password nor the token reaches the logs.
    expect(logs.text()).not.toContain(PASSWORD);
    expect(logs.text()).not.toContain(TOKEN);
  });

  it('logs the first Admin joining by id, never the email or tokens (SPEC-001 §10 user.joined)', async () => {
    const { app, logs } = await setupApp();
    const admin = { name: 'Ada Lovelace', email: 'ada@example.com', password: PASSWORD };
    const res = await app.inject({
      method: 'POST',
      url: '/setup',
      payload: form({ admin }),
      remoteAddress: '10.1.2.3',
    });
    expect(res.statusCode).toBe(201);
    const joined = logs.lines.filter((l) => l['event'] === 'user.joined');
    expect(joined).toEqual([
      expect.objectContaining({
        level: 'info',
        audit: true,
        userId: ADMIN_ID,
        sessionId: 'session-1',
        ip: '10.1.2.3',
        reason: 'setup',
      }),
    ]);
    const text = logs.text();
    for (const secret of ['ada@example.com', PASSWORD, TOKEN, 'session-token-value']) {
      expect(text).not.toContain(secret);
    }
  });

  it('answers a second setup with 409 "Setup is already complete" (E1)', async () => {
    const { app, store } = await setupApp();
    expect((await app.inject({ method: 'POST', url: '/setup', payload: form() })).statusCode).toBe(
      201,
    );
    const again = await app.inject({ method: 'POST', url: '/setup', payload: form() });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({
      error: { code: 'CONFLICT', message: 'Setup is already complete. Sign in instead.' },
    });
    expect(store.completeCalls).toHaveLength(1); // the second never reaches the password hash
  });

  it('answers 409 when another setup finished between the check and the transaction', async () => {
    const { app, store } = await setupApp();
    // The store's check under the row lock is the one that counts (E1).
    store.complete = () => Promise.resolve({ ok: false, reason: 'complete' });
    const res = await app.inject({ method: 'POST', url: '/setup', payload: form() });
    expect(res.statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/ops/x' })).statusCode).not.toBe(503);
  });

  it('omits Secure on an http SURFACE_URL, so a local install can sign in', async () => {
    const { app } = await setupApp({ config: { secureCookies: false } });
    const res = await app.inject({ method: 'POST', url: '/setup', payload: form() });
    expect(res.headers['set-cookie']).toHaveLength(2);
    expect(String(res.headers['set-cookie'])).not.toContain('Secure');
  });

  it.each([
    [
      'a short password',
      { admin: { name: 'Ada', email: 'ada@example.com', password: 'short' } },
      'Password must be at least 10 characters long',
    ],
    [
      'an invalid email',
      { admin: { name: 'Ada', email: 'ada', password: PASSWORD } },
      'Email must look like name@example.com',
    ],
    [
      'a team key with digits',
      { team: { name: 'Eng', key: 'EN1' } },
      'Team key must be 2–5 capital letters, like ENG',
    ],
    ['a reserved team key', { team: { name: 'Api', key: 'API' } }, 'API is reserved'],
    ['a blank workspace name', { workspace: { name: '   ' } }, 'Workspace name is required'],
    [
      'a workspace name over 64 characters',
      { workspace: { name: 'a'.repeat(65) } },
      'Workspace name must be at most 64 characters long',
    ],
    [
      'a UTC offset instead of a time zone',
      { admin: { name: 'Ada', email: 'ada@example.com', password: PASSWORD, timezone: '+05:00' } },
      '"+05:00" is not a time zone. Use an IANA name, like Europe/Berlin or UTC',
    ],
  ])('refuses %s with 400 and a sentence saying how to fix it', async (_case, over, message) => {
    const { app, store, logs } = await setupApp();
    const res = await app.inject({ method: 'POST', url: '/setup', payload: form(over) });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe('INVALID_INPUT');
    expect(errorOf(res).message).toContain(message);
    expect(store.completeCalls).toEqual([]);
    expect(res.body).not.toContain(PASSWORD);
    expect(logs.text()).not.toContain(PASSWORD);
  });
});
