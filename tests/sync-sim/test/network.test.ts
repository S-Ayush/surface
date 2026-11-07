/**
 * The simulated network does what `network.ts` promises: the properties are
 * only as good as the faults they run under.
 */
import type { SocketConnection, SocketHandlers } from '@surface/sync-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { advance, installClock, uninstallClock } from '../src/clock.js';
import type { Network } from '../src/network.js';
import { Network as SimNetwork } from '../src/network.js';
import { seededRandom } from '../src/random.js';
import type { SimServer } from '../src/server.js';

/** A server that counts requests and records what its sockets receive. */
function fakeServer() {
  const state = {
    requests: 0,
    received: [] as string[],
    closed: [] as number[],
    sockets: [] as SocketHandlers[],
  };
  const server: SimServer = {
    users: ['user-1'],
    problems: [],
    models: [],
    fetch: () => {
      state.requests += 1;
      return Promise.resolve(new Response('ok'));
    },
    socket: (_user, _url, handlers) => {
      state.sockets.push(handlers);
      queueMicrotask(() => handlers.onOpen());
      const connection: SocketConnection = {
        send: (data) => state.received.push(data),
        close: (code) => state.closed.push(code),
      };
      return connection;
    },
    restart: () => {
      for (const handlers of state.sockets.splice(0)) handlers.onClose(1012);
    },
    head: () => Promise.resolve(0),
    items: () => Promise.resolve({}),
    seed: () => Promise.resolve(),
    compactLog: () => undefined,
    dispose: () => Promise.resolve(),
  };
  return { server, state };
}

function client() {
  const events: string[] = [];
  const handlers: SocketHandlers = {
    onOpen: () => events.push('open'),
    onMessage: (data) => events.push(`message ${String(data)}`),
    onClose: (code) => events.push(`close ${code}`),
  };
  return { events, handlers };
}

let network: Network;
let state: ReturnType<typeof fakeServer>['state'];

beforeEach(() => {
  installClock();
  const fake = fakeServer();
  state = fake.state;
  network = new SimNetwork(fake.server, seededRandom(7));
});

afterEach(() => uninstallClock());

describe('HTTP', () => {
  it('delivers a request and its response after a delay', async () => {
    const link = network.link('user-1');
    const response = link.fetch('http://surface.test/x', {});
    await advance(100);
    await expect(response.then((r) => r.text())).resolves.toBe('ok');
    expect(state.requests).toBe(1);
  });

  it('loses a request before the server sees it', async () => {
    network.faults = { dropRequest: 1, dropResponse: 0, hangResponse: 0, maxDelayMs: 5 };
    const failed = network
      .link('user-1')
      .fetch('http://surface.test/x', {})
      .catch((e: unknown) => e);
    await advance(100);
    expect(await failed).toBeInstanceOf(TypeError);
    expect(state.requests).toBe(0);
  });

  it('loses a response after the server ran the request', async () => {
    network.faults = { dropRequest: 0, dropResponse: 1, hangResponse: 0, maxDelayMs: 5 };
    const failed = network
      .link('user-1')
      .fetch('http://surface.test/x', {})
      .catch((e: unknown) => e);
    await advance(100);
    expect(await failed).toBeInstanceOf(TypeError);
    expect(state.requests).toBe(1);
  });

  it('rejects at once when aborted, but the request still reaches the server (E3)', async () => {
    const controller = new AbortController();
    const failed = network
      .link('user-1')
      .fetch('http://surface.test/x', { signal: controller.signal })
      .catch((e: unknown) => e);
    controller.abort();
    await advance(0);
    expect(await failed).toMatchObject({ name: 'AbortError' });
    expect(state.requests).toBe(0);
    await advance(100);
    expect(state.requests).toBe(1);
  });

  it('delivers a crashed tab’s last request, and its answer to no one (E4)', async () => {
    const link = network.link('user-1');
    let answered = false;
    void link.fetch('http://surface.test/x', {}).then(
      () => (answered = true),
      () => (answered = true),
    );
    link.kill();
    await advance(100);
    expect(state.requests).toBe(1);
    expect(answered).toBe(false);
  });

  it('counts a request as in flight until the server has handled it, even from a crashed tab', async () => {
    const link = network.link('user-1');
    void link.fetch('http://surface.test/x', {}).catch(() => undefined);
    link.kill();
    expect(network.requestsInFlight).toBe(1);
    await advance(100);
    expect([state.requests, network.requestsInFlight]).toEqual([1, 0]);
  });

  it('stops counting a lost request, and never counts a hanging response', async () => {
    network.faults = { dropRequest: 1, dropResponse: 0, hangResponse: 0, maxDelayMs: 5 };
    void network
      .link('user-1')
      .fetch('http://surface.test/x', {})
      .catch(() => undefined);
    await advance(100);
    expect(network.requestsInFlight).toBe(0);
    network.faults = { dropRequest: 0, dropResponse: 0, hangResponse: 1, maxDelayMs: 5 };
    void network.link('user-1').fetch('http://surface.test/x', {});
    await advance(100);
    expect([state.requests, network.requestsInFlight]).toEqual([1, 0]);
  });

  it('can leave a response hanging until the client gives up', async () => {
    network.faults = { dropRequest: 0, dropResponse: 0, hangResponse: 1, maxDelayMs: 5 };
    const controller = new AbortController();
    let outcome = 'pending';
    void network
      .link('user-1')
      .fetch('http://surface.test/x', { signal: controller.signal })
      .then(
        () => (outcome = 'answered'),
        (e: unknown) => (outcome = e instanceof DOMException ? e.name : 'failed'),
      );
    await advance(60_000);
    expect([state.requests, outcome]).toEqual([1, 'pending']);
    controller.abort();
    await advance(0);
    expect(outcome).toBe('AbortError');
  });

  it('loses the answer to a request the server ran before it restarted', async () => {
    network.faults = { dropRequest: 0, dropResponse: 0, hangResponse: 0, maxDelayMs: 50 };
    const failed = network
      .link('user-1')
      .fetch('http://surface.test/x', {})
      .catch((e: unknown) => e);
    for (let i = 0; state.requests === 0 && i < 100; i += 1) await advance(1);
    network.serverDown();
    network.serverUpAgain();
    await advance(100);
    expect(await failed).toBeInstanceOf(TypeError);
  });

  it('fails while offline, and fires `online` when back', async () => {
    const link = network.link('user-1');
    let online = 0;
    link.onlineSource.subscribe(() => (online += 1));
    link.setOnline(false);
    const failed = link.fetch('http://surface.test/x', {}).catch((e: unknown) => e);
    await advance(100);
    expect(await failed).toBeInstanceOf(TypeError);
    link.setOnline(true);
    await advance(1);
    expect(online).toBe(1);
  });
});

