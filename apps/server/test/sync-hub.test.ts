// PLAN-002 S4: the sync hub's rules (SPEC-002 §4.3, sync-protocol §4.3), against an in-memory
// `sync_log` and fake sockets. Every message is decoded with the client's codec. The same hub over
// Postgres and a real WebSocket is `sync-groups.int.test.ts` (AC-11).
import { randomUUID } from 'node:crypto';
import {
  CloseCode,
  decodeServerMessage,
  PING_INTERVAL_MS,
  PING_TIMEOUT_MS,
  type DeltaPacket,
  type DeltasMessage,
  type ServerMessage,
} from '@surface/sync-protocol';
import pino from 'pino';
import { Registry } from 'prom-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hubMetrics,
  SyncHub,
  type ConnectionInfo,
  type HubMetrics,
  type HubOptions,
  type HubSocket,
} from '../src/sync/hub.js';
import type { LogRow } from '../src/sync/delta-writer.js';
import { syncRegistry } from '../src/sync/registry.js';
import { deferred, FakeLog } from './sync-fake-log.js';

const registry = syncRegistry({ includeFixtures: true });
const log = pino({ level: 'silent' });
const team = `team:${randomUUID()}`;

class FakeSocket implements HubSocket {
  readonly messages: ServerMessage[] = [];
  closedWith: number | undefined;
  terminated = false;
  /** While paused, what is sent stays queued, as on a socket whose client doesn't read. */
  paused = false;
  /** How often the hub looked at the queue. */
  bufferedReads = 0;
  #queued = 0;
  get bufferedAmount(): number {
    this.bufferedReads += 1;
    return this.#queued;
  }
  set bufferedAmount(bytes: number) {
    this.#queued = bytes;
  }
  resume(): void {
    this.paused = false;
    this.#queued = 0;
  }
  send(text: string): void {
    this.messages.push(decodeServerMessage(text));
    if (this.paused) this.#queued += text.length;
  }
  close(code: number): void {
    this.closedWith = code;
  }
  terminate(): void {
    this.terminated = true;
  }
  get deltas(): DeltasMessage[] {
    return this.messages.filter((m): m is DeltasMessage => m.t === 'deltas');
  }
  get packets(): DeltaPacket[] {
    return this.deltas.flatMap((m) => m.packets);
  }
}

let hub: SyncHub | undefined;
afterEach(async () => {
  await hub?.stop();
  hub = undefined;
  vi.useRealTimers();
});

async function startHub(source: FakeLog, options: Partial<HubOptions> = {}): Promise<SyncHub> {
  hub = new SyncHub({ source, registry, log, ...options });
  await hub.start();
  return hub;
}

/** Records what the hub reports, instead of a Prometheus registry. */
function recordedMetrics() {
  const lags: number[] = [];
  const connections: number[] = [];
  const metrics: HubMetrics = {
    observeLag: (seconds) => lags.push(seconds),
    setConnections: (count) => connections.push(count),
  };
  return { metrics, lags, connections };
}

const fakeTimers = () =>
  vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout', 'clearTimeout', 'clearInterval'] });

function info(over: Partial<ConnectionInfo> = {}): ConnectionInfo {
  return {
    userId: randomUUID(),
    clientId: randomUUID(),
    groups: ['workspace'],
    since: 0,
    schemaHash: registry.schemaHash,
    ...over,
  };
}

/** Polls `check` until it holds or 2 s pass, without sleeping. */
async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in 2 s');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** The client's view: every message chains `prev` and no packet repeats or goes backwards. */
function expectContiguous(socket: FakeSocket, since: number): void {
  let last = since;
  for (const message of socket.deltas) {
    expect(message.prev).toBe(last);
    for (const packet of message.packets) {
      expect(packet.id).toBeGreaterThan(last);
      last = packet.id;
    }
  }
}

