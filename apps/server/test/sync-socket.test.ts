// PLAN-002 S4: `GET /sync/ws` (sync-protocol §4.3): who may open it, what is refused before the
// upgrade, and deltas end to end through real WebSockets (the server on 127.0.0.1, Node's own
// WebSocket client) over the in-memory sync log. SPEC-002 E14: the replica's user (`userId`).
import { randomUUID } from 'node:crypto';
import {
  CloseCode,
  decodeServerMessage,
  encodeSocketConnectParams,
  SOCKET_PATH,
  type ServerMessage,
} from '@surface/sync-protocol';
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { Lifecycle } from '../src/lifecycle.js';
import { createLogger } from '../src/logger.js';
import { SyncHub } from '../src/sync/hub.js';
import { syncRegistry } from '../src/sync/registry.js';
import { actorFor, captureLogs, headerActor, testConfig } from './helpers.js';
import { deferred, FakeLog } from './sync-fake-log.js';

const registry = syncRegistry({ includeFixtures: true });
const member = actorFor({ id: randomUUID() });
const apiKey = actorFor(
  { id: randomUUID() },
  {
    kind: 'api',
    apiKey: { id: randomUUID(), scope: 'read', teamIds: [], allowDestructive: false },
  },
);

let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});

/** Who registered each `clientId` (`client_mutations`), for the ownership check. */
const owners = new Map<string, string>();

async function app({ ready = true } = {}) {
  const config = testConfig();
  const lifecycle = new Lifecycle();
  const source = new FakeLog();
  const hub = new SyncHub({ source, registry, log: createLogger(config, captureLogs().stream) });
  // The bootstrap route needs a pool; nothing here reaches it.
  const pool = new pg.Pool({ connectionString: 'postgres://unused@127.0.0.1:1/unused' });
  const built = await buildApp({
    config,
    lifecycle,
    logger: createLogger(config, captureLogs().stream),
    sync: {
      pool,
      registry,
      resolveActor: headerActor({ member, apiKey }),
      hub,
      clientOwner: (clientId) => Promise.resolve(owners.get(clientId)),
      sessionIdOf: (request) => {
        const id = request.headers['x-test-session'];
        return typeof id === 'string' ? id : undefined;
      },
    },
  });
  cleanup.push(
    () => built.close(),
    () => hub.stop(),
    () => pool.end(),
  );
  if (ready) {
    await hub.start();
    lifecycle.markReady();
  }
  const url = await built.listen({ port: 0, host: '127.0.0.1' });
  return { app: built, hub, source, url: url.replace(/^http/, 'ws') };
}

const params = (
  over: { since?: number; schemaHash?: string; clientId?: string; userId?: string } = {},
) =>
  encodeSocketConnectParams({
    since: over.since ?? 0,
    clientId: over.clientId ?? randomUUID(),
    userId: over.userId ?? member.userId ?? '',
    schemaHash: over.schemaHash ?? registry.schemaHash,
  });

/** What a client from before sync-protocol v0.5 sends: no `userId` (SPEC-002 E14). */
const paramsWithoutUser = (clientId = randomUUID()) =>
  new URLSearchParams({ since: '0', clientId, schemaHash: registry.schemaHash }).toString();

