/**
 * The mutation queue against the fake hub (SPEC-002 §3.3, §3.6;
 * sync-protocol.md §4.4, §5.1): confirmation, offline queueing, batching,
 * retries, exactly-once resends, `CLIENT_OUTDATED` and `SEQ_GAP`.
 */
import { describe, expect, it, vi } from 'vitest';
import { MAX_MUTATION_BATCH_BYTES, MUTATE_PATH } from '@surface/sync-protocol';
import type { SocketFactory } from '../src/socket.js';
import { InvalidInputError, REQUEST_TIMEOUT_MS } from '../src/queue.js';
import { MemoryStorage } from '../src/storage/memory.js';
import type { QueueWrite } from '../src/storage/types.js';
import { FakeHub } from './support/hub.js';
import {
  CLIENT_ID,
  clientItems,
  eventually,
  idle,
  keptMemoryStorage,
  liveStore,
  serverItems,
  until,
} from './support/live.js';
import { DebugItem, id } from './support/models.js';
import { debugCreate, debugHide, debugRename, debugTouch } from './support/ops.js';

function seededHub(): FakeHub {
  const hub = new FakeHub();
  for (const n of [1, 2, 3]) hub.upsert(n);
  return hub;
}

/** A socket that only connects while `up`; a dial while down fails like a network error. */
function switchable(hub: FakeHub) {
  const network = { up: false };
  const socket: SocketFactory = (url, handlers) => {
    if (!network.up) throw new Error('offline');
    return hub.socket(url, handlers);
  };
  return { network, socket };
}

const seqs = (hub: FakeHub) => hub.mutateRequests.map((r) => r.mutations.map((m) => m.seq));

describe('confirming a mutation', () => {
  it('is confirmed once the replica includes its commit, and the overlay is then empty', async () => {
    const hub = seededHub();
    const { store } = liveStore(hub);
    await store.start();
    await until(() => store.connection === 'online');
    const outcome = store.dispatch(debugTouch, { id: id(1) });
    expect(store.pending).toMatchObject([{ seq: 1, op: 'debug.touch', state: 'queued' }]);

    expect(await outcome).toEqual({ status: 'confirmed' });
    expect(store.pending).toEqual([]);
    expect(hub.executed('debug.touch')).toBe(1);
    expect(store.pool.get(DebugItem, id(1))?.counter).toBe(2);
    expect(clientItems(store)).toEqual(serverItems(hub));
    await store.close();
  });

  it('is confirmed by an ack that arrives before the HTTP response, and not applied twice', async () => {
    const hub = seededHub();
    const { store } = liveStore(hub);
    await store.start();
    await until(() => store.connection === 'online');
    hub.holdResponses = true;
    const outcome = store.dispatch(debugTouch, { id: id(1) });
    expect(await outcome).toEqual({ status: 'confirmed' }); // the delta and its ack did it
    expect(store.pool.get(DebugItem, id(1))?.counter).toBe(2);
    expect(hub.executed()).toBe(1);

    hub.holdResponses = false;
    hub.release();
    void store.dispatch(debugTouch, { id: id(1) });
    await until(() => store.pending.length === 0);
    expect(store.pool.get(DebugItem, id(1))?.counter).toBe(3);
    expect(hub.executed('debug.touch')).toBe(2);
    await store.close();
  });

  it('is confirmed by an ack alone when it changed nothing this client can see', async () => {
    const hub = seededHub();
    const { store } = liveStore(hub);
    await store.start();
    await until(() => store.connection === 'online');
    const before = store.position?.lastSyncId;
    expect(await store.dispatch(debugHide, { note: 'x' })).toEqual({ status: 'confirmed' });
    expect(store.pending).toEqual([]);
    expect(store.position?.lastSyncId).toBe(before);
    await store.close();
  });
});

