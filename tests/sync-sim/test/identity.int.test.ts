/**
 * SPEC-002 E14 against the real server: a tab's replica and queue belong to
 * one user, whoever signs in next on the browser. A private-team leak test
 * (permissions.md §5), which the testing hold exempts: a row in another
 * user's sync groups never reaches the replica, and a queued change never
 * runs as another user.
 *
 * One browser holds one cookie at a time; "user 2 signs in" swaps it under a
 * tab that user 1 opened, as when user 1's session ends and user 2 signs in
 * on the same machine while the tab stays open. Real timers, real sockets.
 */
import 'fake-indexeddb/auto';
import { randomUUID } from 'node:crypto';
import { setTimeout as tick } from 'node:timers/promises';
import { DebugItem, PRODUCTION_MODELS } from '@surface/domain/model';
import { debugRename } from '@surface/operations';
import type {
  ConnectionState,
  FetchLike,
  SocketConnection,
  SocketHandlers,
  StorageConnector,
} from '@surface/sync-client';
import { SyncStore } from '@surface/sync-client';
import { IndexedDbStorage } from '@surface/sync-client/testing';
import type { TestDatabaseHandle, TestServer, TestUser } from '@surface/server/testing';
import { createDatabaseFrom, errorLogger, startTestServer } from '@surface/server/testing';
import { CSRF_HEADER } from '@surface/sync-protocol';
import { afterEach, describe, expect, inject, it } from 'vitest';
import { BrowserLocks } from '../src/locks.js';

const MODELS = [DebugItem, ...PRODUCTION_MODELS];
const WAIT_MS = 10_000;

/** One browser: one cookie jar, signed in as one user at a time. */
class Browser {
  readonly locks = new BrowserLocks();
  readonly #sockets: WebSocket[] = [];

  /** Sockets opened so far. */
  get sockets(): number {
    return this.#sockets.length;
  }

  constructor(
    readonly server: TestServer,
    public signedIn: TestUser,
  ) {}

  readonly fetch: FetchLike = (url, init) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', this.signedIn.cookie);
    if ((init.method ?? 'GET').toUpperCase() === 'POST') {
      headers.set(CSRF_HEADER, this.signedIn.csrfToken);
    }
    return fetch(this.#onServer(url, 'http:'), { ...init, headers });
  };

  readonly socket = (url: string, handlers: SocketHandlers): SocketConnection => {
    const ws: unknown = Reflect.construct(WebSocket, [
      this.#onServer(url, 'ws:'),
      { headers: { cookie: this.signedIn.cookie } },
    ]);
    if (!(ws instanceof WebSocket)) throw new TypeError('This runtime has no WebSocket.');
    this.#sockets.push(ws);
    ws.addEventListener('open', () => handlers.onOpen());
    ws.addEventListener('message', (event: MessageEvent) => handlers.onMessage(event.data));
    ws.addEventListener('close', (event) => handlers.onClose(event.code));
    return {
      send: (data) => ws.send(data),
      close: (code, reason) =>
        ws.close(code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000, reason),
    };
  };

  /** The network drops every open socket: the tabs reconnect with today's cookie. */
  drop(): void {
    for (const ws of this.#sockets) ws.close();
  }

  #onServer(url: string, protocol: 'http:' | 'ws:'): string {
    const target = new URL(url);
    const server = new URL(this.server.url);
    target.protocol = protocol;
    target.host = server.host;
    return target.toString();
  }
}

interface Tab {
  readonly store: SyncStore;
  readonly revoked: () => number;
}

let replicas = 0;
/** A fresh IndexedDB per test, so replicas never carry over. */
const workspace = () => `identity-${process.pid}-${(replicas += 1)}`;

function openTab(browser: Browser, user: TestUser, workspaceId: string, name: string): Tab {
  let revoked = 0;
  const connectStorage: StorageConnector = (replica, models) =>
    IndexedDbStorage.open(replica, models);
  const store = new SyncStore({
    models: MODELS,
    workspaceId,
    userId: user.id,
    fetch: browser.fetch,
    baseUrl: 'http://surface.test',
    connectStorage,
    locks: browser.locks.forTab(name),
    connection: { socket: browser.socket },
    onRejected: () => undefined,
    onSessionRevoked: () => (revoked += 1),
  });
  return { store, revoked: () => revoked };
}

/** Poll a condition with a deadline (no fixed sleeps). */
async function until(what: string, condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = performance.now() + WAIT_MS;
  while (!(await condition())) {
    if (performance.now() > deadline) throw new Error(`Not within ${WAIT_MS} ms: ${what}`);
    await tick(10);
  }
}

