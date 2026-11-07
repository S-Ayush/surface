// PLAN-002 S4: `GET /sync/ws` (sync-protocol §4.3): who may open it, what is refused before the
// upgrade, and deltas end to end through real WebSockets (the server on 127.0.0.1, Node's own
// WebSocket client) over the in-memory sync log.
import { randomUUID } from 'node:crypto';
import {
  CloseCode,
  decodeServerMessage,
  encodeSocketConnectParams,
  SOCKET_PATH,
  type ServerMessage,
} from '@surface/sync-protocol';
import pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
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

const params = (over: { since?: number; schemaHash?: string } = {}) =>
  encodeSocketConnectParams({
    since: over.since ?? 0,
    clientId: randomUUID(),
    schemaHash: over.schemaHash ?? registry.schemaHash,
  });

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

  it('invalid connect parameters, with 400 naming the problem', async () => {
    const { app: server } = await app();
    const res = await server.inject({
      url: `${SOCKET_PATH}?since=01&clientId=x&schemaHash=y`,
      headers: { 'x-test-actor': 'member' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_INPUT' } });
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