describe('WebSocket', () => {
  it('keeps the order of messages in each direction, whatever their delays', async () => {
    network.faults = { dropRequest: 0, dropResponse: 0, hangResponse: 0, maxDelayMs: 3_000 };
    const { events, handlers } = client();
    const socket = network.link('user-1').socket('ws://surface.test/sync/ws', handlers);
    await advance(10_000);
    for (let i = 0; i < 20; i += 1) socket.send(`up ${i}`);
    for (let i = 0; i < 20; i += 1) state.sockets[0]?.onMessage(`down ${i}`);
    await advance(100_000);
    expect(state.received).toEqual(Array.from({ length: 20 }, (_, i) => `up ${i}`));
    expect(events).toEqual(['open', ...Array.from({ length: 20 }, (_, i) => `message down ${i}`)]);
  });

  it('closes both sides with 1006 when the connection drops, losing what was in flight', async () => {
    const { events, handlers } = client();
    const link = network.link('user-1');
    const socket = link.socket('ws://surface.test/sync/ws', handlers);
    await advance(100);
    socket.send('lost');
    link.disconnect();
    await advance(100);
    expect(state.received).toEqual([]);
    expect(state.closed).toEqual([1006]);
    expect(events).toEqual(['open', 'close 1006']);
  });

  it('tells the client 1012 when the server restarts', async () => {
    const { events, handlers } = client();
    network.link('user-1').socket('ws://surface.test/sync/ws', handlers);
    await advance(100);
    network.serverDown();
    await advance(100);
    expect(events).toEqual(['open', 'close 1012']);
  });

  it('cannot open while the server is down', async () => {
    network.serverDown();
    const { events, handlers } = client();
    network.link('user-1').socket('ws://surface.test/sync/ws', handlers);
    await advance(100);
    expect(events).toEqual(['close 1006']);
    expect(state.sockets).toEqual([]);
  });

  it('delivers nothing to a crashed tab, and the server sees its socket close', async () => {
    const { events, handlers } = client();
    const link = network.link('user-1');
    network.link('user-1').socket('ws://surface.test/sync/ws', client().handlers);
    link.socket('ws://surface.test/sync/ws', handlers);
    await advance(100);
    link.kill();
    state.sockets[1]?.onMessage('late');
    await advance(100);
    expect(events).toEqual(['open']);
    expect(state.closed).toEqual([1006]);
  });
});
