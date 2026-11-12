/**
 * Delta apply over the live connection (SPEC-002 §3.4, E1, E2, E10), against
 * the in-process fake hub.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { ReplicaLocks } from '../src/locks.js';
import { FakeHub } from './support/hub.js';
import {
  CLIENT_ID,
  clientItems,
  eventually,
  liveStore,
  serverItems,
  until,
} from './support/live.js';
import { debugRow, id, USER_ID } from './support/models.js';
import { debugTouch } from './support/ops.js';
import { closePorts, connectViaRpc, uniqueName } from './support/storage.js';

afterAll(closePorts);

/**
 * Web Locks whose exclusive release can be held. `navigator.locks` releases a
 * task after the callback settles, so code after the lock runs later.
 */
function holdableLocks() {
  let gate: Promise<void> | undefined;
  let open: () => void = () => undefined;
  const locks: ReplicaLocks = {
    async request<T>(
      _name: string,
      options: { mode: string },
      task: (lock: unknown) => Promise<T>,
    ) {
      const result = await task({ name: _name });
      if (options.mode === 'exclusive' && gate) await gate;
      return result;
    },
  };
  return {
    locks,
    hold() {
      gate = new Promise<void>((resolve) => {
        open = () => {
          gate = undefined;
          resolve();
        };
      });
    },
    release: () => open(),
  };
}

/** A hub with rows 1–3 already in its log. */
function seededHub(): FakeHub {
  const hub = new FakeHub();
  for (const n of [1, 2, 3]) hub.upsert(n);
  return hub;
}

describe('connecting', () => {
  it('connects once ready, from the position it started at (§3.1 step 3)', async () => {
    const hub = seededHub();
    const { store } = liveStore(hub);
    await store.start();
    await until(() => store.connection === 'online');
    expect(hub.last).toMatchObject({
      since: hub.head,
      clientId: CLIENT_ID,
      schemaHash: store.schemaHash,
    });
    await store.close();
  });

  // SPEC-002 E14: the server checks it against the session, so a queue or replica
  // never reaches another user who signed in on the same browser.
  it('names its user on bootstrap, on every mutate request and on the socket', async () => {
    const hub = seededHub();
    const { store } = liveStore(hub);
    await store.start();
    await until(() => store.connection === 'online');
    expect(await store.dispatch(debugTouch, { id: id(1) })).toEqual({ status: 'confirmed' });
    await eventually(() => hub.users.mutate.length > 0);
    expect(hub.users).toEqual({ bootstrap: [USER_ID], mutate: [USER_ID], socket: [USER_ID] });
    await store.close();
  });

  it('closes the connection on close, and does not reconnect', async () => {
    const hub = seededHub();
    const { store, timers } = liveStore(hub);
    await store.start();
    await until(() => store.connection === 'online');
    await store.close();
    expect(hub.last.closedWith).toBe(1000);
    expect(store.connection).toBe('disconnected');
    expect(timers.pending).toEqual([]);
  });

  it('does not connect when closed while a cold start finishes (review S7 M1)', async () => {
    const hub = seededHub();
    const gate = holdableLocks();
    gate.hold();
    const { store } = liveStore(hub, { locks: gate.locks, connectStorage: connectViaRpc });
    const starting = store.start();
    await until(() => store.status === 'ready'); // bootstrapped, lock not yet released
    const closing = store.close();
    gate.release();
    await expect(starting).rejects.toMatchObject({ name: 'AbortError' });
    await closing;
    expect(store.connection).toBe('disconnected');
    expect(hub.connections).toHaveLength(0);
  });

  it('does not reconnect when closed while a resync finishes (review S7 M1)', async () => {
    const hub = seededHub();
    const gate = holdableLocks();
    const { store } = liveStore(hub, { locks: gate.locks, connectStorage: connectViaRpc });
    await store.start();
    await until(() => store.connection === 'online');
    gate.hold();
    const resyncing = store.resync();
    await until(() => store.status === 'bootstrapping');
    await until(() => store.status === 'ready'); // bootstrapped, lock not yet released
    const closing = store.close();
    gate.release();
    await expect(resyncing).rejects.toMatchObject({ name: 'AbortError' });
    await closing;
    expect(store.connection).toBe('disconnected');
    expect(hub.live).toHaveLength(0);
  });

  it('does nothing when started again while running (review S7 n4)', async () => {
    const hub = seededHub();
    const { store } = liveStore(hub, { connectStorage: connectViaRpc });
    expect(await store.start()).toBe('cold');
    await until(() => store.connection === 'online');
    const again = store.start();
    hub.upsert(1, { title: 'Arrived meanwhile' }); // its storage write queues behind `again`
    expect(await again).toBe('cold');
    expect(store.pool.get('DebugItem', id(1))?.['title']).toBe('Arrived meanwhile');
    expect(store.position?.lastSyncId).toBe(hub.head);
    expect(hub.connections).toHaveLength(1);
    expect(hub.bootstraps).toBe(1);
    await store.close();
  });
});