const settled = (state: ConnectionState) => state === 'online' || state === 'revoked';

let database: TestDatabaseHandle | undefined;
let server: TestServer | undefined;
const stores: SyncStore[] = [];
const problems: string[] = [];

afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  await server?.stop();
  server = undefined;
  await database?.drop();
  database = undefined;
  // Any 5xx or error the server logged is a failure of the test.
  expect(problems.splice(0)).toEqual([]);
});

async function start(): Promise<{ s: TestServer; user1: TestUser; user2: TestUser }> {
  database = await createDatabaseFrom(inject('pgAdminUrl'), inject('pgTemplateDb'));
  server = await startTestServer({
    databaseUrl: database.url,
    users: 2,
    logger: errorLogger((summary) => problems.push(summary)),
  });
  const [user1, user2] = server.users;
  if (user1 === undefined || user2 === undefined) throw new Error('Expected two users.');
  return { s: server, user1, user2 };
}

async function ready(tab: Tab): Promise<void> {
  stores.push(tab.store);
  await tab.store.start();
  await until('the tab is online', () => tab.store.connection === 'online');
}

describe('another user signs in on the same browser (SPEC-002 E14)', () => {
  it("never streams the other user's rows into the open tab's replica", async () => {
    const { s, user1, user2 } = await start();
    const shared = randomUUID();
    expect((await s.run(user1, 'debug.create', { id: shared, title: 'Shared' })).ok).toBe(true);

    const browser = new Browser(s, user1);
    const tab = openTab(browser, user1, workspace(), 'tab-1');
    await ready(tab);
    expect(tab.store.pool.get(DebugItem, shared)?.title).toBe('Shared');
    // User 2's own browser, to know when user 2's row has gone out.
    const own = openTab(new Browser(s, user2), user2, workspace(), 'tab-2');
    await ready(own);

    browser.signedIn = user2;
    const before = browser.sockets;
    browser.drop();
    await until(
      'the tab has reconnected or been refused',
      () => browser.sockets > before && settled(tab.store.connection),
    );
    // A row only user 2's groups reach. A private team only user 2 is in would match
    // permissions.md §5 word for word, but no operation makes a team private yet
    // (team.create makes public teams), so user 2's own group stands in.
    const secret = randomUUID();
    const created = await s.run(user2, 'debug.create', {
      id: secret,
      title: 'Only user 2',
      groups: [`user:${user2.id}`],
    });
    expect(created.ok).toBe(true);
    // A revoked tab never reconnects, so nothing can reach it after this; a tab
    // that is online as user 2 gets the row as user 2's own tab does.
    await until(
      "user 2's own tab has the row, and the tab is down or has it too",
      () =>
        own.store.pool.get(DebugItem, secret) !== undefined &&
        (tab.store.connection === 'revoked' || tab.store.pool.get(DebugItem, secret) !== undefined),
    );

    expect(tab.store.pool.get(DebugItem, secret)).toBeUndefined();
    expect(tab.store.connection).toBe('revoked');
    expect(tab.revoked()).toBe(1);
    // User 1's replica is kept for when user 1 signs in again.
    expect(tab.store.pool.get(DebugItem, shared)?.title).toBe('Shared');
  });

  it('runs nothing as the other user, and sends the change once its user signs in again', async () => {
    const { s, user1, user2 } = await start();
    const item = randomUUID();
    expect((await s.run(user1, 'debug.create', { id: item, title: 'Before' })).ok).toBe(true);

    const browser = new Browser(s, user1);
    const workspaceId = workspace();
    const tab = openTab(browser, user1, workspaceId, 'tab-1');
    await ready(tab);

    browser.signedIn = user2;
    const outcome = tab.store.dispatch(debugRename, { id: item, title: 'By user 1' });
    let answered = false;
    void outcome.then(() => (answered = true));
    await until(
      'the tab learns its session is gone, or its change is answered',
      () => tab.store.connection === 'revoked' || answered,
    );

    expect((await s.items()).find((row) => row.id === item)?.title).toBe('Before');
    expect(answered).toBe(false);
    expect(tab.store.pending.map((p) => p.op)).toEqual(['debug.rename']);
    expect(tab.revoked()).toBe(1);

    // User 1 signs in again: the app closes the tab's store and opens a new one,
    // which takes over the queue left behind and sends it as user 1.
    await tab.store.close();
    browser.signedIn = user1;
    const again = openTab(browser, user1, workspaceId, 'tab-1-again');
    await ready(again);
    await until('the change is saved', async () => {
      return (await s.items()).find((row) => row.id === item)?.title === 'By user 1';
    });
    await until('the queue is empty', () => again.store.pending.length === 0);
  });
});