describe('catch-up', () => {
  it('sends a client away for 1,000 changes each of them once, in order (AC-9)', async () => {
    const source = new FakeLog();
    source.commit(...Array.from({ length: 20 }, () => ({})));
    const since = source.headId;
    const changes = source.commit(
      ...Array.from({ length: 1000 }, (_, i) => ({
        groups: i % 10 === 0 ? [team] : ['workspace'],
      })),
    );
    const h = await startHub(source);
    const socket = new FakeSocket();
    h.connect(socket, info({ since }));

    const visible = changes.filter((r) => r.groups.includes('workspace')).map((r) => r.syncId);
    await eventually(() => socket.packets.length === visible.length);
    expect(socket.packets.map((p) => p.id)).toEqual(visible);
    expectContiguous(socket, since);
    expect(socket.deltas.every((m) => m.packets.length <= 500)).toBe(true);
  });

  it('then delivers live changes on the same chain', async () => {
    const source = new FakeLog();
    source.commit({}, {});
    const h = await startHub(source);
    const socket = new FakeSocket();
    h.connect(socket, info());
    await eventually(() => socket.packets.length === 2);
    const [live] = source.write({});
    await eventually(() => socket.packets.length === 3);
    expect(socket.packets.at(-1)?.id).toBe(live?.syncId);
    expectContiguous(socket, 0);
  });

  it('misses nothing and repeats nothing that commits while it runs', async () => {
    const source = new FakeLog();
    source.commit(...Array.from({ length: 1200 }, () => ({})));
    const gate = deferred<void>();
    source.catchUpGate = gate.promise;
    const h = await startHub(source, { catchUpPageSize: 500 });
    const socket = new FakeSocket();
    h.connect(socket, info());
    await source.catchUpStarted.promise;

    // Live writes while the catch-up is paused after its first page, and one committed but not
    // yet broadcast (its notification is still to come).
    source.write({}, {});
    source.commit({});
    source.write({});
    gate.resolve();

    await eventually(() => socket.packets.length === source.headId);
    expect(socket.packets.map((p) => p.id)).toEqual(source.rows.map((r) => r.syncId));
    expectContiguous(socket, 0);
  });

  it('repeats nothing when the client is ahead of what the hub has broadcast', async () => {
    const source = new FakeLog();
    const h = await startHub(source);
    // Committed but not yet broadcast; the client's bootstrap already holds them.
    source.commit({}, {}, {});
    const socket = new FakeSocket();
    h.connect(socket, info({ since: 3 }));
    source.write({});
    await eventually(() => socket.packets.length === 1);
    expect(socket.packets.map((p) => p.id)).toEqual([4]);
    expect(socket.deltas[0]?.prev).toBe(3);
  });

  it('stops reading the log when the client goes away', async () => {
    const source = new FakeLog();
    source.commit(...Array.from({ length: 600 }, () => ({})));
    const gate = deferred<void>();
    source.catchUpGate = gate.promise;
    const h = await startHub(source, { catchUpPageSize: 100 });
    const socket = new FakeSocket();
    const connection = h.connect(socket, info());
    await source.catchUpStarted.promise;
    connection.closed();
    gate.resolve();
    await eventually(() => source.snapshotsOpen === 0);
    expect(h.connectionCount).toBe(0);
  });

  it('waits for a client that reads slowly instead of dropping it, live rows included', async () => {
    const source = new FakeLog();
    source.commit(...Array.from({ length: 1500 }, () => ({})));
    const h = await startHub(source, {
      maxSocketBytes: 1000,
      catchUpHighWaterBytes: 500,
      drainPollMs: 1,
    });
    const socket = new FakeSocket();
    socket.paused = true;
    h.connect(socket, info());
    await eventually(() => socket.deltas.length === 1);
    source.write({}); // live, while catch-up waits
    const reads = socket.bufferedReads;
    await eventually(() => socket.bufferedReads > reads + 5);
    // Far past `maxSocketBytes`, but a catching-up client is waited for, not dropped.
    expect([socket.deltas.length, socket.terminated, source.snapshotsOpen]).toEqual([1, false, 1]);
    socket.resume();
    await eventually(() => socket.packets.length === 1501);
    expectContiguous(socket, 0);
    expect(h.connectionCount).toBe(1);
  });

  it('drops a client whose live backlog outgrows the buffer while it catches up', async () => {
    const source = new FakeLog();
    source.commit({});
    const gate = deferred<void>();
    source.catchUpGate = gate.promise;
    const h = await startHub(source, { maxBufferedRows: 3 });
    const socket = new FakeSocket();
    h.connect(socket, info());
    await source.catchUpStarted.promise;
    source.write({}, {});
    source.write({}, {});
    await eventually(() => socket.closedWith !== undefined);
    expect(socket.closedWith).toBe(1013);
    gate.resolve();
  });
});