describe('applying deltas (§3.4)', () => {
  it('applies inserts, updates, archives, unarchives and deletes in order', async () => {
    const hub = seededHub();
    const { store } = liveStore(hub);
    await store.start();
    await until(() => store.connection === 'online');

    hub.upsert(4);
    hub.upsert(1, { title: 'Renamed' });
    hub.archive(2);
    hub.archive(3);
    hub.archive(3, false);
    hub.remove(4);
    hub.upsert(5, { counter: 50 });

    expect(clientItems(store)).toEqual(serverItems(hub));
    expect(store.position?.lastSyncId).toBe(hub.head);
    await store.close();
  });

  // SPEC-011 §5.5, AC-18: A and V carry the row; the client applies them as an upsert plus the flag.
  describe('archive state on the wire (v0.7)', () => {
    it('inserts a row it does not hold from a V, with the row the packet carries', async () => {
      const hub = seededHub();
      hub.archive(2);
      const { store } = liveStore(hub);
      await store.start();
      await until(() => store.connection === 'online');
      // The client never held row 7: the server sends its V (a restore) with the full row.
      hub.connections.at(-1)?.send({
        t: 'deltas',
        prev: hub.head,
        packets: [
          {
            id: hub.head + 1,
            a: 'V',
            m: 'DebugItem',
            d: debugRow(7, { title: 'Restored', counter: 70 }),
          },
        ],
        ack: [],
      });
      await until(() => store.pool.get('DebugItem', id(7)) !== undefined);
      expect(store.pool.get('DebugItem', id(7))).toMatchObject({
        title: 'Restored',
        counter: 70,
        archivedAt: null,
        $archived: false,
      });
      expect(store.position?.lastSyncId).toBe(hub.head + 1);
      await store.close();
    });

    it('keeps an archived row archived through an update, and archivedAt and $archived agree', async () => {
      const hub = seededHub();
      const { store } = liveStore(hub);
      await store.start();
      await until(() => store.connection === 'online');

      hub.archive(1);
      const archivedAt = hub.rows.get(id(1))?.row['archivedAt'];
      expect(typeof archivedAt).toBe('string');
      expect(store.pool.get('DebugItem', id(1))).toMatchObject({ archivedAt, $archived: true });
      hub.upsert(1, { title: 'Edited while archived' });
      expect(store.pool.get('DebugItem', id(1))).toMatchObject({
        title: 'Edited while archived',
        archivedAt,
        $archived: true,
      });
      hub.archive(1, false);
      expect(store.pool.get('DebugItem', id(1))).toMatchObject({
        archivedAt: null,
        $archived: false,
      });
      for (const item of Object.values(clientItems(store))) {
        expect(item.archived).toBe(item.archivedAt !== null);
      }
      expect(clientItems(store)).toEqual(serverItems(hub));
      await store.close();
    });

    it('takes the fields an archive changed along with the flag', async () => {
      const hub = seededHub();
      const { store } = liveStore(hub);
      await store.start();
      await until(() => store.connection === 'online');
      // The server's row moved on in the same transaction (an A carries the row as committed).
      const row = { ...(hub.rows.get(id(2))?.row ?? debugRow(2)), title: 'Archived title' };
      hub.rows.set(id(2), { row, archived: false });
      hub.archive(2);
      expect(store.pool.get('DebugItem', id(2))).toMatchObject({
        title: 'Archived title',
        $archived: true,
      });
      await store.close();
    });
  });

  it('persists each message, so the next start is warm and up to date', async () => {
    const workspaceId = uniqueName('ws');
    const hub = seededHub();
    const first = liveStore(hub, { workspaceId, connectStorage: connectViaRpc }).store;
    await first.start();
    await until(() => first.connection === 'online');
    hub.upsert(1, { title: 'Renamed' });
    hub.archive(2);
    hub.remove(3);
    await first.close();

    const second = liveStore(hub, { workspaceId, connectStorage: connectViaRpc }).store;
    expect(await second.start()).toBe('warm');
    expect(clientItems(second)).toEqual(serverItems(hub));
    expect(second.position?.lastSyncId).toBe(hub.head);
    await until(() => second.connection === 'online');
    expect(hub.last.since).toBe(hub.head);
    await second.close();
  });

  it('catches up on 1,000 changes made while it was away (AC-9, client side)', async () => {
    const workspaceId = uniqueName('ws');
    const hub = seededHub();
    const first = liveStore(hub, { workspaceId, connectStorage: connectViaRpc }).store;
    await first.start();
    await first.close();

    for (let i = 0; i < 1000; i += 1) {
      const n = (i % 40) + 1;
      if (i % 7 === 6) hub.remove(n);
      else hub.upsert(n, { counter: i });
    }

    const second = liveStore(hub, { workspaceId, connectStorage: connectViaRpc }).store;
    expect(await second.start()).toBe('warm');
    await until(() => second.connection === 'online');
    expect(hub.last.messages.length).toBeGreaterThan(1); // paged catch-up
    expect(clientItems(second)).toEqual(serverItems(hub));
    expect(second.position?.lastSyncId).toBe(hub.head);
    await second.close();
  });

  it('skips ids the server used for rows this client cannot see', async () => {
    const hub = seededHub();
    const { store } = liveStore(hub);
    await store.start();
    await until(() => store.connection === 'online');
    hub.invisible();
    hub.invisible();
    hub.upsert(9);
    expect(clientItems(store)).toEqual(serverItems(hub));
    expect(store.connection).toBe('online');
    await store.close();
  });
});