describe('offline (SPEC-002 §3.6)', () => {
  it('queues while disconnected and sends once connected', async () => {
    const hub = seededHub();
    const { network, socket } = switchable(hub);
    const storage = keptMemoryStorage();
    const { store, timers } = liveStore(hub, {
      connection: { socket },
      connectStorage: storage.connect,
    });
    await store.start();
    expect(store.connection).toBe('offline');
    void store.dispatch(debugRename, { id: id(1), title: 'Offline edit' });
    void store.dispatch(debugTouch, { id: id(2) });
    await eventually(async () => (await storage.persisted()) === 2);
    expect(hub.mutateRequests).toEqual([]);
    expect(store.pool.get(DebugItem, id(1))?.title).toBe('Offline edit');

    network.up = true;
    timers.runNext();
    await until(() => store.pending.length === 0);
    expect(seqs(hub)).toEqual([[1, 2]]);
    expect(clientItems(store)).toEqual(serverItems(hub));
    await store.close();
  });

  it('sends one batch at a time, in seq order, at most 100 mutations each', async () => {
    const hub = seededHub();
    const { network, socket } = switchable(hub);
    const storage = keptMemoryStorage();
    const { store, timers } = liveStore(hub, {
      connection: { socket },
      connectStorage: storage.connect,
    });
    await store.start();
    for (let i = 0; i < 250; i += 1) void store.dispatch(debugTouch, { id: id(1 + (i % 3)) });
    await eventually(async () => (await storage.persisted()) === 250);

    hub.holdResponses = true;
    network.up = true;
    timers.runNext();
    await eventually(() => hub.mutateRequests.length === 1);
    void store.dispatch(debugTouch, { id: id(1) }); // while a batch is in flight
    await eventually(() => storage.has(251));
    expect(hub.mutateRequests).toHaveLength(1);
    hub.holdResponses = false;
    hub.release();

    await until(() => store.pending.length === 0);
    expect(seqs(hub).map((batch) => [batch[0], batch.length])).toEqual([
      [1, 100],
      [101, 100],
      [201, 51],
    ]);
    expect(clientItems(store)).toEqual(serverItems(hub));
    await store.close();
  });
});

describe('restarting a store', () => {
  it('starts a new queue on memory storage, so a new mutation is never taken for a resend (review B1)', async () => {
    const hub = seededHub();
    const { store } = liveStore(hub); // memory storage: nothing survives the restart
    await store.start();
    await until(() => store.connection === 'online');
    expect(await store.dispatch(debugTouch, { id: id(1) })).toEqual({ status: 'confirmed' });
    const first = store.clientId;
    await store.close();

    await store.start();
    await until(() => store.connection === 'online');
    expect(store.clientId).not.toBe(first);
    expect(await store.dispatch(debugRename, { id: id(2), title: 'Kept' })).toEqual({
      status: 'confirmed',
    });
    expect(hub.executed()).toBe(2);
    expect(serverItems(hub)[id(2)]?.title).toBe('Kept');
    expect(clientItems(store)).toEqual(serverItems(hub));
    await store.close();
  });
});

describe('SEQ_GAP edge cases (review m4)', () => {
  it('renumbers a committed but unconfirmed mutation with the rest, so seqs never collide', async () => {
    const hub = seededHub();
    const storage = keptMemoryStorage();
    const { store } = liveStore(hub, { connectStorage: storage.connect });
    await store.start();
    await until(() => store.connection === 'online');
    hub.last.paused = true; // committed, but not yet in the replica
    const first = store.dispatch(debugTouch, { id: id(1) });
    await until(() => store.pending[0]?.state === 'committed');

    hub.clients.delete(CLIENT_ID); // a database restore lost seq 1 and its effect
    const second = store.dispatch(debugTouch, { id: id(2) });
    await eventually(() => hub.clients.get(CLIENT_ID)?.lastSeq === 2);
    expect(hub.mutateRequests.at(-1)?.mutations.map((m) => [m.seq, m.op, m.input])).toEqual([
      [1, 'debug.touch', { id: id(1) }],
      [2, 'debug.touch', { id: id(2) }],
    ]);
    hub.last.paused = false;
    hub.last.deliver();
    expect(await Promise.all([first, second])).toEqual([
      { status: 'confirmed' },
      { status: 'confirmed' },
    ]);
    await store.close();
    expect(await storage.persisted()).toBe(0);
  });

  it('backs off when a SEQ_GAP answer leaves nothing to renumber', async () => {
    const hub = seededHub();
    let mutateCalls = 0;
    const fetch: typeof hub.fetch = (url, init) => {
      if (!url.endsWith(MUTATE_PATH)) return hub.fetch(url, init);
      mutateCalls += 1;
      // A misbehaving server: claims a gap where there is none.
      const body = {
        ok: false,
        error: { code: 'SEQ_GAP', message: 'Gap', correlationId: 'c', lastSeq: 0 },
      };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 400 }));
    };
    const { store, timers } = liveStore(hub, { fetch });
    await store.start();
    await until(() => store.connection === 'online');
    void store.dispatch(debugTouch, { id: id(1) });
    await eventually(() => mutateCalls === 1);
    await idle();
    expect(mutateCalls).toBe(1);
    expect(timers.pending).toContain(500);
    await store.close();
  });
});