describe('resync (AC-10, server part)', () => {
  it('asks a client with another schema hash to reload, and sends it nothing else', async () => {
    const source = new FakeLog();
    source.commit({});
    const h = await startHub(source);
    const socket = new FakeSocket();
    h.connect(socket, info({ schemaHash: 'f'.repeat(64) }));
    source.write({});
    await eventually(() => socket.messages.length > 0);
    await new Promise((resolve) => setImmediate(resolve));
    expect(socket.messages).toEqual([{ t: 'resync', reason: 'schema' }]);
  });

  it('asks a client whose since is older than the retained log to re-bootstrap', async () => {
    const source = new FakeLog();
    source.commit(...Array.from({ length: 10 }, () => ({})));
    source.retainedFrom = 6;
    const h = await startHub(source);
    const stale = new FakeSocket();
    const edge = new FakeSocket();
    h.connect(stale, info({ since: 4 }));
    h.connect(edge, info({ since: 5 }));
    await eventually(() => stale.messages.length > 0 && edge.packets.length === 5);
    expect(stale.messages).toEqual([{ t: 'resync', reason: 'too_old' }]);
    source.write({});
    await eventually(() => edge.packets.length === 6);
    expect(stale.messages).toHaveLength(1);
  });

  it('asks a client ahead of the database (a restored backup) to re-bootstrap', async () => {
    const source = new FakeLog();
    source.commit({});
    const h = await startHub(source);
    const socket = new FakeSocket();
    h.connect(socket, info({ since: 50 }));
    await eventually(() => socket.messages.length > 0);
    expect(socket.messages).toEqual([{ t: 'resync', reason: 'too_old' }]);
  });
});

describe('group filtering (AC-11, unit; the Postgres leak test is sync-groups.int.test.ts)', () => {
  it("sends a client outside team X none of X's rows, in catch-up or live", async () => {
    const source = new FakeLog();
    source.commit({ groups: [team] }, { groups: ['workspace'] }, { groups: ['workspace', team] });
    const h = await startHub(source);
    const outsider = new FakeSocket();
    const member = new FakeSocket();
    h.connect(outsider, info());
    h.connect(member, info({ groups: ['workspace', team] }));
    source.write({ groups: [team] }, { groups: ['workspace', team] });
    await eventually(() => member.packets.length === 5 && outsider.packets.length === 3);
    expect(outsider.packets.map((p) => p.id)).toEqual([2, 3, 5]);
    expect(JSON.stringify(outsider.messages)).not.toContain(team);
    expect(member.packets.map((p) => p.id)).toEqual([1, 2, 3, 4, 5]);
  });
});

/** A `TeamMembership` log row of the private team `team` (or of a public team: `workspace`). */
function membership(
  action: 'I' | 'U' | 'D',
  userId: string,
  groups: readonly string[] = [team],
): Partial<LogRow> {
  const id = randomUUID();
  const at = '2026-11-07T10:00:00.000Z';
  return {
    model: 'TeamMembership',
    modelId: id,
    action,
    groups,
    data:
      action === 'D'
        ? null
        : {
            id,
            teamId: randomUUID(),
            userId,
            triageResponsible: false,
            createdAt: at,
            updatedAt: at,
            syncGroups: groups,
          },
  };
}

const resyncGroups: ServerMessage = { t: 'resync', reason: 'groups' };

