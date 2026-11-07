// PLAN-001 S3, SPEC-001 AC-8 (unit part): signing out closes the session's sockets, wired as the
// server wires it: the real `SessionAuth` resolves the socket's actor and remembers its session,
// and sign-out closes that session through the hub. Real WebSockets on 127.0.0.1, fake stores.
import { CloseCode, encodeSocketConnectParams, SOCKET_PATH } from '@surface/sync-protocol';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterEach, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { CSRF_COOKIE } from '@surface/sync-protocol';
import { hashPassword } from '../src/auth/password.js';
import { SESSION_COOKIE } from '../src/auth/session.js';
import { SessionAuth } from '../src/auth/sessions.js';
import { Lifecycle } from '../src/lifecycle.js';
import { createLogger } from '../src/logger.js';
import { SyncHub } from '../src/sync/hub.js';
import { syncRegistry } from '../src/sync/registry.js';
import { FakeAttempts, FakeAuthStore } from './auth-fakes.js';
import { captureLogs, testConfig } from './helpers.js';
import { deferred, FakeLog } from './sync-fake-log.js';

const PASSWORD = 'correct horse battery';
const registry = syncRegistry({ includeFixtures: true });

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

it('closes the signed-out session’s socket with 4001, and only that one (AC-8)', async () => {
  const config = testConfig();
  const lifecycle = new Lifecycle();
  const logger = createLogger(config, captureLogs().stream);
  const store = new FakeAuthStore();
  store.users.set('ada@example.com', {
    userId: randomUUID(),
    passwordHash: await hashPassword(PASSWORD),
  });
  const sessions = new SessionAuth(store);
  const hub = new SyncHub({ source: new FakeLog(), registry, log: logger });
  // The bootstrap route needs a pool; nothing here reaches it.
  const pool = new pg.Pool({ connectionString: 'postgres://unused@127.0.0.1:1/unused' });
  const app = await buildApp({
    config,
    lifecycle,
    logger,
    sync: {
      pool,
      registry,
      resolveActor: sessions.resolveActor,
      sessionIdOf: sessions.sessionIdOf,
      hub,
    },
    auth: {
      auth: sessions,
      store,
      attempts: new FakeAttempts(),
      closeSessions: (ids) => void hub.closeSessions(ids),
    },
  });
  cleanup.push(
    () => app.close(),
    () => hub.stop(),
    () => pool.end(),
  );
  await hub.start();
  lifecycle.markReady();
  const url = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws');

  const signIn = async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'ada@example.com', password: PASSWORD },
    });
    const value = (name: string) =>
      [res.headers['set-cookie'] ?? []]
        .flat()
        .find((c) => c.startsWith(`${name}=`))
        ?.split(';')[0] ?? '';
    return { cookie: `${value(SESSION_COOKIE)}; ${value(CSRF_COOKIE)}`, csrf: value(CSRF_COOKIE) };
  };
  const openSocket = (cookie: string) => {
    const closed = deferred<number>();
    const query = encodeSocketConnectParams({
      since: 0,
      clientId: randomUUID(),
      schemaHash: registry.schemaHash,
    });
    const socket = new WebSocket(`${url}${SOCKET_PATH}?${query}`, { headers: { cookie } });
    socket.addEventListener('close', (event) => closed.resolve(event.code));
    cleanup.push(() => {
      socket.close();
      return Promise.resolve();
    });
    return closed.promise;
  };

  const laptop = await signIn();
  const phone = await signIn();
  const laptopClosed = openSocket(laptop.cookie);
  void openSocket(phone.cookie);
  const deadline = Date.now() + 5000;
  while (hub.connectionCount < 2) {
    if (Date.now() > deadline) throw new Error('sockets not connected in 5 s');
    await new Promise((resolve) => setImmediate(resolve));
  }

  const res = await app.inject({
    method: 'POST',
    url: '/auth/logout',
    headers: { cookie: laptop.cookie, 'x-csrf-token': laptop.csrf.split('=')[1] ?? '' },
  });
  expect(res.statusCode).toBe(200);
  expect(await laptopClosed).toBe(CloseCode.SessionRevoked);
  // The phone's socket is still connected: only the signed-out session was closed.
  expect(hub.connectionCount).toBe(1);
});