describe('persistence', () => {
  it('persists a mutation before it is first sent, even when a batch ends meanwhile', async () => {
    const hub = seededHub();
    let gated = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    class GatedStorage extends MemoryStorage {
      override async writeQueue(write: QueueWrite): Promise<void> {
        if (gated && write.put?.length) await gate;
        return super.writeQueue(write);
      }
    }
    const { store } = liveStore(hub, {
      connectStorage: (_name, models) => Promise.resolve(new GatedStorage(models)),
    });
    await store.start();
    await until(() => store.connection === 'online');
    hub.holdResponses = true;
    void store.dispatch(debugTouch, { id: id(1) });
    await eventually(() => hub.mutateRequests.length === 1);

    gated = true; // the next write hangs
    const second = store.dispatch(debugTouch, { id: id(2) });
    hub.holdResponses = false;
    hub.release(); // the first batch ends, and the queue looks for the next one
    await until(() => store.pending.length === 1);
    await idle();
    expect(hub.mutateRequests).toHaveLength(1); // seq 2 is not persisted yet: not sent

    release();
    expect(await second).toEqual({ status: 'confirmed' });
    expect(hub.mutateRequests.map((r) => r.mutations.map((m) => m.seq))).toEqual([[1], [2]]);
    await store.close();
  });
});