// PLAN-001 S9, security review M1: a connection's groups are fixed when it opens, so a change of
// membership of a private team must not leave it receiving the team's rows (permissions.md §5).
describe('group changes (private-team leak)', () => {
  it("resyncs a member removed from private team X, and sends none of X's later rows", async () => {
    const source = new FakeLog();
    const h = await startHub(source);
    const member = new FakeSocket();
    const outsider = new FakeSocket();
    h.connect(member, info({ groups: ['workspace', team] }));
    h.connect(outsider, info());
    source.write({ groups: [team] });
    await eventually(() => member.packets.length === 1);
    // Removed, and X changes in the same delivery and after it.
    source.write(membership('D', randomUUID()), { groups: [team] });
    source.write({ groups: [team] }, { groups: ['workspace'] });
    await eventually(() => outsider.packets.length === 1);
    expect(member.messages.slice(1)).toEqual([resyncGroups]);
    expect(member.packets.map((p) => p.id)).toEqual([1]);
    // Others stay live.
    expect(outsider.packets.map((p) => p.id)).toEqual([5]);
    expect(outsider.messages).not.toContainEqual(resyncGroups);
  });

  it('resyncs a user added to private team X, so they bootstrap its rows', async () => {
    const source = new FakeLog();
    const h = await startHub(source);
    const joiner = info();
    const socket = new FakeSocket();
    const member = new FakeSocket();
    const outsider = new FakeSocket();
    h.connect(socket, joiner);
    h.connect(member, info({ groups: ['workspace', team] }));
    h.connect(outsider, info());
    source.write(membership('I', joiner.userId), {});
    await eventually(() => socket.messages.length > 0 && outsider.packets.length === 1);
    expect(socket.messages).toEqual([resyncGroups]);
    // Someone else joining changes nothing for the others: a row for a member, nothing for an
    // outsider.
    expect(member.packets).toHaveLength(2);
    expect(member.messages).not.toContainEqual(resyncGroups);
    expect(outsider.messages).not.toContainEqual(resyncGroups);
  });

  it("resyncs a client that catches up across its own join: its replica lacks X's earlier rows", async () => {
    const source = new FakeLog();
    // Groups read after the join have X already; the rows before `since` never reached it.
    const user = info({ groups: ['workspace', team], since: 1 });
    source.commit({ groups: [team] }, membership('I', user.userId), { groups: [team] });
    const h = await startHub(source);
    const socket = new FakeSocket();
    h.connect(socket, user);
    await eventually(() => socket.messages.length > 0);
    await new Promise((resolve) => setImmediate(resolve));
    expect(socket.messages).toEqual([resyncGroups]);
  });

  it('ignores membership rows the client already has (at or below its since)', async () => {
    const source = new FakeLog();
    const h = await startHub(source);
    const user = info({ groups: ['workspace', team] });
    // Committed but not yet broadcast: the client bootstrapped past it, and the next delivery
    // hands it over again with what follows.
    source.commit(membership('I', user.userId));
    const socket = new FakeSocket();
    h.connect(socket, { ...user, since: source.headId });
    source.write({ groups: [team] });
    await eventually(() => socket.packets.length === 1);
    expect(socket.messages).not.toContainEqual(resyncGroups);
  });

  it('does not resync for a change to the user’s own membership of a team they are in', async () => {
    const source = new FakeLog();
    const h = await startHub(source);
    const user = info({ groups: ['workspace', team] });
    const socket = new FakeSocket();
    h.connect(socket, user);
    source.write(membership('U', user.userId));
    await eventually(() => socket.packets.length === 1);
    expect(socket.messages).not.toContainEqual(resyncGroups);
  });

  it('resyncs a client removed from X while away, though it can no longer see the deletion', async () => {
    const source = new FakeLog();
    source.commit({ groups: [team] }, membership('D', randomUUID()), { groups: ['workspace'] });
    const h = await startHub(source);
    // Its groups, read now, no longer have X; its replica, up to `since`, still holds X's rows.
    const away = new FakeSocket();
    h.connect(away, info({ since: 1 }));
    // Caught up past the deletion, a client has nothing of X to drop.
    const later = new FakeSocket();
    h.connect(later, info({ since: 2 }));
    await eventually(() => away.messages.length > 0 && later.packets.length === 1);
    await new Promise((resolve) => setImmediate(resolve));
    expect(away.messages).toEqual([resyncGroups]);
    expect(later.messages).not.toContainEqual(resyncGroups);
  });

  it('resyncs it too when the hub has not broadcast the deletion yet', async () => {
    const source = new FakeLog();
    source.commit({ groups: [team] });
    const h = await startHub(source);
    // Committed, and so behind the groups read at reconnect, but not yet notified: the hub's
    // catch-up range stops before it, and it would arrive live to a connection without X.
    source.commit(membership('D', randomUUID()));
    const away = new FakeSocket();
    h.connect(away, info({ since: 1 }));
    await eventually(() => away.messages.length > 0);
    expect(away.messages).toEqual([resyncGroups]);
  });

  it('does not resync a client away while a public team lost a member', async () => {
    const source = new FakeLog();
    source.commit(membership('D', randomUUID(), ['workspace']), { groups: ['workspace'] });
    const h = await startHub(source);
    const socket = new FakeSocket();
    h.connect(socket, info());
    await eventually(() => socket.packets.length === 2);
    expect(socket.messages).not.toContainEqual(resyncGroups);
  });

  it('resyncs nobody for a public team’s memberships', async () => {
    const source = new FakeLog();
    const h = await startHub(source);
    const user = info();
    const socket = new FakeSocket();
    h.connect(socket, user);
    source.write(membership('I', user.userId, ['workspace']));
    source.write(membership('D', user.userId, ['workspace']));
    await eventually(() => socket.packets.length === 2);
    expect(socket.messages).not.toContainEqual(resyncGroups);
  });

  it('resyncs in catch-up when the groups read before the upgrade include a team since left', async () => {
    const source = new FakeLog();
    source.commit({ groups: [team] }, membership('D', randomUUID()), { groups: [team] });
    const h = await startHub(source);
    const socket = new FakeSocket();
    h.connect(socket, info({ groups: ['workspace', team] }));
    await eventually(() => socket.messages.length > 0);
    await new Promise((resolve) => setImmediate(resolve));
    expect(socket.messages).toEqual([resyncGroups]);
  });

  it('stops a catch-up in progress once a live change resyncs it', async () => {
    const source = new FakeLog();
    source.commit(...Array.from({ length: 3 }, () => ({ groups: [team] })));
    const gate = deferred<void>();
    source.catchUpGate = gate.promise;
    const h = await startHub(source, { catchUpPageSize: 1 });
    const socket = new FakeSocket();
    h.connect(socket, info({ groups: ['workspace', team] }));
    // Paused after its first page.
    await source.catchUpStarted.promise;
    await new Promise((resolve) => setImmediate(resolve));
    source.write(membership('D', randomUUID()), { groups: [team] });
    await eventually(() => socket.messages.some((m) => m.t === 'resync'));
    gate.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    source.write({ groups: [team] });
    await new Promise((resolve) => setImmediate(resolve));
    const after = socket.messages.slice(socket.messages.indexOf(resyncGroups) + 1);
    expect(socket.messages).toContainEqual(resyncGroups);
    expect(after.filter((m) => m.t === 'deltas')).toEqual([]);
    // At most the page read before the change: never pages 2 and 3, nor the live rows.
    expect(socket.packets.every((p) => p.id === 1)).toBe(true);
  });
});

