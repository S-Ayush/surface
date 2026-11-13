// SPEC-002 AC-11, permissions.md §5 item 1: a client without a private team's group receives none
// of its rows (bootstrap, catch-up and live deltas), and a row shared with that team reaches it
// without the team's id (Q6). Decoded with the client's own codecs, so this is also the wire
// contract with `@surface/sync-client`. Live deltas go through the real path: the repo's
// `NOTIFY`, the hub's `LISTEN`, and a WebSocket. Not held: a private-team leak test.
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  decodeBootstrapFrame,
  decodeServerMessage,
  encodeSocketConnectParams,
  NdjsonDecoder,
  NDJSON_CONTENT_TYPE,
  SOCKET_PATH,
  type BootstrapFrame,
  type DeltasMessage,
} from '@surface/sync-protocol';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { Lifecycle } from '../src/lifecycle.js';
import { createLogger } from '../src/logger.js';
import { pgSyncLogSource } from '../src/sync/hub-source.js';
import { SyncHub } from '../src/sync/hub.js';
import { syncRegistry } from '../src/sync/registry.js';
import { syncRepo, type ChangeOrigin, type Repo } from '../src/sync/repo.js';
import { executorHarness, type ExecutorHarness } from './executor.js';
import { actorFor, captureLogs, headerActor, testConfig } from './helpers.js';

let h: ExecutorHarness;
let app: FastifyInstance;
let hub: SyncHub;
let socketUrl: string;
/** Each actor's sync groups, as the hub sees them. */
let groupsOf: Record<'engMember' | 'secMember', string[]>;
const registry = syncRegistry({ includeFixtures: true });

const eng = { id: randomUUID() };
const sec = { id: randomUUID() };
const other = randomUUID();
const ids = {
  open: randomUUID(),
  secret: randomUUID(),
  shared: randomUUID(),
  mine: randomUUID(),
  someoneElses: randomUUID(),
  archived: randomUUID(),
  fillers: Array.from({ length: 6 }, () => randomUUID()),
};
/** The engineering member's client: its mutation on a private-team row is acked, never shown. */
const engClient = randomUUID();

/** One committed transaction through the repo, as the executor runs it (flush, then COMMIT). */
async function transaction(write: (repo: Repo) => Promise<unknown>, origin: ChangeOrigin = {}) {
  const client = await h.pool.connect();
  try {
    await client.query('BEGIN');
    const repo = syncRepo(drizzle({ client, casing: 'snake_case' }), new Date());
    await write(repo);
    await repo.flush(origin);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  h = await executorHarness();
  const team = `team:${h.teams.sec}`;
  const engMember = actorFor({ ...eng, memberships: [{ teamId: h.teams.eng, private: false }] });
  const secMember = actorFor({ ...sec, memberships: [{ teamId: h.teams.sec, private: true }] });
  groupsOf = { engMember: [...engMember.groups], secMember: [...secMember.groups] };

  await transaction(async (repo) => {
    const seed = (id: string, title: string, syncGroups: string[]) =>
      repo.insert('DebugItem', { id, title, syncGroups });
    await seed(ids.open, 'Open', ['workspace']);
    await seed(ids.secret, 'Secret', [team]);
    await seed(ids.shared, 'Shared', ['workspace', team]);
    await seed(ids.mine, 'Mine', [`user:${eng.id}`]);
    await seed(ids.someoneElses, 'Not mine', [`user:${other}`]);
    await seed(ids.archived, 'Archived', ['workspace']);
    // More than ten log rows, so catch-up must order sync ids as numbers ("10" < "9" as text).
    for (const filler of ids.fillers) await seed(filler, 'Filler', ['workspace']);
    await repo.archive('DebugItem', ids.archived);
  });
  // The engineering member's own mutation, which touched only a private-team row.
  await transaction((repo) => repo.update('DebugItem', ids.secret, { title: 'Secret 2' }), {
    clientId: engClient,
    seq: 1,
  });

  const config = testConfig();
  const lifecycle = new Lifecycle();
  const logger = createLogger(config, captureLogs().stream);
  hub = new SyncHub({
    source: pgSyncLogSource({
      pool: h.pool,
      listenClient: () => new pg.Client({ connectionString: h.db.url }),
    }),
    registry,
    log: logger,
  });
  app = await buildApp({
    config,
    lifecycle,
    logger,
    sync: { pool: h.pool, registry, resolveActor: headerActor({ engMember, secMember }), hub },
  });
  await hub.start();
  lifecycle.markReady();
  socketUrl = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws');
});
afterAll(async () => {
  await hub.stop();
  await app.close();
  await h.close();
});