describe('failures and resends', () => {
  it('retries a failed request with backoff', async () => {
    const hub = seededHub();
    const { store, timers } = liveStore(hub);
    await store.start();
    await until(() => store.connection === 'online');
    hub.failRequests = 2;
    const outcome = store.dispatch(debugTouch, { id: id(1) });
    await eventually(() => timers.pending.includes(500));
    expect(timers.runNext()).toBe(500);
    await eventually(() => timers.pending.includes(1000));
    expect(timers.runNext()).toBe(1000);
    expect(await outcome).toEqual({ status: 'confirmed' });
    expect(hub.executed()).toBe(1);
    await store.close();
  });

  it('resends after a lost response, and the server applies it once (E3)', async () => {
    const hub = seededHub();
    const { store, timers } = liveStore(hub);
    await store.start();
    await until(() => store.connection === 'online');
    hub.last.paused = true; // the delta is held too, so only the resend can confirm it
    hub.loseResponses = 1;
    const outcome = store.dispatch(debugTouch, { id: id(1) });
    await eventually(() => hub.executed() === 1 && timers.pending.includes(500));
    timers.runNext();
    hub.last.paused = false;
    hub.last.deliver();
    expect(await outcome).toEqual({ status: 'confirmed' });
    expect(hub.executed()).toBe(1);
    expect(hub.clients.get(CLIENT_ID)?.lastSeq).toBe(1);
    expect(store.pool.get(DebugItem, id(1))?.counter).toBe(2);
    await store.close();
  });

  it('never sends a batch with a gap in its seqs, even when a later mutation was confirmed first (PLAN-002 S9)', async () => {
    // Found by the sync simulation: a rejection lost with its response, a later
    // mutation confirmed by its ack, then a new one. sync-protocol.md §5.1: the
    // seqs of a batch are consecutive, so `[1, 3]` is refused by the server.
    const hub = seededHub();
    const batches: number[][] = [];
    const { store, timers } = liveStore(hub, {
      fetch: (url, init) => {
        if (url.endsWith(MUTATE_PATH) && typeof init.body === 'string') {
          const body: unknown = JSON.parse(init.body);
          const mutations: unknown =
            typeof body === 'object' && body !== null ? Reflect.get(body, 'mutations') : [];
          if (Array.isArray(mutations)) {
            batches.push(mutations.map((m: unknown) => Number(Reflect.get(Object(m), 'seq'))));
          }
        }
        return hub.fetch(url, init);
      },
    });
    await store.start();
    await until(() => store.connection === 'online');
    hub.loseResponses = 2;
    const exists = store.dispatch(debugCreate, { id: id(1), title: 'Taken' }); // seq 1: CONFLICT
    await eventually(() => hub.executed() === 1 && timers.pending.includes(500));
    const touched = store.dispatch(debugTouch, { id: id(2) }); // seq 2
    await idle(); // saved, so the resend carries it
    timers.runNext(); // resend [1, 2]: the answer is lost again, but seq 2's ack arrives
    expect(await touched).toEqual({ status: 'confirmed' });
    const later = store.dispatch(debugTouch, { id: id(3) }); // seq 3
    const settled = { exists: false, later: false };
    void exists.then(() => (settled.exists = true));
    void later.then(() => (settled.later = true));
    // Checked after every send, so a gap fails here instead of timing out on
    // a server that keeps refusing the batch.
    const consecutive = () => {
      for (const batch of batches) {
        expect(batch, JSON.stringify(batches)).toEqual(batch.map((_, i) => (batch[0] ?? 0) + i));
      }
    };
    for (let i = 0; i < 10 && !(settled.exists && settled.later); i += 1) {
      timers.runNext();
      await idle();
      consecutive();
    }

    expect(settled).toEqual({ exists: true, later: true });
    expect(await exists).toMatchObject({ status: 'rejected', error: { code: 'CONFLICT' } });
    expect(await later).toEqual({ status: 'confirmed' });
    expect(clientItems(store)).toEqual(serverItems(hub));
    await store.close();
  });

  it('gives up on a request that hangs, and sends it again (review M3)', async () => {
    const hub = seededHub();
    const { store, timers } = liveStore(hub);
    await store.start();
    await until(() => store.connection === 'online');
    hub.last.paused = true; // no delta or ack either: only the resend can confirm it
    hub.holdResponses = true;
    const outcome = store.dispatch(debugTouch, { id: id(1) });
    await eventually(() => hub.executed() === 1);
    hub.holdResponses = false;

    timers.advance(REQUEST_TIMEOUT_MS);
    await eventually(() => hub.aborted === 1 && timers.pending.includes(500));
    timers.runNext();
    await eventually(() => hub.mutateRequests.length === 2);
    hub.last.paused = false;
    hub.last.deliver();
    expect(await outcome).toEqual({ status: 'confirmed' });
    expect(hub.executed()).toBe(1);
    await store.close();
  });

  it('drops the request in flight when the connection drops, and resends at once when it is back (review M3)', async () => {
    const hub = seededHub();
    const { store, timers } = liveStore(hub);
    await store.start();
    await until(() => store.connection === 'online');
    hub.last.paused = true;
    hub.holdResponses = true;
    hub.failRequests = 3; // so the queue's next retry waits 4 s, far beyond the socket's 0.5 s
    const outcome = store.dispatch(debugTouch, { id: id(1) });
    while (hub.executed() === 0) {
      await eventually(() => hub.executed() > 0 || timers.pending.some((ms) => ms < 30_000));
      if (hub.executed() === 0) timers.runNext();
    }
    hub.holdResponses = false;

    hub.last.close(1006);
    await eventually(() => hub.aborted === 1 && timers.pending.includes(4000));
    expect(timers.runNext()).toBe(500); // the socket's reconnect, not the queue's retry
    await until(() => store.connection === 'online');
    await eventually(() => hub.mutateRequests.length === 2);
    expect(timers.pending.filter((ms) => ms < 30_000)).toEqual([]); // no retry left waiting
    expect(await outcome).toEqual({ status: 'confirmed' });
    expect(hub.executed()).toBe(1);
    await store.close();
  });

  it('confirms a change it cannot see by the ack resent on catch-up, when the live ack was lost (review m6)', async () => {
    const hub = seededHub();
    const { store, timers } = liveStore(hub);
    await store.start();
    await until(() => store.connection === 'online');
    hub.last.paused = true; // the live ack never arrives
    const outcome = store.dispatch(debugHide, { note: 'x' });
    await until(() => store.pending[0]?.state === 'committed');

    hub.last.close(1006);
    timers.runNext();
    expect(await outcome).toEqual({ status: 'confirmed' });
    expect(hub.executed()).toBe(1);
    await store.close();
  });

  it('stops and asks for a reload when the server runs a newer schema (CLIENT_OUTDATED)', async () => {
    const hub = seededHub();
    const onOutdated = vi.fn();
    const { store, timers } = liveStore(hub, { onOutdated });
    await store.start();
    await until(() => store.connection === 'online');
    hub.schemaHash = 'f'.repeat(64);
    void store.dispatch(debugTouch, { id: id(1) });
    await until(() => store.status === 'outdated');
    expect(onOutdated).toHaveBeenCalledOnce();
    expect(store.connection).toBe('disconnected');
    expect(timers.pending).toEqual([]);
    expect(() => store.dispatch(debugTouch, { id: id(1) })).toThrow(/Reload the page/);
    await store.close();
  });

  it('renumbers what the server never got after it lost its record of this client (SEQ_GAP)', async () => {
    const hub = seededHub();
    const storage = keptMemoryStorage();
    const { store } = liveStore(hub, { connectStorage: storage.connect });
    await store.start();
    await until(() => store.connection === 'online');
    await store.dispatch(debugTouch, { id: id(1) });
    await store.dispatch(debugTouch, { id: id(1) });
    hub.clients.delete(CLIENT_ID); // e.g. the server database was restored

    expect(await store.dispatch(debugTouch, { id: id(1) })).toEqual({ status: 'confirmed' });
    expect(hub.clients.get(CLIENT_ID)?.lastSeq).toBe(1);
    expect(store.pending).toEqual([]);
    expect(store.pool.get(DebugItem, id(1))?.counter).toBe(4);
    expect(clientItems(store)).toEqual(serverItems(hub));
    void store.dispatch(debugTouch, { id: id(1) });
    await until(() => store.pending.length === 0);
    expect(hub.clients.get(CLIENT_ID)?.lastSeq).toBe(2);
    await store.close();
    expect(await storage.persisted()).toBe(0); // no record left under its old seq
  });
});