describe('acks', () => {
  it("confirm a client's own mutation that changed only rows it can't see, live and in catch-up", async () => {
    const source = new FakeLog();
    const clientId = randomUUID();
    source.commit({ groups: [team], clientId, clientSeq: 1 });
    const h = await startHub(source);
    const socket = new FakeSocket();
    h.connect(socket, info({ clientId }));
    await eventually(() => socket.deltas.length === 1);
    source.write({ groups: [team], clientId, clientSeq: 2 });
    await eventually(() => socket.deltas.length === 2);
    expect(socket.deltas.map((m) => [m.packets, m.ack])).toEqual([
      [[], [{ clientId, seq: 1 }]],
      [[], [{ clientId, seq: 2 }]],
    ]);
  });

  it("are not sent to another client's connection", async () => {
    const source = new FakeLog();
    const h = await startHub(source);
    const socket = new FakeSocket();
    h.connect(socket, info());
    source.write({ clientId: randomUUID(), clientSeq: 1 });
    await eventually(() => socket.deltas.length === 1);
    expect(socket.deltas[0]?.ack).toEqual([]);
  });
});

describe('connection health', () => {
  it('pings every 25 s, and ends a connection that has not answered within 10 s', async () => {
    fakeTimers();
    const source = new FakeLog();
    const h = await startHub(source);
    const healthy = new FakeSocket();
    const silent = new FakeSocket();
    const handle = h.connect(healthy, info());
    h.connect(silent, info());
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    expect(healthy.messages.filter((m) => m.t === 'ping')).toHaveLength(1);
    handle.receive('{"t":"pong"}');
    await vi.advanceTimersByTimeAsync(PING_TIMEOUT_MS);
    expect([healthy.terminated, silent.terminated]).toEqual([false, true]);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    expect(healthy.messages.filter((m) => m.t === 'ping')).toHaveLength(2);
  });

  it('closes a connection that sends something other than pong', async () => {
    const h = await startHub(new FakeLog());
    const socket = new FakeSocket();
    h.connect(socket, info()).receive('{"t":"hello"}');
    expect(socket.closedWith).toBe(1008);
    expect(h.connectionCount).toBe(0);
  });

  it('drops a client that does not read fast enough', async () => {
    const source = new FakeLog();
    const h = await startHub(source, { maxSocketBytes: 1000 });
    const socket = new FakeSocket();
    h.connect(socket, info());
    await eventually(() => source.snapshotsOpen === 0);
    socket.bufferedAmount = 5000;
    source.write({});
    await eventually(() => socket.terminated);
    expect(h.connectionCount).toBe(0);
  });

  it('listens again after losing its connection, and delivers what committed meanwhile', async () => {
    const source = new FakeLog();
    const h = await startHub(source, { retryDelayMs: 1 });
    const socket = new FakeSocket();
    h.connect(socket, info());
    source.dropListener();
    source.write({}, {}); // its notification is lost
    await eventually(() => source.listens === 2 && socket.packets.length === 2);
    expect(source.listenersClosed).toBe(1); // the lost one
    source.write({});
    await eventually(() => socket.packets.length === 3);
    expectContiguous(socket, 0);
  });
});