/** The user each test actor signs in as: their own replica (SPEC-002 E14). */
function userOf(actor: string): string {
  if (actor === 'engMember') return eng.id;
  if (actor === 'secMember') return sec.id;
  throw new Error(`no test actor ${actor}`);
}

interface Bootstrap {
  meta: Extract<BootstrapFrame, { t: 'meta' }>;
  rows: Extract<BootstrapFrame, { t: 'row' }>[];
  end: Extract<BootstrapFrame, { t: 'end' }>;
}

/** One bootstrap through HTTP, decoded and validated frame by frame like the client does. */
async function bootstrap(actor: string, gzip = false): Promise<Bootstrap> {
  const res = await app.inject({
    url: `/sync/bootstrap?userId=${userOf(actor)}`,
    headers: { 'x-test-actor': actor, ...(gzip ? { 'accept-encoding': 'gzip' } : {}) },
  });
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-type']).toBe(NDJSON_CONTENT_TYPE);
  expect(res.headers['content-encoding']).toBe(gzip ? 'gzip' : undefined);
  const body = gzip ? gunzipSync(res.rawPayload) : res.rawPayload;
  const decoder = new NdjsonDecoder();
  const frames = [...decoder.push(new Uint8Array(body)), ...decoder.end()].map(
    decodeBootstrapFrame,
  );
  const [meta, ...rest] = frames;
  const end = rest.pop();
  if (meta?.t !== 'meta' || end?.t !== 'end') throw new Error('bootstrap without meta or end');
  const rows = rest.filter((f) => f.t === 'row');
  expect(rows).toHaveLength(rest.length);
  return { meta, rows, end };
}

/** The debug items in a bootstrap by id. The harness's teams arrive too; team-groups covers them. */
const byId = (b: Bootstrap) =>
  new Map(b.rows.filter((r) => r.m === 'DebugItem').map((r) => [r.d.id, r]));

describe('bootstrap for a user outside private team X', () => {
  it('contains none of X’s rows, nor another user’s', async () => {
    const got = byId(await bootstrap('engMember'));
    expect([...got.keys()].sort()).toEqual(
      [ids.open, ids.shared, ids.mine, ids.archived, ...ids.fillers].sort(),
    );
  });

  it("sends a row shared with X without X's group", async () => {
    const shared = byId(await bootstrap('engMember')).get(ids.shared);
    expect(shared?.d['groups']).toEqual(['workspace']);
  });

  it('lists only its own groups in meta, with its member teams', async () => {
    const { meta } = await bootstrap('engMember');
    // SPEC-011 §5.7: the full bootstrap covers every member team, public ones too (PLAN-011 S4b).
    expect(meta.groups).toEqual(['workspace', `user:${eng.id}`, `team:${h.teams.eng}`]);
  });
});

describe('bootstrap for a member of private team X', () => {
  it('contains X’s rows, with X’s group on them', async () => {
    const got = byId(await bootstrap('secMember'));
    const team = `team:${h.teams.sec}`;
    expect([...got.keys()].sort()).toEqual(
      [ids.open, ids.secret, ids.shared, ids.archived, ...ids.fillers].sort(),
    );
    expect(got.get(ids.shared)?.d['groups']).toEqual(['workspace', team]);
  });
});