describe('gaps and duplicates', () => {
  it('reconnects from its own position when packets were missed, applying nothing of the later message (E1)', async () => {
    const hub = seededHub();
    const { store, timers } = liveStore(hub);
    await store.start();
    await until(() => store.connection === 'online');
    const before = store.position?.lastSyncId;
    const first = hub.last;

    first.paused = true;
    hub.upsert(1, { title: 'Lost' });
    first.lose(); // that packet never arrives
    first.paused = false;
    hub.upsert(2, { title: 'After the gap' });
    expect(first.closedWith).toBe(1000);
    expect(store.connection).toBe('offline');
    expect(store.position?.lastSyncId).toBe(before);
    expect(store.pool.get('DebugItem', id(2))?.['title']).toBe('Item 2');

    timers.runNext();
    await until(() => store.connection === 'online');
    expect(hub.last).not.toBe(first);
    expect(hub.last.since).toBe(before);
    expect(clientItems(store)).toEqual(serverItems(hub));
    await store.close();
  });

  it('ignores a repeated message (E2)', async () => {
    const hub = seededHub();
    const { store } = liveStore(hub);
    await store.start();
    await until(() => store.connection === 'online');
    hub.upsert(1, { title: 'Once' });
    const position = store.position;
    const connections = hub.connections.length;

    hub.last.repeat();
    expect(store.position).toBe(position);
    expect(hub.connections).toHaveLength(connections);
    expect(store.connection).toBe('online');
    await store.close();
  });

  it('does not let an older message, delivered again, undo a newer one (E2)', async () => {
    const hub = seededHub();
    const { store } = liveStore(hub);
    await store.start();
    await until(() => store.connection === 'online');
    const connection = hub.last;
    hub.upsert(1, { title: 'A' });
    const older = connection.messages.at(-1);
    hub.upsert(1, { title: 'B' });
    if (older === undefined) throw new Error('expected a message');

    connection.send(older);
    expect(store.pool.get('DebugItem', id(1))?.['title']).toBe('B');
    expect(store.position?.lastSyncId).toBe(hub.head);
    expect(store.connection).toBe('online');
    expect(hub.connections).toHaveLength(1);
    await store.close();
  });

  it('applies only the new packets of a message that overlaps what it has (E2)', async () => {
    const hub = seededHub();
    const { store } = liveStore(hub);
    await store.start();
    await until(() => store.connection === 'online');
    const connection = hub.last;
    hub.upsert(1, { title: 'Seen' });
    connection.paused = true;
    hub.upsert(2, { title: 'New' });
    const [seen, fresh] = hub.log.slice(-2);
    if (seen === undefined || fresh === undefined) throw new Error('expected two packets');
    connection.send({ t: 'deltas', prev: seen.id - 1, packets: [seen, fresh], ack: [] });

    expect(store.position?.lastSyncId).toBe(fresh.id);
    expect(clientItems(store)).toEqual(serverItems(hub));
    expect(store.connection).toBe('online');
    await store.close();
  });
});