describe('missed notifications and failed reads', () => {
  it('delivers a commit whose notification never came within one ping interval', async () => {
    fakeTimers();
    const source = new FakeLog();
    const h = await startHub(source);
    const socket = new FakeSocket();
    h.connect(socket, info());
    await eventually(() => source.snapshotsOpen === 0);
    source.commit({}); // a listen connection that went half-open: no notification
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS - 1);
    expect(socket.packets).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await eventually(() => socket.packets.length === 1);
  });

  it('reads again after a failed read, and counts its lag from the notification', async () => {
    fakeTimers();
    const source = new FakeLog();
    const { metrics, lags } = recordedMetrics();
    const h = await startHub(source, { metrics });
    const socket = new FakeSocket();
    h.connect(socket, info());
    await eventually(() => source.snapshotsOpen === 0);
    source.failReads = 1;
    source.write({});
    await eventually(() => source.failReads === 0);
    await vi.advanceTimersByTimeAsync(0);
    expect([socket.packets.length, lags.length]).toEqual([0, 0]);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    await eventually(() => socket.packets.length === 1);
    expect(lags).toHaveLength(1);
  });

  it('stops listening when it cannot read the head at start', async () => {
    const source = new FakeLog();
    source.failHeads = 1;
    hub = new SyncHub({ source, registry, log });
    await expect(hub.start()).rejects.toThrow('database unavailable');
    expect([source.listens, source.listenersClosed, hub.started]).toEqual([1, 1, false]);
  });
});

