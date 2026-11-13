// PLAN-011 S4b, SPEC-011 §5.7, E32: team subscriptions on the sync hub (sync-protocol v0.8 §4.3,
// §6.1), against an in-memory `sync_log` and fake sockets, every message decoded with the client's
// codec. A connection's groups are its home groups plus the teams it follows: `subscribed` says
// from which packet a team's deltas come, `unsubscribed` that none follows. Also: the confirm
// point of a no-op mutation (`visibleHead`) uses the connection's groups, never every group the
// user may see. Over Postgres and a real WebSocket: `subscribe-leak.int.test.ts`.
import { randomUUID } from 'node:crypto';
import { teamGroup, userActor, userGroup } from '@surface/domain';
import { createRegistry, defineOperation } from '@surface/operations';
import {
  decodeServerMessage,
  encodeSocketMessage,
  type ClientMessage,
  type DeltaPacket,
  type DeltasMessage,
  type ServerMessage,
} from '@surface/sync-protocol';
import pino from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Pool } from '../src/db/pool.js';
import { handler } from '../src/executor/context.js';
import { createExecutor } from '../src/executor/execute.js';
import type { TeamAccess } from '../src/sync/groups.js';
import {
  SyncHub,
  type ConnectionInfo,
  type HubConnection,
  type HubSocket,
} from '../src/sync/hub.js';
import { syncRegistry } from '../src/sync/registry.js';
import { deferred, FakeLog, type Deferred } from './sync-fake-log.js';

const registry = syncRegistry({ includeFixtures: true });
const log = pino({ level: 'silent' });

const USER = randomUUID();
const ENG = randomUUID(); // public
const DES = randomUUID(); // public
const SEC = randomUUID(); // private, the user is a member
const OPS = randomUUID(); // private, the user is not a member
const UNKNOWN = randomUUID();
const HOME = ['workspace', userGroup(USER), teamGroup(SEC)];

/** The access rule over a fixed set of teams: public, or private with the user a member. */
const teams = new Map<string, { private: boolean; members: string[] }>([
  [ENG, { private: false, members: [] }],
  [DES, { private: false, members: [] }],
  [SEC, { private: true, members: [USER] }],
  [OPS, { private: true, members: [] }],
]);
const access: TeamAccess = (userId, ids) =>
  Promise.resolve(
    [...new Set(ids)].filter((id) => {
      const team = teams.get(id);
      return team !== undefined && (!team.private || team.members.includes(userId));
    }),
  );

class FakeSocket implements HubSocket {
  readonly messages: ServerMessage[] = [];
  closedWith: number | undefined;
  readonly bufferedAmount = 0;
  send(text: string): void {
    this.messages.push(decodeServerMessage(text));
  }
  close(code: number): void {
    this.closedWith = code;
  }
  terminate(): void {
    this.closedWith = -1;
  }
  get deltas(): DeltasMessage[] {
    return this.messages.filter((m): m is DeltasMessage => m.t === 'deltas');
  }
  get packets(): DeltaPacket[] {
    return this.deltas.flatMap((m) => m.packets);
  }
  /** Messages other than pings, in order, deltas reduced to their packet ids. */
  get story(): unknown[] {
    return this.messages
      .filter((m) => m.t !== 'ping')
      .map((m) => (m.t === 'deltas' ? m.packets.map((p) => p.id) : m));
  }
}

let hub: SyncHub | undefined;
afterEach(async () => {
  await hub?.stop();
  hub = undefined;
});

async function startHub(source: FakeLog, teamAccess: TeamAccess = access): Promise<SyncHub> {
  hub = new SyncHub({ source, registry, log, teamAccess });
  await hub.start();
  return hub;
}

