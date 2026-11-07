// SPEC-002 AC-11 (bootstrap part; catch-up and live come with S4), permissions.md §5 item 1:
// a client without a private team's group receives none of its rows, and a row shared with that
// team reaches it without the team's id (Q6). Decoded with the client's own codecs, so this is
// also the wire contract with `@surface/sync-client`. Not held: a private-team leak test.
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  decodeBootstrapFrame,
  NdjsonDecoder,
  NDJSON_CONTENT_TYPE,
  type BootstrapFrame,
} from '@surface/sync-protocol';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { Lifecycle } from '../src/lifecycle.js';
import { createLogger } from '../src/logger.js';
import { syncRegistry } from '../src/sync/registry.js';
import { syncRepo } from '../src/sync/repo.js';
import { executorHarness, type ExecutorHarness } from './executor.js';
import { actorFor, captureLogs, headerActor, testConfig } from './helpers.js';

let h: ExecutorHarness;
let app: FastifyInstance;
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
};

beforeAll(async () => {
  h = await executorHarness();
  const team = `team:${h.teams.sec}`;
  const engMember = actorFor({ ...eng, memberships: [{ teamId: h.teams.eng, private: false }] });
  const secMember = actorFor({ ...sec, memberships: [{ teamId: h.teams.sec, private: true }] });

  const client = await h.pool.connect();
  try {
    await client.query('BEGIN');
    const repo = syncRepo(drizzle({ client, casing: 'snake_case' }), new Date());
    const seed = (id: string, title: string, syncGroups: string[]) =>
      repo.insert('DebugItem', { id, title, syncGroups });
    await seed(ids.open, 'Open', ['workspace']);
    await seed(ids.secret, 'Secret', [team]);
    await seed(ids.shared, 'Shared', ['workspace', team]);
    await seed(ids.mine, 'Mine', [`user:${eng.id}`]);
    await seed(ids.someoneElses, 'Not mine', [`user:${other}`]);
    await seed(ids.archived, 'Archived', ['workspace']);
    await repo.archive('DebugItem', ids.archived);
    await repo.flush({});
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  const config = testConfig();
  const lifecycle = new Lifecycle();
  app = await buildApp({
    config,
    lifecycle,
    logger: createLogger(config, captureLogs().stream),
    sync: { pool: h.pool, registry, resolveActor: headerActor({ engMember, secMember }) },
  });
  lifecycle.markReady();
});
afterAll(async () => {
  await app.close();
  await h.close();
});

interface Bootstrap {
  meta: Extract<BootstrapFrame, { t: 'meta' }>;
  rows: Extract<BootstrapFrame, { t: 'row' }>[];
  end: Extract<BootstrapFrame, { t: 'end' }>;
}

/** One bootstrap through HTTP, decoded and validated frame by frame like the client does. */
async function bootstrap(actor: string, gzip = false): Promise<Bootstrap> {
  const res = await app.inject({
    url: '/sync/bootstrap',
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
    expect([...got.keys()].sort()).toEqual([ids.open, ids.shared, ids.mine, ids.archived].sort());
  });

  it("sends a row shared with X without X's group", async () => {
    const shared = byId(await bootstrap('engMember')).get(ids.shared);
    expect(shared?.d['groups']).toEqual(['workspace']);
  });

  it('lists only its own groups in meta', async () => {
    const { meta } = await bootstrap('engMember');
    expect(meta.groups).toEqual(['workspace', `user:${eng.id}`]);
  });
});

describe('bootstrap for a member of private team X', () => {
  it('contains X’s rows, with X’s group on them', async () => {
    const got = byId(await bootstrap('secMember'));
    const team = `team:${h.teams.sec}`;
    expect([...got.keys()].sort()).toEqual([ids.open, ids.secret, ids.shared, ids.archived].sort());
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
