/**
 * What the UI hooks and the sync inspector read (SPEC-002 §5.4, §7, SPEC-005
 * §8), from a real store against the in-process fake hub.
 */
import { SESSION_PATH } from '@surface/sync-protocol';
import { describe, expect, it } from 'vitest';
import type { SocketFactory } from '../src/socket.js';
import type { SyncStore } from '../src/store.js';
import {
  bootstrapOf,
  connectionOf,
  inspect,
  pendingCountOf,
  storageUsage,
  storageWarningOf,
} from '../src/inspect.js';
import { observe } from '../src/observe.js';
import { RECENT_PACKETS } from '../src/store.js';
import { FakeHub } from './support/hub.js';
import type { ManualTimers } from './support/timers.js';
import { CLIENT_ID, liveStore, until } from './support/live.js';
import { id } from './support/models.js';
import { debugTouch } from './support/ops.js';

/** A clock the test moves by hand (epoch ms). */
function manualClock(start = 1_700_000_000_000) {
  let now = start;
  return { clock: () => now, advance: (ms: number) => (now += ms) };
}

function seededHub(): FakeHub {
  const hub = new FakeHub();
  for (const n of [1, 2, 3]) hub.upsert(n);
  return hub;
}

const refusing: SocketFactory = () => {
  throw new Error('refused');
};

describe('connection (offline, reconnecting and live-updates banners)', () => {
  it('reports the state, when it began, and how long it has been reconnecting', async () => {
    const time = manualClock();
    const hub = seededHub();
    const { store, timers } = liveStore(hub, { clock: time.clock });
    await store.start();
    await until(() => store.connection === 'online');
    const opened = time.clock();
    time.advance(40);
    expect(connectionOf(store)).toEqual({
      state: 'online',
      since: opened,
      reconnectingSince: undefined,
      liveUpdatesUnavailable: false,
    });
    hub.last.close(1006);
    expect(connectionOf(store)).toMatchObject({
      state: 'offline',
      since: opened + 40,
      reconnectingSince: opened + 40,
    });
    time.advance(700);
    timers.runNext();
    expect(connectionOf(store)).toMatchObject({
      since: opened + 740,
      reconnectingSince: opened + 40,
    });
    await store.close();
  });
});

describe('live updates unavailable (sync-protocol.md §4.3)', () => {
  /** Start, then fail three attempts in a row, as against a proxy that refuses upgrades. */
  async function failThree(store: SyncStore, timers: ManualTimers): Promise<void> {
    await store.start();
    timers.runNext();
    timers.runNext();
  }

  it('shows when the server answers plain HTTP but the upgrade still fails', async () => {
    const hub = seededHub();
    const { store, timers } = liveStore(hub, { connection: { socket: refusing } });
    await failThree(store, timers);
    // The probe answers, the store dials at once, and that attempt fails too.
    await until(() => connectionOf(store).liveUpdatesUnavailable);
    expect(hub.sessionRequests).toBe(1);
    await store.close();
    // A signed-out session still proves the server is up.
    const signedOut = seededHub();
    signedOut.sessionStatus = 401;
    const second = liveStore(signedOut, { connection: { socket: refusing } });
    await failThree(second.store, second.timers);
    await until(() => connectionOf(second.store).liveUpdatesUnavailable);
    await second.store.close();
  });

  it('does not show while the server is down or starting: a restart is not a proxy', async () => {
    for (const answer of [
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => Promise.resolve(new Response('', { status: 503 })),
      () => Promise.resolve(new Response('', { status: 502 })),
    ]) {
      const hub = seededHub();
      let probes = 0;
      const { store, timers } = liveStore(hub, {
        connection: { socket: refusing },
        fetch: (url, init) => {
          if (!url.endsWith(SESSION_PATH)) return hub.fetch(url, init);
          probes += 1;
          return answer();
        },
      });
      await failThree(store, timers);
      await until(() => probes === 1);
      timers.runNext();
      await until(() => probes === 2);
      expect(connectionOf(store).liveUpdatesUnavailable).toBe(false);
      await store.close();
    }
  });
});

describe('pending changes and the round trip (server lag)', () => {
  it('counts unconfirmed mutations, and times the latest from its send to its confirmation', async () => {
    const time = manualClock();
    const hub = seededHub();
    const { store } = liveStore(hub, { clock: time.clock });
    await store.start();
    await until(() => store.connection === 'online');
    expect(inspect(store).roundTrip).toBeUndefined();
    // Held back so that one message confirms both: the latest is the one timed.
    hub.last.paused = true;
    void store.dispatch(debugTouch, { id: id(1) });
    void store.dispatch(debugTouch, { id: id(2) });
    expect(pendingCountOf(store)).toBe(2);
    // Committed on the server, not yet in the replica: still pending.
    await until(() => store.pending.every((p) => p.state === 'committed'), 2000);
    expect(pendingCountOf(store)).toBe(2);
    time.advance(120);
    hub.last.paused = false;
    hub.last.deliver();
    await until(() => pendingCountOf(store) === 0, 2000);
    expect(inspect(store).roundTrip).toEqual({ op: debugTouch.name, seq: 2, ms: 120 });
    await store.close();
  });
});