describe('a bootstrap stream', () => {
  it('counts its rows in meta and end, and is consistent with sync_state', async () => {
    const { meta, rows, end } = await bootstrap('engMember');
    const { rows: state } = await h.pool.query<{ last: string }>(
      'SELECT last_sync_id AS last FROM sync_state',
    );
    expect([meta.rows, end.rows]).toEqual([rows.length, rows.length]);
    expect(meta.lastSyncId).toBe(Number(state[0]?.last));
    expect(meta.schemaHash).toBe(registry.schemaHash);
  });

  it('holds rows the client model accepts, archived ones marked', async () => {
    const { rows } = await bootstrap('engMember');
    for (const row of rows) {
      const model = registry.models.find((m) => m.name === row.m);
      expect(model?.def.rowSchema.parse(row.d)).toEqual(row.d);
    }
    const archived = rows.filter((r) => r.archived === true).map((r) => r.d.id);
    expect(archived).toEqual([ids.archived]);
  });

  it('is the same when gzipped', async () => {
    const plain = await bootstrap('engMember');
    const zipped = await bootstrap('engMember', true);
    expect(zipped.rows).toEqual(plain.rows);
  });

  it('leaves no transaction open afterwards', async () => {
    await bootstrap('engMember');
    const { rows } = await h.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND state LIKE 'idle in transaction%'`,
    );
    expect(rows[0]?.n).toBe(0);
  });
});

/** A live WebSocket for `actor`, recording the raw text and the decoded `deltas`. */
function connect(actor: string, clientId: string = randomUUID(), since = 0) {
  const raw: string[] = [];
  const deltas: DeltasMessage[] = [];
  const query = encodeSocketConnectParams({
    since,
    clientId,
    userId: userOf(actor),
    schemaHash: registry.schemaHash,
  });
  const socket = new WebSocket(`${socketUrl}${SOCKET_PATH}?${query}`, {
    headers: { 'x-test-actor': actor },
  });
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') throw new Error('binary frame');
    raw.push(event.data);
    const message = decodeServerMessage(event.data);
    if (message.t === 'deltas') deltas.push(message);
  });
  return {
    raw,
    deltas,
    packets: () => deltas.flatMap((m) => m.packets),
    close: () => socket.close(),
  };
}

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in 5 s');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** Sync ids of the log rows a connection with `groups` may see. */
async function visibleIds(groups: string[]): Promise<number[]> {
  const { rows } = await h.pool.query<{ id: string }>(
    'SELECT sync_id::text AS id FROM sync_log WHERE groups && $1::text[] ORDER BY sync_id',
    [groups],
  );
  return rows.map((r) => Number(r.id));
}

describe('catch-up for a user outside private team X', () => {
  it("contains none of X's rows nor another user's, and acks its own mutation on one", async () => {
    const expected = await visibleIds(groupsOf.engMember);
    const socket = connect('engMember', engClient);
    try {
      await eventually(() => socket.deltas.some((m) => m.ack.length > 0));
      expect(socket.packets().map((p) => p.id)).toEqual(expected);
      const rowIds = socket
        .packets()
        .map((p) => (p.a === 'I' || p.a === 'U' ? p.d.id : 'mid' in p ? p.mid : ''));
      expect(rowIds).not.toContain(ids.secret);
      expect(rowIds).not.toContain(ids.someoneElses);
      expect(socket.raw.join('\n')).not.toContain(h.teams.sec);
      expect(socket.deltas.flatMap((m) => m.ack)).toEqual([{ clientId: engClient, seq: 1 }]);
    } finally {
      socket.close();
    }
  });
});

describe('live deltas', () => {
  it("reach a member of X with X's rows, and a user outside X without them or X's id", async () => {
    const outsider = connect('engMember');
    const member = connect('secMember');
    try {
      // Both must have caught up before the writes, or a socket still catching up would count
      // the new rows as catch-up, and the slices below would compare the wrong packets.
      const outsiderHead = (await visibleIds(groupsOf.engMember)).at(-1);
      const memberHead = (await visibleIds(groupsOf.secMember)).at(-1);
      await eventually(() => outsider.packets().at(-1)?.id === outsiderHead);
      await eventually(() => member.packets().at(-1)?.id === memberHead);
      const fromOutsider = outsider.packets().length;
      const fromMember = member.packets().length;

      const team = `team:${h.teams.sec}`;
      const secretId = randomUUID();
      const sharedId = randomUUID();
      const markerId = randomUUID();
      await transaction((repo) =>
        repo.insert('DebugItem', { id: secretId, title: 'Live secret', syncGroups: [team] }),
      );
      await transaction((repo) =>
        repo.insert('DebugItem', {
          id: sharedId,
          title: 'Live shared',
          syncGroups: ['workspace', team],
        }),
      );
      // Written last: once it arrives, anything earlier would have arrived too.
      await transaction((repo) =>
        repo.insert('DebugItem', { id: markerId, title: 'Marker', syncGroups: ['workspace'] }),
      );

      const rowId = (p: { a: string; d?: { id: string } }) => p.d?.id;
      await eventually(() => outsider.packets().some((p) => rowId(p) === markerId));
      await eventually(() => member.packets().some((p) => rowId(p) === markerId));

      const outsiderLive = outsider.packets().slice(fromOutsider);
      expect(outsiderLive.map(rowId)).toEqual([sharedId, markerId]);
      expect(outsiderLive[0]).toMatchObject({ a: 'I', d: { groups: ['workspace'] } });
      expect(outsider.raw.join('\n')).not.toContain(h.teams.sec);

      const memberLive = member.packets().slice(fromMember);
      expect(memberLive.map(rowId)).toEqual([secretId, sharedId, markerId]);
      expect(memberLive[1]).toMatchObject({ d: { groups: ['workspace', team] } });
    } finally {
      outsider.close();
      member.close();
    }
  });
});

// PLAN-001 S9, security review M1 (permissions.md §5 item 6): the hub reads a connection's groups
// once, when it opens. A member removed from X while connected must get `resync(groups)` and none
// of X's later rows, through the real path (repo `NOTIFY`, hub `LISTEN`, WebSocket).
describe('a member removed from private team X while connected', () => {
  it("is told to resync, and receives none of X's later rows", async () => {
    const team = `team:${h.teams.sec}`;
    const membershipId = randomUUID();
    await ensureUser(sec.id, 'sec');
    await transaction(async (repo) => {
      await repo.insert('TeamMembership', {
        id: membershipId,
        teamId: h.teams.sec,
        userId: sec.id,
        syncGroups: [],
      });
    });
    // Connected after joining, as their client is once it has bootstrapped: catching up across
    // the join would resync (the next describe).
    const joinedAt = await head();
    const outsider = connect('engMember');
    const member = connect('secMember', randomUUID(), joinedAt);
    try {
      // Both live: a row everyone sees has reached them.
      const readyId = randomUUID();
      await transaction((repo) =>
        repo.insert('DebugItem', { id: readyId, title: 'Ready', syncGroups: ['workspace'] }),
      );
      await eventually(
        () => member.raw.join('\n').includes(readyId) && outsider.raw.join('\n').includes(readyId),
      );
      expect(member.raw.join('\n')).not.toContain('"resync"');

      const secretId = randomUUID();
      const markerId = randomUUID();
      // As `team.removeMember` does it, then X changes, then a row everyone sees.
      await transaction((repo) => repo.purge('TeamMembership', membershipId));
      await transaction((repo) =>
        repo.insert('DebugItem', { id: secretId, title: 'After removal', syncGroups: [team] }),
      );
      await transaction((repo) =>
        repo.insert('DebugItem', { id: markerId, title: 'Marker', syncGroups: ['workspace'] }),
      );
      await eventually(() =>
        outsider.packets().some((p) => (p.a === 'I' || p.a === 'U') && p.d.id === markerId),
      );

      const after = member.raw.slice(member.raw.findIndex((text) => text.includes('"resync"')));
      expect(after.map((text) => decodeServerMessage(text))).toEqual([
        { t: 'resync', reason: 'groups' },
      ]);
      expect(member.raw.join('\n')).not.toContain(secretId);
      expect(member.raw.join('\n')).not.toContain(markerId);
    } finally {
      outsider.close();
      member.close();
    }
  });
});

/** The log's head now. */
async function head(): Promise<number> {
  const { rows } = await h.pool.query<{ id: string }>(
    'SELECT COALESCE(max(sync_id), 0)::text AS id FROM sync_log',
  );
  return Number(rows[0]?.id ?? 0);
}

/** A `User` row for `id`, once: several tests here need one for their memberships. */
async function ensureUser(id: string, name: string): Promise<void> {
  const { rows } = await h.pool.query('SELECT 1 FROM users WHERE id = $1', [id]);
  if (rows.length > 0) return;
  await transaction((repo) =>
    repo.insert('User', {
      id,
      email: `${name}@example.com`,
      name,
      displayName: name,
      syncGroups: [],
    }),
  );
}

/** Waits until `socket` received something, then one more turn for anything after it. */
async function settled(socket: { raw: string[] }): Promise<void> {
  await eventually(() => socket.raw.length > 0);
  await new Promise((resolve) => setImmediate(resolve));
}

// PLAN-001 S9 review: membership changes while the socket was closed (a laptop asleep, a reconnect
// backoff, a deploy). Catch-up is filtered by the groups read at reconnect, so a removal is
// invisible to the removed user and a join comes after rows the replica never had.
describe('a client reconnecting after a private team membership changed while it was away', () => {
  it("is told to resync after being removed from X, though it can't see the deletion", async () => {
    const leaver = randomUUID();
    await ensureUser(leaver, 'leaver');
    const membershipId = randomUUID();
    await transaction((repo) =>
      repo.insert('TeamMembership', {
        id: membershipId,
        teamId: h.teams.sec,
        userId: leaver,
        syncGroups: [],
      }),
    );
    const before = await head();
    await transaction((repo) => repo.purge('TeamMembership', membershipId));
    const after = await head();
    // `engMember`'s groups lack X, as a removed member's do once read again.
    const away = connect('engMember', randomUUID(), before);
    const caughtUp = connect('engMember', randomUUID(), after);
    try {
      await settled(away);
      expect(away.raw.map((text) => decodeServerMessage(text))).toEqual([
        { t: 'resync', reason: 'groups' },
      ]);
      // Past the deletion there is nothing of X to drop: an ordinary live row arrives.
      const markerId = randomUUID();
      await transaction((repo) =>
        repo.insert('DebugItem', { id: markerId, title: 'Marker', syncGroups: ['workspace'] }),
      );
      await eventually(() => caughtUp.raw.join('\n').includes(markerId));
      expect(caughtUp.raw.join('\n')).not.toContain('"resync"');
    } finally {
      away.close();
      caughtUp.close();
    }
  });

  it('is not told to resync when a public team lost a member meanwhile', async () => {
    const leaver = randomUUID();
    await ensureUser(leaver, 'public-leaver');
    const membershipId = randomUUID();
    await transaction((repo) =>
      repo.insert('TeamMembership', {
        id: membershipId,
        teamId: h.teams.eng,
        userId: leaver,
        syncGroups: [],
      }),
    );
    const before = await head();
    await transaction((repo) => repo.purge('TeamMembership', membershipId));
    const away = connect('engMember', randomUUID(), before);
    try {
      const markerId = randomUUID();
      await transaction((repo) =>
        repo.insert('DebugItem', { id: markerId, title: 'Marker', syncGroups: ['workspace'] }),
      );
      await eventually(() => away.raw.join('\n').includes(markerId));
      expect(away.raw.join('\n')).not.toContain('"resync"');
    } finally {
      away.close();
    }
  });

  it("is told to resync after joining X, since its replica lacks X's earlier rows", async () => {
    await ensureUser(sec.id, 'sec');
    const before = await head();
    await transaction((repo) =>
      repo.insert('TeamMembership', {
        id: randomUUID(),
        teamId: h.teams.sec,
        userId: sec.id,
        syncGroups: [],
      }),
    );
    // `secMember`'s groups have X, as a new member's do once read again.
    const joined = connect('secMember', randomUUID(), before);
    try {
      await settled(joined);
      expect(joined.raw.map((text) => decodeServerMessage(text))).toEqual([
        { t: 'resync', reason: 'groups' },
      ]);
    } finally {
      joined.close();
    }
  });
});