describe('size limits and refused requests (review M2)', () => {
  const big = (bytes: number) => '漢'.repeat(Math.ceil(bytes / 3)); // 3 bytes each in UTF-8
  const newId = (n: number) => `0190f4c4-0000-7000-8000-${String(n).padStart(12, '0')}`;

  it('refuses a change too large to ever send, queueing nothing', async () => {
    const { store } = liveStore(seededHub());
    await store.start();
    expect(() => store.dispatch(debugCreate, { id: newId(1), title: big(1_000_000) })).toThrow(
      /Invalid input for debug.create: too large to save \(1\.0 MB; the limit is 0\.9 MB\)/,
    );
    expect(store.pending).toEqual([]);
    await store.close();
  });

  it('measures batches in UTF-8 bytes, so every request fits the body limit', async () => {
    const hub = seededHub();
    const { network, socket } = switchable(hub);
    const storage = keptMemoryStorage();
    const { store, timers } = liveStore(hub, {
      connection: { socket },
      connectStorage: storage.connect,
    });
    await store.start();
    for (let n = 1; n <= 100; n += 1)
      void store.dispatch(debugCreate, { id: newId(n), title: big(12_000) });
    await eventually(async () => (await storage.persisted()) === 100);
    network.up = true;
    timers.runNext();
    await until(() => store.pending.length === 0);
    expect(hub.bodySizes.length).toBeGreaterThan(1);
    expect(Math.max(...hub.bodySizes)).toBeLessThanOrEqual(MAX_MUTATION_BATCH_BYTES);
    expect(store.rejections).toEqual([]);
    expect(clientItems(store)).toEqual(serverItems(hub));
    await store.close();
  });

  it('splits a batch the server finds too large, and rejects a change that alone is', async () => {
    const hub = seededHub();
    hub.maxBodyBytes = 20_000; // a stricter server than this client assumes
    const { network, socket } = switchable(hub);
    const storage = keptMemoryStorage();
    const { store, timers } = liveStore(hub, {
      connection: { socket },
      connectStorage: storage.connect,
    });
    await store.start();
    const outcomes = [
      store.dispatch(debugCreate, { id: newId(1), title: big(8_000) }),
      store.dispatch(debugCreate, { id: newId(2), title: big(8_000) }),
      store.dispatch(debugCreate, { id: newId(3), title: big(30_000) }),
      store.dispatch(debugCreate, { id: newId(4), title: 'Small' }),
    ];
    await eventually(async () => (await storage.persisted()) === 4);
    network.up = true;
    timers.runNext();
    const results = await Promise.all(outcomes);
    expect(results.map((r) => r.status)).toEqual([
      'confirmed',
      'confirmed',
      'rejected',
      'confirmed',
    ]);
    expect(results[2]).toEqual({
      status: 'rejected',
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'This change is too large to save. Split it into smaller changes.',
      },
    });
    expect(store.pool.get(DebugItem, newId(3))).toBeUndefined();
    expect(clientItems(store)).toEqual(serverItems(hub));
    await store.close();
  });

  it('rejects the change behind a batch the server refuses as invalid, and sends the rest', async () => {
    const hub = seededHub();
    hub.invalidOps.add('debug.hide');
    const { network, socket } = switchable(hub);
    const storage = keptMemoryStorage();
    const { store, timers } = liveStore(hub, {
      connection: { socket },
      connectStorage: storage.connect,
    });
    await store.start();
    const outcomes = [
      store.dispatch(debugTouch, { id: id(1) }),
      store.dispatch(debugHide, { note: 'refused' }),
      store.dispatch(debugTouch, { id: id(2) }),
    ];
    await eventually(async () => (await storage.persisted()) === 3);
    network.up = true;
    timers.runNext();
    const results = await Promise.all(outcomes);
    expect(results).toEqual([
      { status: 'confirmed' },
      {
        status: 'rejected',
        error: { code: 'INVALID_INPUT', message: 'This change is not valid on the server.' },
      },
      { status: 'confirmed' },
    ]);
    expect(hub.executed()).toBe(2);
    await store.close();
  });
});