describe('bad or unexpected messages', () => {
  it('drops a message whose row does not match its model, applies nothing, and reconnects', async () => {
    const hub = seededHub();
    const { store, timers } = liveStore(hub);
    await store.start();
    await until(() => store.connection === 'online');
    const connection = hub.last;
    const position = store.position;
    connection.send({
      t: 'deltas',
      prev: connection.sent,
      packets: [
        { id: hub.head + 1, a: 'U', m: 'DebugItem', d: { ...debugRow(1, { title: 'Fine' }) } },
        { id: hub.head + 2, a: 'U', m: 'DebugItem', d: { ...debugRow(2), counter: 'many' } },
      ],
      ack: [],
    });
    expect(store.position).toBe(position);
    expect(store.pool.get('DebugItem', id(1))?.['title']).toBe('Item 1');
    expect(connection.closedWith).toBe(1000);

    timers.runNext();
    await until(() => store.connection === 'online');
    expect(clientItems(store)).toEqual(serverItems(hub));
    await store.close();
  });

  it('starts over after the same bad message keeps coming back (review S7 m1)', async () => {
    const hub = seededHub();
    const { store, timers } = liveStore(hub);
    await store.start();
    await until(() => store.connection === 'online');
    const connection = hub.last;
    connection.paused = true;
    hub.upsert(1, { counter: 'many' }); // a row this client rejects, kept in the log...
    hub.upsert(1, { counter: 7 }); // ...though the current row is fine
    connection.paused = false;
    connection.deliver();

    // Each reconnect catches up from the same position and gets the same message.
    for (let i = 0; i < 10 && hub.bootstraps < 2; i += 1) {
      await until(() => store.connection === 'offline' || hub.bootstraps === 2);
      if (store.connection === 'offline') timers.runNext();
    }
    await until(() => store.status === 'ready' && store.connection === 'online');
    expect(hub.bootstraps).toBe(2);
    expect(hub.connections.length).toBeLessThanOrEqual(4);
    expect(clientItems(store)).toEqual(serverItems(hub));
    expect(store.error).toBeUndefined();
    await store.close();
  });

  it('fails, says why, and stops retrying when the snapshot has the bad row too (review S7 m1)', async () => {
    const hub = seededHub();
    const { store, timers } = liveStore(hub);
    await store.start();
    await until(() => store.connection === 'online');
    hub.upsert(1, { counter: 'many' });

    for (let i = 0; i < 10 && store.status !== 'failed'; i += 1) {
      await until(() => store.connection === 'offline' || store.status === 'failed');
      if (store.connection === 'offline') timers.runNext();
    }
    expect(store.status).toBe('failed');
    expect(store.error).toMatch(/Invalid DebugItem row/);
    expect(store.connection).toBe('disconnected');
    expect(timers.pending).toEqual([]);
    expect(hub.bootstraps).toBe(2);
    await store.close();
  });

  it('starts over when its sync groups change (a G packet, until M7)', async () => {
    const hub = seededHub();
    const { store } = liveStore(hub);
    await store.start();
    await until(() => store.connection === 'online');
    const connection = hub.last;
    hub.invisible();
    connection.send({
      t: 'deltas',
      prev: connection.sent,
      packets: [
        { id: hub.head, a: 'G', added: ['team:0190f4c4-0000-7000-8000-000000000001'], removed: [] },
      ],
      ack: [],
    });
    await until(() => store.connection === 'online' && hub.connections.length === 2);
    expect(hub.bootstraps).toBe(2);
    expect(hub.last.since).toBe(hub.head);
    await store.close();
  });
});

describe('a revoked session (E10)', () => {
  it('reports it and stops reconnecting', async () => {
    const hub = seededHub();
    const onSessionRevoked = vi.fn();
    const { store, timers } = liveStore(hub, { onSessionRevoked });
    await store.start();
    await until(() => store.connection === 'online');
    hub.last.revoke();
    expect(onSessionRevoked).toHaveBeenCalledOnce();
    expect(store.connection).toBe('revoked');
    timers.advance(60_000); // a redial would happen synchronously in here
    expect(timers.pending).toEqual([]);
    expect(hub.connections).toHaveLength(1);
    // The replica is kept for when the user logs back in.
    expect(clientItems(store)).toEqual(serverItems(hub));
    await store.close();
  });
});
