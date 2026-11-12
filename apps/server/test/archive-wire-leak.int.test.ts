// PLAN-011 S2 leak test (SPEC-011 §5.5, AC-10, AC-18; permissions.md §5: A/V frames are filtered
// by sync groups; not held, plans README §6). Since protocol v0.7 an `A` or `V` packet carries the
// full row, so it can leak what an id-only packet couldn't. A user outside private team SEC gets
// no `A` or `V` frame for SEC's labels, in catch-up or live; a member gets them, and every `A`/`V`
// row carries only the groups its connection is in. Through the real path: the repo's `sync_log`
// and `NOTIFY`, the hub's catch-up and `LISTEN`, the delta writer, a WebSocket, and the client's
// own decoder.
import { randomUUID } from 'node:crypto';
import {
  decodeBootstrapFrame,
  decodeServerMessage,
  encodeSocketConnectParams,
  NdjsonDecoder,
  SOCKET_PATH,
  type BootstrapFrame,
  type DeltaPacket,
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
import { syncRepo, type Repo } from '../src/sync/repo.js';
import { executorHarness, type ExecutorHarness } from './executor.js';
import { actorFor, captureLogs, headerActor, testConfig } from './helpers.js';

let h: ExecutorHarness;
let app: FastifyInstance;
let hub: SyncHub;
let socketUrl: string;
let secGroup: string;
const registry = syncRegistry({ includeFixtures: true });

const eng = { id: randomUUID() };
const sec = { id: randomUUID() };
const stranger = randomUUID();
/** Rows archived and unarchived before anyone connects: they reach clients through catch-up. */
const before = {
  secLabel: randomUUID(),
  engLabel: randomUUID(),
  /** A debug item shared by everyone, SEC and another user: its groups must be cut. */
  shared: randomUUID(),
};

/** One committed transaction through the repo, as the executor runs it (flush, then COMMIT). */
async function transaction(write: (repo: Repo) => Promise<unknown>): Promise<void> {
  const client = await h.pool.connect();
  try {
    await client.query('BEGIN');
    const repo = syncRepo(drizzle({ client, casing: 'snake_case' }), new Date());
    await write(repo);
    await repo.flush({});
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const insertLabel = (repo: Repo, id: string, teamId: string, name: string) =>
  repo.insert('Label', { id, teamId, name, color: 'red' });

beforeAll(async () => {
  h = await executorHarness();
  secGroup = `team:${h.teams.sec}`;
  const engMember = actorFor({ ...eng, memberships: [{ teamId: h.teams.eng, private: false }] });
  const secMember = actorFor({ ...sec, memberships: [{ teamId: h.teams.sec, private: true }] });

  await transaction(async (repo) => {
    await insertLabel(repo, before.secLabel, h.teams.sec, 'Secret label');
    await insertLabel(repo, before.engLabel, h.teams.eng, 'Open label');
    await repo.insert('DebugItem', {
      id: before.shared,
      title: 'Shared',
      syncGroups: ['workspace', secGroup, `user:${stranger}`],
    });
  });
  // One transaction per change, so each is its own A or V in the log.
  for (const id of [before.secLabel, before.engLabel]) {
    await transaction((repo) => repo.archive('Label', id));
    await transaction((repo) => repo.unarchive('Label', id));
    await transaction((repo) => repo.archive('Label', id));
  }
  await transaction((repo) => repo.archive('DebugItem', before.shared));
  await transaction((repo) => repo.unarchive('DebugItem', before.shared));

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

type Actor = 'engMember' | 'secMember';
const userOf = (actor: Actor) => (actor === 'engMember' ? eng.id : sec.id);

/** A live WebSocket for `actor` from `since`, recording the raw text and the decoded `deltas`. */
function connect(actor: Actor, since = 0) {
  const raw: string[] = [];
  const deltas: DeltasMessage[] = [];
  const query = encodeSocketConnectParams({
    since,
    clientId: randomUUID(),
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
    text: () => raw.join('\n'),
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

async function head(): Promise<number> {
  const { rows } = await h.pool.query<{ last: string }>(
    'SELECT last_sync_id AS last FROM sync_state',
  );
  return Number(rows[0]?.last);
}

type ArchivePacket = Extract<DeltaPacket, { a: 'A' | 'V' }>;
const isArchive = (p: DeltaPacket): p is ArchivePacket => p.a === 'A' || p.a === 'V';
/** The `A`/`V` packets for `id`, as `[action, archived?, groups]`. */
const archivesOf = (packets: readonly DeltaPacket[], id: string) =>
  packets
    .filter(isArchive)
    .filter((p) => p.d.id === id)
    .map((p) => [p.a, p.d['archivedAt'] !== null, p.d['groups']]);
/** Any packet naming `id`, whatever its action. */
const mentions = (packets: readonly DeltaPacket[], id: string) =>
  packets.some((p) => (p.a === 'D' ? p.mid === id : p.a !== 'G' && p.d.id === id));

describe('catch-up of A and V packets', () => {
  it('gives a user outside SEC none for SEC’s label, and SEC’s id nowhere', async () => {
    const outsider = connect('engMember');
    try {
      const last = await head();
      await eventually(() => outsider.packets().some((p) => p.id >= last));
      const packets = outsider.packets();
      expect(mentions(packets, before.secLabel)).toBe(false);
      expect(outsider.text()).not.toContain(before.secLabel);
      expect(outsider.text()).not.toContain(h.teams.sec);
      expect(outsider.text()).not.toContain(stranger);
      // The control: the outsider does get the A/V packets it may see, with their rows.
      expect(archivesOf(packets, before.engLabel)).toEqual([
        ['A', true, ['workspace']],
        ['V', false, ['workspace']],
        ['A', true, ['workspace']],
      ]);
      expect(archivesOf(packets, before.shared)).toEqual([
        ['A', true, ['workspace']],
        ['V', false, ['workspace']],
      ]);
    } finally {
      outsider.close();
    }
  });

  it('gives SEC’s member SEC’s label, each row with only the groups the member is in', async () => {
    const member = connect('secMember');
    try {
      const last = await head();
      await eventually(() => member.packets().some((p) => p.id >= last));
      const packets = member.packets();
      expect(archivesOf(packets, before.secLabel)).toEqual([
        ['A', true, [secGroup]],
        ['V', false, [secGroup]],
        ['A', true, [secGroup]],
      ]);
      expect(archivesOf(packets, before.shared)).toEqual([
        ['A', true, ['workspace', secGroup]],
        ['V', false, ['workspace', secGroup]],
      ]);
      expect(member.text()).not.toContain(stranger);
    } finally {
      member.close();
    }
  });
});

describe('live A and V packets', () => {
  it('reach SEC’s member for SEC’s label, and a user outside SEC never', async () => {
    const at = await head();
    const outsider = connect('engMember', at);
    const member = connect('secMember', at);
    try {
      // Both live: a row everyone sees has reached them.
      const ready = randomUUID();
      await transaction((repo) =>
        repo.insert('DebugItem', { id: ready, title: 'Ready', syncGroups: ['workspace'] }),
      );
      await eventually(() => outsider.text().includes(ready) && member.text().includes(ready));
      const fromOutsider = outsider.packets().length;
      const fromMember = member.packets().length;

      const secLabel = randomUUID();
      const engLabel = randomUUID();
      const shared = randomUUID();
      await transaction(async (repo) => {
        await insertLabel(repo, secLabel, h.teams.sec, 'Live secret label');
        await insertLabel(repo, engLabel, h.teams.eng, 'Live open label');
        await repo.insert('DebugItem', {
          id: shared,
          title: 'Live shared',
          syncGroups: ['workspace', secGroup, `user:${stranger}`],
        });
      });
      for (const write of [
        (repo: Repo) => repo.archive('Label', secLabel),
        (repo: Repo) => repo.archive('Label', engLabel),
        (repo: Repo) => repo.archive('DebugItem', shared),
        (repo: Repo) => repo.unarchive('Label', secLabel),
        (repo: Repo) => repo.unarchive('Label', engLabel),
        (repo: Repo) => repo.unarchive('DebugItem', shared),
      ]) {
        await transaction(write);
      }
      // Written last: once it arrives, anything earlier would have arrived too.
      const marker = randomUUID();
      await transaction((repo) =>
        repo.insert('DebugItem', { id: marker, title: 'Marker', syncGroups: ['workspace'] }),
      );
      await eventually(() => outsider.text().includes(marker) && member.text().includes(marker));

      const outsiderLive = outsider.packets().slice(fromOutsider);
      expect(mentions(outsiderLive, secLabel)).toBe(false);
      expect(outsider.text()).not.toContain(secLabel);
      expect(outsider.text()).not.toContain(h.teams.sec);
      expect(outsider.text()).not.toContain(stranger);
      expect(archivesOf(outsiderLive, engLabel)).toEqual([
        ['A', true, ['workspace']],
        ['V', false, ['workspace']],
      ]);
      expect(archivesOf(outsiderLive, shared)).toEqual([
        ['A', true, ['workspace']],
        ['V', false, ['workspace']],
      ]);

      const memberLive = member.packets().slice(fromMember);
      expect(archivesOf(memberLive, secLabel)).toEqual([
        ['A', true, [secGroup]],
        ['V', false, [secGroup]],
      ]);
      expect(archivesOf(memberLive, shared)).toEqual([
        ['A', true, ['workspace', secGroup]],
        ['V', false, ['workspace', secGroup]],
      ]);
      expect(member.text()).not.toContain(stranger);
    } finally {
      outsider.close();
      member.close();
    }
  });
});

describe('bootstrap of archived labels', () => {
  async function rows(actor: Actor) {
    const res = await app.inject({
      url: `/sync/bootstrap?userId=${userOf(actor)}`,
      headers: { 'x-test-actor': actor },
    });
    expect(res.statusCode).toBe(200);
    const decoder = new NdjsonDecoder();
    return [...decoder.push(new Uint8Array(res.rawPayload)), ...decoder.end()]
      .map(decodeBootstrapFrame)
      .filter((f): f is Extract<BootstrapFrame, { t: 'row' }> => f.t === 'row');
  }

  it('sends the frame flag equal to archivedAt, and SEC’s archived label only to its member', async () => {
    const outsider = await rows('engMember');
    expect(JSON.stringify(outsider)).not.toContain(before.secLabel);
    expect(JSON.stringify(outsider)).not.toContain(h.teams.sec);
    const member = await rows('secMember');
    const label = member.find((r) => r.m === 'Label' && r.d.id === before.secLabel);
    expect(label).toMatchObject({ archived: true, d: { groups: [secGroup] } });
    expect(typeof label?.d['archivedAt']).toBe('string');
    for (const row of [...outsider, ...member].filter((r) => r.m === 'Label')) {
      expect(row.archived === true, row.d.id).toBe(row.d['archivedAt'] !== null);
    }
  });
});