describe('server lag leaves out time spent queued offline', () => {
  it('times from when the change was last sent, not from when it was made', async () => {
    const time = manualClock();
    const hub = seededHub();
    const { store, timers } = liveStore(hub, { clock: time.clock });
    await store.start();
    await until(() => store.connection === 'online');
    hub.last.close(1006);
    void store.dispatch(debugTouch, { id: id(1) });
    time.advance(3_600_000); // an hour offline
    timers.runNext();
    hub.last.paused = true; // the new connection: its confirmation waits for the test
    await until(() => store.pending.every((p) => p.state === 'committed'), 2000);
    time.advance(30);
    hub.last.paused = false;
    hub.last.deliver();
    await until(() => pendingCountOf(store) === 0, 2000);
    expect(inspect(store).roundTrip).toEqual({ op: debugTouch.name, seq: 1, ms: 30 });
    await store.close();
  });
});

describe('the inspector snapshot', () => {
  it('shows the position, client, rows per model and storage', async () => {
    const { store } = liveStore(seededHub());
    await store.start();
    const snapshot = inspect(store);
    expect(snapshot).toMatchObject({
      status: 'ready',
      error: undefined,
      clientId: CLIENT_ID,
      lastSyncId: 103,
      pending: [],
      packets: [],
      rejections: [],
      rows: [
        { model: 'DebugItem', count: 3 },
        { model: 'Board', count: 0 },
        { model: 'Card', count: 0 },
      ],
    });
    // Memory storage in these tests: nothing survives a reload.
    expect(snapshot.persistent).toBe(false);
    expect(storageWarningOf(store)).toBe(snapshot.storageWarning);
    await store.close();
  });

  it('lists applied packets newest first, without their rows, and keeps only the last 50', async () => {
    const time = manualClock();
    const hub = seededHub();
    const { store } = liveStore(hub, { clock: time.clock });
    await store.start();
    await until(() => store.connection === 'online');
    // Both in one message: its packets are listed newest first too.
    hub.last.paused = true;
    hub.upsert(4, { title: 'Secret plans' });
    hub.archive(4);
    hub.last.paused = false;
    hub.last.deliver();
    await until(() => store.position?.lastSyncId === 105);
    expect(inspect(store).packets).toEqual([
      { id: 105, action: 'A', model: 'DebugItem', rowId: id(4), appliedAt: time.clock() },
      { id: 104, action: 'I', model: 'DebugItem', rowId: id(4), appliedAt: time.clock() },
    ]);
    expect(JSON.stringify(inspect(store))).not.toContain('Secret plans');
    for (let n = 0; n < 60; n += 1) hub.upsert(1, { counter: n });
    await until(() => store.position?.lastSyncId === 165);
    const { packets } = inspect(store);
    expect(packets).toHaveLength(RECENT_PACKETS);
    expect(packets.map((p) => p.id)).toEqual(
      Array.from({ length: RECENT_PACKETS }, (_, n) => 165 - n),
    );
    await store.close();
  });

  it('changes, through observe, when a packet arrives', async () => {
    const hub = seededHub();
    const { store } = liveStore(hub);
    await store.start();
    await until(() => store.connection === 'online');
    const source = observe(() => inspect(store));
    const heard: (number | undefined)[] = [];
    const leave = source.subscribe(() => heard.push(source.getSnapshot().lastSyncId));
    hub.upsert(2, { title: 'Renamed' });
    await until(() => heard.length > 0);
    expect(heard).toEqual([104]);
    leave();
    await store.close();
  });
});

describe('the start-up (progress bar and its failure screen)', () => {
  it('reports why a cold start failed', async () => {
    const { store } = liveStore(seededHub(), {
      fetch: () => Promise.resolve(new Response('', { status: 500 })),
    });
    await expect(store.start()).rejects.toThrow();
    const { status, progress, error } = bootstrapOf(store);
    expect({ status, progress }).toEqual({ status: 'failed', progress: undefined });
    expect(error).toEqual(expect.any(String));
  });
});

describe('storage usage (the IDB size)', () => {
  it('is what the browser estimates, or unknown when it cannot say', async () => {
    expect(await storageUsage(() => Promise.resolve({ usage: 4096 }))).toBe(4096);
    expect(await storageUsage(() => Promise.resolve({}))).toBeUndefined();
    expect(await storageUsage(() => Promise.reject(new Error('denied')))).toBeUndefined();
    // Node has a `navigator` but no StorageManager.
    expect(await storageUsage()).toBeUndefined();
  });
});