/** Opens a socket and records what it receives, decoded like the client does. */
function open(url: string, query: string, headers: Record<string, string>) {
  const messages: ServerMessage[] = [];
  const closed = deferred<number>();
  const socket = new WebSocket(`${url}${SOCKET_PATH}?${query}`, { headers });
  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') messages.push(decodeServerMessage(event.data));
  });
  socket.addEventListener('close', (event) => closed.resolve(event.code));
  cleanup.push(() => {
    socket.close();
    return Promise.resolve();
  });
  return { socket, messages, closed: closed.promise };
}

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in 2 s');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('GET /sync/ws refuses before the upgrade', () => {
  it('while the server is starting, with 503 and Retry-After', async () => {
    const { app: server, url } = await app({ ready: false });
    const res = await server.inject({
      url: `${SOCKET_PATH}?${params()}`,
      headers: { 'x-test-actor': 'member' },
    });
    expect([res.statusCode, res.headers['retry-after']]).toEqual([503, '5']);
    // A browser sees a refused upgrade as an abnormal close, and retries with backoff.
    const { closed, messages } = open(url, params(), { 'x-test-actor': 'member' });
    expect(await closed).toBe(1006);
    expect(messages).toEqual([]);
  });

  it('an API key, with 403 (as bootstrap, SPEC-002 Q7)', async () => {
    const { app: server } = await app();
    const res = await server.inject({
      url: `${SOCKET_PATH}?${params()}`,
      headers: { 'x-test-actor': 'apiKey' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  });

  it('a page on another origin, with 403, even for a signed-in user (cross-site WebSocket hijacking)', async () => {
    const { app: server, url } = await app();
    const res = await server.inject({
      url: `${SOCKET_PATH}?${params()}`,
      headers: { 'x-test-actor': 'member', origin: 'https://evil.example.net' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    // Same scheme and host on another port is another origin.
    const { closed, messages } = open(url, params(), {
      'x-test-actor': 'member',
      origin: 'https://surface.example.com:8443',
    });
    expect(await closed).toBe(1006);
    expect(messages).toEqual([]);
  });

  it('a clientId another user registered through /sync/mutate, with 403 (it would see its acks)', async () => {
    const { app: server, url, source } = await app();
    const theirs = randomUUID();
    owners.set(theirs, randomUUID());
    const res = await server.inject({
      url: `${SOCKET_PATH}?${params({ clientId: theirs })}`,
      headers: { 'x-test-actor': 'member' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message:
          "This clientId belongs to another user. Use a new clientId for this user's changes.",
      },
    });
    // The member's own registered client is accepted.
    const mine = randomUUID();
    owners.set(mine, member.userId ?? '');
    source.write({});
    const { messages } = open(url, params({ clientId: mine }), { 'x-test-actor': 'member' });
    await eventually(() => messages.length === 1);
    expect(messages[0]?.t).toBe('deltas');
  });

  it('invalid connect parameters, with 400 naming the problem', async () => {
    const { app: server } = await app();
    const res = await server.inject({
      url: `${SOCKET_PATH}?since=01&clientId=x&userId=${member.userId ?? ''}&schemaHash=y`,
      headers: { 'x-test-actor': 'member' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    // A userId that is there but isn't one is invalid too, not an old client.
    const badUser = await server.inject({
      url: `${SOCKET_PATH}?${paramsWithoutUser()}&userId=ada`,
      headers: { 'x-test-actor': 'member' },
    });
    expect(badUser.statusCode).toBe(400);
  });
});

describe('GET /sync/ws and the replica’s user (SPEC-002 E14)', () => {
  it('closes a socket for another user’s replica with 4001, sending nothing and registering nothing', async () => {
    const { url, hub, source } = await app();
    const registered = [vi.spyOn(hub, 'connect'), vi.spyOn(hub, 'connectOutdated')];
    source.write({}, {});
    const { messages, closed } = open(url, params({ userId: randomUUID() }), {
      'x-test-actor': 'member',
    });
    expect(await closed).toBe(CloseCode.SessionRevoked);
    expect(messages).toEqual([]);
    expect(registered.map((spy) => spy.mock.calls.length)).toEqual([0, 0]);
  });

  it('closes with 4001, not 403, a replica’s own registered client opened under another user’s cookie', async () => {
    // The tab of the user who registered the client, after someone else signed in on the browser:
    // a 403 can't be read by a browser (1006) and would be retried forever.
    const { url, hub } = await app();
    const registered = vi.spyOn(hub, 'connect');
    const firstUser = randomUUID();
    const clientId = randomUUID();
    owners.set(clientId, firstUser);
    const { messages, closed } = open(url, params({ clientId, userId: firstUser }), {
      'x-test-actor': 'member',
    });
    expect(await closed).toBe(CloseCode.SessionRevoked);
    expect(messages).toEqual([]);
    expect(registered).not.toHaveBeenCalled();
  });

  it('answers a client without userId (before v0.5) with resync(schema) and no deltas, until its session ends', async () => {
    const { url, hub, source } = await app();
    // Its clientId is neither checked nor registered: another user's is fine.
    const theirs = randomUUID();
    owners.set(theirs, randomUUID());
    const old = open(url, paramsWithoutUser(theirs), {
      'x-test-actor': 'member',
      'x-test-session': 'old-tab',
    });
    await eventually(() => old.messages.length === 1);
    expect(old.messages).toEqual([{ t: 'resync', reason: 'schema' }]);
    expect(hub.connectionCount).toBe(1);
    // A row committed now reaches a current client, and not the old one.
    const current = open(url, params(), { 'x-test-actor': 'member' });
    await eventually(() => hub.connectionCount === 2);
    source.write({});
    await eventually(() => current.messages.some((m) => m.t === 'deltas'));
    expect(old.messages).toEqual([{ t: 'resync', reason: 'schema' }]);
    // Signing out closes it like any socket of that session.
    hub.closeSessions(['old-tab']);
    expect(await old.closed).toBe(CloseCode.SessionRevoked);
  });

  it('answers a client without a session with 4001 even without userId', async () => {
    const { url } = await app();
    const { messages, closed } = open(url, paramsWithoutUser(), {});
    expect(await closed).toBe(CloseCode.SessionRevoked);
    expect(messages).toEqual([]);
  });
});

describe('GET /sync/ws', () => {
  it('accepts a request without a session and closes it at once with 4001 (SPEC-002 E10)', async () => {
    const { url } = await app();
    const { messages, closed } = open(url, params(), {});
    expect(await closed).toBe(CloseCode.SessionRevoked);
    expect(messages).toEqual([]);
  });

  it('catches a signed-in client up, then delivers live deltas', async () => {
    const { url, source } = await app();
    source.write({}, {});
    const { messages } = open(url, params(), { 'x-test-actor': 'member' });
    await eventually(() => messages.length === 1);
    source.write({});
    await eventually(() => messages.length === 2);
    expect(
      messages.map((m) => (m.t === 'deltas' ? [m.prev, m.packets.map((p) => p.id)] : m)),
    ).toEqual([
      [0, [1, 2]],
      [2, [3]],
    ]);
  });

  it('accepts the app’s own origin (SURFACE_URL) and clients that send no Origin', async () => {
    const { url, source } = await app();
    source.write({});
    const fromApp = open(url, params(), {
      'x-test-actor': 'member',
      origin: 'https://surface.example.com',
    });
    const noOrigin = open(url, params(), { 'x-test-actor': 'member' });
    await eventually(() => fromApp.messages.length === 1 && noOrigin.messages.length === 1);
    expect([fromApp.messages[0]?.t, noOrigin.messages[0]?.t]).toEqual(['deltas', 'deltas']);
  });

  it('answers a client with another schema hash with resync(schema)', async () => {
    const { url } = await app();
    const { messages } = open(url, params({ schemaHash: 'a'.repeat(64) }), {
      'x-test-actor': 'member',
    });
    await eventually(() => messages.length === 1);
    expect(messages).toEqual([{ t: 'resync', reason: 'schema' }]);
  });

  it('forgets a connection when the client closes it', async () => {
    const { url, hub } = await app();
    const { socket } = open(url, params(), { 'x-test-actor': 'member' });
    await eventually(() => hub.connectionCount === 1);
    socket.close();
    await eventually(() => hub.connectionCount === 0);
  });

  it('closes a revoked session’s socket with 4001', async () => {
    const { url, hub } = await app();
    const { closed } = open(url, params(), {
      'x-test-actor': 'member',
      'x-test-session': 'session-1',
    });
    await eventually(() => hub.connectionCount === 1);
    hub.closeSessions(['session-1']);
    expect(await closed).toBe(CloseCode.SessionRevoked);
  });

  it('closes a socket whose session another replica ended (NOTIFY session_revoked)', async () => {
    const { url, hub, source } = await app();
    const { closed } = open(url, params(), {
      'x-test-actor': 'member',
      'x-test-session': 'session-1',
    });
    await eventually(() => hub.connectionCount === 1);
    source.revokeSessions(['session-2', 'session-1']);
    expect(await closed).toBe(CloseCode.SessionRevoked);
  });

  it('closes a socket that sends binary data', async () => {
    const { url } = await app();
    const { socket, closed } = open(url, params(), { 'x-test-actor': 'member' });
    await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
    socket.send(new Uint8Array([1, 2, 3]));
    expect(await closed).toBe(1003);
  });
});