describe('metrics (SPEC-002 §10)', () => {
  it('counts connections, and records broadcast lag for notified deliveries only', async () => {
    fakeTimers();
    const source = new FakeLog();
    const { metrics, lags, connections } = recordedMetrics();
    const h = await startHub(source, { metrics });
    const socket = new FakeSocket();
    const handle = h.connect(socket, info());
    source.write({});
    await eventually(() => socket.packets.length === 1);
    expect(lags).toHaveLength(1);
    expect(lags[0]).toBeGreaterThanOrEqual(0);
    source.commit({}); // found by the ping round's poll, which is not broadcast lag
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    await eventually(() => socket.packets.length === 2);
    expect(lags).toHaveLength(1);
    handle.closed();
    expect(connections).toEqual([1, 0]);
  });

  it('publishes them as surface_sync_broadcast_lag_seconds and surface_sync_connections', async () => {
    const prometheus = new Registry();
    const metrics = hubMetrics(prometheus);
    metrics.observeLag(0.003);
    metrics.setConnections(2);
    const text = await prometheus.metrics();
    expect(text).toContain('surface_sync_broadcast_lag_seconds_bucket{le="0.005"} 1');
    expect(text).toContain('surface_sync_connections 2');
  });
});

// SPEC-002 E14: a client from before sync-protocol v0.5 names no user. The hub tells it to reload
// and keeps it idle: pinged and counted, closed with its session or on shutdown, never sent a row.
describe('a client without userId (connectOutdated)', () => {
  it('gets resync(schema), then only pings: no rows and no group resync, however the log changes', async () => {
    fakeTimers();
    const source = new FakeLog();
    const { metrics, connections } = recordedMetrics();
    const h = await startHub(source, { metrics });
    const old = new FakeSocket();
    h.connectOutdated(old);
    expect(connections).toEqual([1]);
    // A current client in the team sees both writes; the old one sees neither.
    const current = new FakeSocket();
    h.connect(current, info({ groups: ['workspace', team] }));
    source.write({ groups: [team] }, membership('D', randomUUID()));
    await eventually(() => current.messages.length >= 1);
    await vi.advanceTimersByTimeAsync(PING_INTERVAL_MS);
    expect(old.messages).toEqual([{ t: 'resync', reason: 'schema' }, { t: 'ping' }]);
  });

  it('is closed with 4001 when its session ends, and with 1012 on shutdown', async () => {
    const { metrics, connections } = recordedMetrics();
    const h = await startHub(new FakeLog(), { metrics });
    const signedOut = new FakeSocket();
    const open = new FakeSocket();
    h.connectOutdated(signedOut, 's1');
    h.connectOutdated(open);
    expect(h.closeSessions(['s1'])).toBe(1);
    await h.stop();
    expect([signedOut.closedWith, open.closedWith]).toEqual([CloseCode.SessionRevoked, 1012]);
    expect(connections.at(-1)).toBe(0);
  });
});

describe('closing', () => {
  it('closes the connections of revoked sessions with 4001, and only those', async () => {
    const h = await startHub(new FakeLog());
    const revoked = new FakeSocket();
    const other = new FakeSocket();
    h.connect(revoked, info({ sessionId: 's1' }));
    h.connect(other, info({ sessionId: 's2' }));
    expect(h.closeSessions(['s1'])).toBe(1);
    expect([revoked.closedWith, other.closedWith]).toEqual([CloseCode.SessionRevoked, undefined]);
  });

  it('closes every connection with 1012 on shutdown, and refuses new ones', async () => {
    const h = await startHub(new FakeLog());
    const sockets = [new FakeSocket(), new FakeSocket()];
    for (const socket of sockets) h.connect(socket, info());
    await h.stop();
    expect(sockets.map((s) => s.closedWith)).toEqual([1012, 1012]);
    const late = new FakeSocket();
    h.connect(late, info());
    expect(late.closedWith).toBe(1013);
  });

  it('refuses connections before it has started', () => {
    hub = new SyncHub({ source: new FakeLog(), registry, log });
    const socket = new FakeSocket();
    hub.connect(socket, info());
    expect(socket.closedWith).toBe(1013);
  });
});