function info(over: Partial<ConnectionInfo> = {}): ConnectionInfo {
  return {
    userId: USER,
    clientId: randomUUID(),
    groups: HOME,
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

const send = (connection: HubConnection, message: ClientMessage) =>
  connection.receive(encodeSocketMessage(message));
const isLive = (socket: FakeSocket, source: FakeLog) =>
  socket.packets.some((p) => p.id === source.headId);

describe('teams on the socket URL', () => {
  it('are answered first with subscribed at since, and catch-up uses the accepted set', async () => {
    const source = new FakeLog();
    const [eng, des, ops] = source.commit(
      { groups: [teamGroup(ENG)] },
      { groups: [teamGroup(DES)] },
      { groups: [teamGroup(OPS)] },
      { groups: ['workspace'] },
    );
    const h = await startHub(source);
    const socket = new FakeSocket();
    // As the route passes them: the URL's teams after `acceptedTeams`.
    h.connect(socket, info({ teams: await access(USER, [ENG, OPS, UNKNOWN]), ackTeams: true }));
    await eventually(() => isLive(socket, source));
    expect(socket.messages[0]).toEqual({ t: 'subscribed', teams: [ENG], at: 0 });
    const ids = socket.packets.map((p) => p.id);
    expect(ids).toContain(eng?.syncId);
    expect(ids).not.toContain(des?.syncId);
    expect(ids).not.toContain(ops?.syncId);
  });

  it('send no subscribed when the client named none, and follow the given teams', async () => {
    const source = new FakeLog();
    const [eng] = source.commit({ groups: [teamGroup(ENG)] });
    const h = await startHub(source);
    const socket = new FakeSocket();
    h.connect(socket, info({ teams: [ENG] }));
    await eventually(() => isLive(socket, source));
    expect(socket.messages.some((m) => m.t === 'subscribed')).toBe(false);
    expect(socket.packets.map((p) => p.id)).toEqual([eng?.syncId]);
  });
});

describe('subscribe', () => {
  it('starts a team’s deltas from the packet after at, and none of its earlier ones', async () => {
    const source = new FakeLog();
    const h = await startHub(source);
    const socket = new FakeSocket();
    const connection = h.connect(socket, info());
    const [before] = source.write({ groups: [teamGroup(ENG)] }, { groups: ['workspace'] });
    await eventually(() => isLive(socket, source));

    send(connection, { t: 'subscribe', teams: [ENG] });
    await eventually(() => socket.messages.some((m) => m.t === 'subscribed'));
    const at = source.headId;
    const [after] = source.write({ groups: [teamGroup(ENG)] });
    await eventually(() => isLive(socket, source));

    expect(socket.story.slice(-2)).toEqual([
      { t: 'subscribed', teams: [ENG], at },
      [after?.syncId],
    ]);
    expect(socket.packets.map((p) => p.id)).not.toContain(before?.syncId);
  });

  it('drops an unknown team and a private team the user isn’t in alike (E32)', async () => {
    const source = new FakeLog();
    const h = await startHub(source);
    const socket = new FakeSocket();
    const connection = h.connect(socket, info());
    send(connection, { t: 'subscribe', teams: [UNKNOWN] });
    send(connection, { t: 'subscribe', teams: [OPS] });
    send(connection, { t: 'subscribe', teams: [DES, OPS, UNKNOWN, DES] });
    await eventually(() => socket.messages.filter((m) => m.t === 'subscribed').length === 3);
    expect(socket.messages.filter((m) => m.t === 'subscribed')).toEqual([
      { t: 'subscribed', teams: [], at: 0 },
      { t: 'subscribed', teams: [], at: 0 },
      { t: 'subscribed', teams: [DES], at: 0 },
    ]);
    const [ops] = source.write({ groups: [teamGroup(OPS)] }, { groups: ['workspace'] });
    await eventually(() => isLive(socket, source));
    expect(socket.packets.map((p) => p.id)).not.toContain(ops?.syncId);
  });

  it('waits until catch-up is done, then answers at the last packet it took in', async () => {
    const source = new FakeLog();
    source.commit(...Array.from({ length: 30 }, () => ({ groups: ['workspace'] })));
    const gate = deferred<void>();
    source.catchUpGate = gate.promise;
    const h = await startHub(source);
    const socket = new FakeSocket();
    const connection = h.connect(socket, info({ since: 0 }));
    await source.catchUpStarted.promise;
    send(connection, { t: 'subscribe', teams: [ENG] });
    // A row of ENG committed during catch-up: before `at`, so the connection never gets it.
    const [during] = source.write({ groups: [teamGroup(ENG)] });
    await new Promise((resolve) => setImmediate(resolve));
    expect(socket.messages.some((m) => m.t === 'subscribed')).toBe(false);
    gate.resolve();
    await eventually(() => socket.messages.some((m) => m.t === 'subscribed'));
    const subscribed = socket.messages.find((m) => m.t === 'subscribed');
    expect(subscribed).toEqual({ t: 'subscribed', teams: [ENG], at: during?.syncId });
    expect(socket.packets.map((p) => p.id)).not.toContain(during?.syncId);
  });

  it('handles requests in order, though the team check of an earlier one is slow', async () => {
    const source = new FakeLog();
    const pending: Deferred<string[]>[] = [];
    const slow: TeamAccess = () => {
      const answer = deferred<string[]>();
      pending.push(answer);
      return answer.promise;
    };
    const h = await startHub(source, slow);
    const socket = new FakeSocket();
    const connection = h.connect(socket, info());
    send(connection, { t: 'subscribe', teams: [ENG] });
    send(connection, { t: 'unsubscribe', teams: [ENG] });
    await eventually(() => pending.length === 1);
    // A delivery while the check runs goes out with the old groups.
    const [during, marker] = source.write({ groups: [teamGroup(ENG)] }, { groups: ['workspace'] });
    await eventually(() => isLive(socket, source));
    pending[0]?.resolve([ENG]);
    await eventually(() => socket.messages.some((m) => m.t === 'unsubscribed'));
    expect(socket.story).toEqual([
      [marker?.syncId],
      { t: 'subscribed', teams: [ENG], at: marker?.syncId },
      { t: 'unsubscribed', teams: [ENG], at: marker?.syncId },
    ]);
    expect(socket.packets.map((p) => p.id)).not.toContain(during?.syncId);
  });

  it('closes a connection that piles up requests', async () => {
    const source = new FakeLog();
    const never: TeamAccess = () => new Promise(() => undefined);
    hub = new SyncHub({ source, registry, log, teamAccess: never, maxPendingRequests: 3 });
    await hub.start();
    const socket = new FakeSocket();
    const connection = hub.connect(socket, info());
    for (let i = 0; i < 5; i++) send(connection, { t: 'subscribe', teams: [ENG] });
    await eventually(() => socket.closedWith !== undefined);
    expect(socket.closedWith).toBe(1008);
  });
});

describe('unsubscribe', () => {
  it('is answered after every earlier packet of the team, and none follows it', async () => {
    const source = new FakeLog();
    const h = await startHub(source);
    const socket = new FakeSocket();
    const connection = h.connect(socket, info({ teams: [ENG, DES] }));
    const [first, second] = source.write(
      { groups: [teamGroup(ENG)] },
      { groups: [teamGroup(ENG)] },
    );
    await eventually(() => isLive(socket, source));

    send(connection, { t: 'unsubscribe', teams: [ENG] });
    await eventually(() => socket.messages.some((m) => m.t === 'unsubscribed'));
    // A row in ENG and DES still comes, through DES; one in ENG alone doesn't.
    const [engOnly, both] = source.write(
      { groups: [teamGroup(ENG)] },
      { groups: [teamGroup(ENG), teamGroup(DES)] },
    );
    await eventually(() => isLive(socket, source));

    expect(socket.story).toEqual([
      [first?.syncId, second?.syncId],
      { t: 'unsubscribed', teams: [ENG], at: second?.syncId },
      [both?.syncId],
    ]);
    expect(socket.packets.map((p) => p.id)).not.toContain(engOnly?.syncId);
  });

  it('never drops a home group: a private team the user is in keeps coming', async () => {
    const source = new FakeLog();
    const h = await startHub(source);
    const socket = new FakeSocket();
    const connection = h.connect(socket, info({ teams: [ENG] }));
    send(connection, { t: 'unsubscribe', teams: [SEC, ENG, ENG] });
    await eventually(() => socket.messages.some((m) => m.t === 'unsubscribed'));
    const [sec] = source.write({ groups: [teamGroup(SEC)] });
    await eventually(() => isLive(socket, source));
    expect(socket.messages.find((m) => m.t === 'unsubscribed')).toEqual({
      t: 'unsubscribed',
      teams: [ENG],
      at: 0,
    });
    expect(socket.packets.map((p) => p.id)).toEqual([sec?.syncId]);
  });
});

describe('connectionGroups', () => {
  it('are the home groups plus the followed teams of the client’s open sockets', async () => {
    const source = new FakeLog();
    const h = await startHub(source);
    const clientId = randomUUID();
    const socket = new FakeSocket();
    const connection = h.connect(socket, info({ clientId, teams: [ENG] }));
    expect(h.connectionGroups(USER, clientId)).toEqual([...HOME, teamGroup(ENG)]);
    send(connection, { t: 'subscribe', teams: [DES] });
    await eventually(() => socket.messages.some((m) => m.t === 'subscribed'));
    expect(h.connectionGroups(USER, clientId)).toEqual([...HOME, teamGroup(ENG), teamGroup(DES)]);
    // Another user's socket, or another client's, is none of this client's.
    expect(h.connectionGroups(randomUUID(), clientId)).toBeUndefined();
    expect(h.connectionGroups(USER, randomUUID())).toBeUndefined();
    connection.closed();
    expect(h.connectionGroups(USER, clientId)).toBeUndefined();
  });
});

describe('the confirm point of a no-op mutation (visibleHead)', () => {
  const noop = defineOperation({
    name: 'debug.noopFixture',
    kind: 'mutation',
    domain: 'debug',
    summary: 'Change nothing (fixture)',
    description: 'Test fixture: a mutation that writes no row.',
    keywords: ['no op', 'fixture'],
    input: z.object({}),
    output: z.object({}),
    permission: (p) => p.any(),
    destructive: false,
    examples: [{}],
  });
  const actor = userActor({
    userId: USER,
    role: 'member',
    memberships: [
      { teamId: SEC, private: true },
      { teamId: ENG, private: false },
    ],
    publicTeams: [ENG, DES],
  });

  /** Runs the no-op and returns the groups `visibleHead` asked for. */
  async function headGroups(
    connectionGroups?: (userId: string, clientId: string) => readonly string[] | undefined,
  ): Promise<unknown> {
    const asked: unknown[] = [];
    const client = {
      query: (text: string, params: unknown[] = []) => {
        if (text.includes('FROM sync_log')) asked.push(params[0]);
        return Promise.resolve(
          text.includes('FROM client_mutations WHERE client_id')
            ? { rows: [{ user_id: USER, last_seq: '0', stored: null }], rowCount: 1 }
            : { rows: [], rowCount: 0 },
        );
      },
      release() {},
    };
    const executor = createExecutor({
      pool: { connect: () => Promise.resolve(client) } as unknown as Pool,
      registry: createRegistry([noop]),
      handlers: [handler(noop, () => Promise.resolve({}))],
      log,
      allowInternal: true,
      syncedModels: ['DebugItem'],
      ...(connectionGroups ? { connectionGroups } : {}),
    });
    const outcome = await executor.executeSynced('debug.noopFixture', {}, actor, {
      clientId: 'c1',
      seq: 1,
    });
    expect(outcome).toMatchObject({ kind: 'result', result: { status: 'ok' } });
    expect(asked).toHaveLength(1);
    return asked[0];
  }

  it('uses the groups of the client’s socket, never every group the user may see', async () => {
    const socketGroups = [...HOME, teamGroup(DES)];
    expect(await headGroups(() => socketGroups)).toEqual(socketGroups);
  });

  it('without a socket here, uses the member teams, as a socket that names no teams', async () => {
    const groups = await headGroups(() => undefined);
    expect(groups).toEqual([...HOME, teamGroup(ENG)]);
    // DES is public but not followed: it is visible, yet no connection receives it.
    expect(groups).not.toContain(teamGroup(DES));
    expect(await headGroups()).toEqual(groups);
  });
});