describe('dispatch', () => {
  it('sends the input as it was at dispatch, whatever the caller does with it after', async () => {
    const hub = seededHub();
    const { store } = liveStore(hub);
    await store.start();
    await until(() => store.connection === 'online');
    const input = { id: id(1), title: 'As dispatched' };
    const outcome = store.dispatch(debugRename, input);
    input.title = 'Changed afterwards';
    expect(await outcome).toEqual({ status: 'confirmed' });
    expect(serverItems(hub)[id(1)]?.title).toBe('As dispatched');
    await store.close();
  });

  it('rejects input that does not match the operation, queueing nothing', async () => {
    const hub = seededHub();
    const { store } = liveStore(hub);
    await store.start();
    expect(() => store.dispatch(debugRename, { id: id(1), title: '' })).toThrow(InvalidInputError);
    expect(() => store.dispatch(debugRename, { id: id(1), title: '' })).toThrow(
      /Invalid input for debug.rename: title:/,
    );
    expect(store.pending).toEqual([]);
    expect(store.pool.get(DebugItem, id(1))?.title).toBe('Item 1');
    await store.close();
  });

  it('refuses to dispatch before the store has started', () => {
    const { store } = liveStore(seededHub());
    expect(() => store.dispatch(debugTouch, { id: id(1) })).toThrow(/Wait for the workspace/);
  });
});
