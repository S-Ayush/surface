// PLAN-012 S5 leak test (SPEC-012 §4.3, §5, AC-3; permissions.md §5 "Drafts"; not held, plans
// README §6). A draft is in its owner's `user:<id>` group only:
// - another user never gets it, in bootstrap, catch-up or live deltas, nor its team, issue or text;
// - discarding the same key as another user deletes nothing of the owner's;
// - a draft for private team SEC, kept after its owner left SEC, holds only what the owner sent:
//   its row carries no SEC group and nothing of SEC beyond the id the owner had, and SEC's other
//   member never gets it;
// - the executor's logs hold no draft text, saved or refused (CLAUDE.md rule 6).
// Through the real path: the executor, the repo's `sync_log` and `NOTIFY`, the hub's catch-up and
// `LISTEN`, the delta writer, a WebSocket, the bootstrap route, and the client's decoders.
//
// Mutation-checked (PLAN-012 S5 "As built"): with `Draft.groupsOf` adding `workspace`, the
// catch-up, live, bootstrap and left-SEC tests fail; adding the draft's `team:<teamId>`, the
// left-SEC test fails (SEC's other member gets the draft).
import { randomUUID } from 'node:crypto';
import type { Actor } from '@surface/domain';
import { EMPTY_COMPOSER_DRAFT } from '@surface/domain/model';
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
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { Executor } from '../src/executor/execute.js';
import { Lifecycle } from '../src/lifecycle.js';
import { createLogger } from '../src/logger.js';
import { pgSyncLogSource } from '../src/sync/hub-source.js';
import { SyncHub } from '../src/sync/hub.js';
import { syncRegistry } from '../src/sync/registry.js';
import { syncRepo, type Repo } from '../src/sync/repo.js';
import { executorHarness, testExecutor, type ExecutorHarness } from './executor.js';
import { actorFor, captureLogs, headerActor, testConfig } from './helpers.js';

let h: ExecutorHarness;
let app: FastifyInstance;
let hub: SyncHub;
let executor: Executor;
let socketUrl: string;
const registry = syncRegistry({ includeFixtures: true });

const ana = randomUUID(); // member of ENG and of private SEC, until she leaves SEC
const bob = randomUUID(); // member of ENG only
const sam = randomUUID(); // member of SEC, stays
let anaMembership: string;
/** The log's head once the memberships are written: a catch-up from 0 would resync on them. */
let afterSetup = 0;
const actors: Record<string, Actor> = {};
const ISSUE = randomUUID(); // a comment draft's issue: never resolved, so it needn't exist

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

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** Ana's drafts before anyone connects: they reach clients through catch-up and bootstrap. */
const before = {
  secTitle: 'Rotate the SEC signing keys',
  commentText: 'Secret comment text',
};
let secDraftId = '';
let commentDraftId = '';

async function save(actor: string, input: unknown): Promise<Record<string, unknown>> {
  const result = await executor.execute('draft.save', input, actors[actor] ?? actorFor({ id: '' }));
  if (!result.ok) throw new Error(`draft.save failed: ${result.error.message}`);
  const output: unknown = result.result;
  if (typeof output !== 'object' || output === null) throw new Error('no output');
  return Object.fromEntries(Object.entries(output));
}

beforeAll(async () => {
  h = await executorHarness();
  executor = testExecutor(h.pool).executor;
  anaMembership = randomUUID();
  await transaction(async (repo) => {
    for (const [id, name] of [
      [ana, 'ana'],
      [bob, 'bob'],
      [sam, 'sam'],
    ] as const) {
      await repo.insert('User', { id, email: `${name}@example.com`, name, displayName: name });
    }
    await repo.insert('TeamMembership', { id: anaMembership, teamId: h.teams.sec, userId: ana });
    await repo.insert('TeamMembership', { id: randomUUID(), teamId: h.teams.eng, userId: ana });
    await repo.insert('TeamMembership', { id: randomUUID(), teamId: h.teams.eng, userId: bob });
    await repo.insert('TeamMembership', { id: randomUUID(), teamId: h.teams.sec, userId: sam });
  });
  afterSetup = await head();
  const eng = { teamId: h.teams.eng, private: false };
  const sec = { teamId: h.teams.sec, private: true };
  actors['ana'] = actorFor({ id: ana, memberships: [eng, sec] });
  actors['anaLeft'] = actorFor({ id: ana, memberships: [eng] });
  actors['bob'] = actorFor({ id: bob, memberships: [eng] });
  actors['sam'] = actorFor({ id: sam, memberships: [sec] });

  const secDraft = await save('ana', {
    id: '0192f0c1-7e5a-7b3c-9d4e-00000000a001',
    kind: 'composer',
    teamId: h.teams.sec,
    data: { ...EMPTY_COMPOSER_DRAFT, title: before.secTitle, priority: 1 },
  });
  secDraftId = String(secDraft['id']);
  const comment = await save('ana', {
    kind: 'comment',
    issueId: ISSUE,
    data: { text: doc(before.commentText) },
  });
  commentDraftId = String(comment['id']);

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
    sync: { pool: h.pool, registry, resolveActor: headerActor(actors), hub },
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

const userOf = (actor: string) => actors[actor]?.userId ?? '';

/** A live WebSocket for `actor` from `since`, recording the raw text and the decoded `deltas`. */
function connect(actor: string, since = 0) {
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

type RowPacket = Exclude<DeltaPacket, { readonly a: 'G' }>;

const draftPackets = (packets: readonly DeltaPacket[]): RowPacket[] =>
  packets.filter((p): p is RowPacket => p.a !== 'G' && p.m === 'Draft');

async function bootstrapRows(actor: string) {
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

/** A marker only the given users see, written last: once it arrives, anything earlier has. */
async function markFor(...userIds: string[]): Promise<string> {
  const marker = randomUUID();
  await transaction((repo) =>
    repo.insert('DebugItem', {
      id: marker,
      title: 'Marker',
      syncGroups: userIds.map((id) => `user:${id}`),
    }),
  );
  return marker;
}

describe('catch-up', () => {
  it('gives another user none of ana’s drafts, their team, issue or text', async () => {
    // Both see the marker, written after the drafts: catch-up has passed them once it arrives.
    const marker = await markFor(ana, bob);
    const outsider = connect('bob', afterSetup);
    const owner = connect('ana', afterSetup);
    try {
      await eventually(() => outsider.text().includes(marker) && owner.text().includes(marker));
      expect(draftPackets(outsider.packets())).toEqual([]);
      for (const secret of [
        secDraftId,
        commentDraftId,
        before.secTitle,
        before.commentText,
        ISSUE,
      ]) {
        expect(outsider.text()).not.toContain(secret);
      }
      // The control: the owner gets both, in her own group only.
      const mine = draftPackets(owner.packets());
      expect(mine.map((p) => (p.a === 'D' ? p.mid : p.d.id)).sort()).toEqual(
        [secDraftId, commentDraftId].sort(),
      );
      for (const p of mine) {
        if (p.a !== 'D') expect(p.d['groups'] ?? [`user:${ana}`]).toEqual([`user:${ana}`]);
      }
    } finally {
      outsider.close();
      owner.close();
    }
  });
});

describe('live deltas', () => {
  it('reach the owner’s other connection on save, update and discard, and nobody else', async () => {
    const at = await head();
    const outsider = connect('bob', at);
    const teammate = connect('sam', at);
    const owner = connect('ana', at);
    try {
      const ready = await markFor(ana, bob, sam);
      await eventually(() => [outsider, teammate, owner].every((c) => c.text().includes(ready)));
      const title = `Live draft ${randomUUID()}`;
      const saved = await save('ana', {
        kind: 'composer',
        teamId: h.teams.eng,
        data: { ...EMPTY_COMPOSER_DRAFT, title },
      });
      await save('ana', {
        kind: 'composer',
        teamId: h.teams.eng,
        data: { ...EMPTY_COMPOSER_DRAFT, title: `${title} (edited)` },
      });
      const discarded = await executor.execute(
        'draft.discard',
        { kind: 'composer', teamId: h.teams.eng },
        actors['ana'] ?? actorFor({ id: '' }),
      );
      expect(discarded).toMatchObject({ ok: true, result: { discarded: true } });
      const marker = await markFor(ana, bob, sam);
      await eventually(() => [outsider, teammate, owner].every((c) => c.text().includes(marker)));

      for (const other of [outsider, teammate]) {
        expect(draftPackets(other.packets())).toEqual([]);
        expect(other.text()).not.toContain(String(saved['id']));
        expect(other.text()).not.toContain(title);
      }
      expect(draftPackets(owner.packets()).map((p) => p.a)).toEqual(['I', 'U', 'D']);
    } finally {
      outsider.close();
      teammate.close();
      owner.close();
    }
  });

  it('discarding the same key as another user deletes nothing of the owner’s', async () => {
    const result = await executor.execute(
      'draft.discard',
      { kind: 'composer', teamId: h.teams.sec },
      actors['bob'] ?? actorFor({ id: '' }),
    );
    expect(result).toMatchObject({ ok: true, result: { discarded: false } });
    const { rows } = await h.pool.query('SELECT id FROM drafts WHERE id = $1', [secDraftId]);
    expect(rows).toHaveLength(1);
  });
});

describe('bootstrap', () => {
  it('holds only the user’s own drafts', async () => {
    const outsider = await bootstrapRows('bob');
    expect(outsider.filter((r) => r.m === 'Draft')).toEqual([]);
    const text = JSON.stringify(outsider);
    for (const secret of [secDraftId, commentDraftId, before.secTitle, before.commentText]) {
      expect(text).not.toContain(secret);
    }
    const owner = await bootstrapRows('ana');
    expect(
      owner
        .filter((r) => r.m === 'Draft')
        .map((r) => r.d.id)
        .sort(),
    ).toEqual([secDraftId, commentDraftId].sort());
  });
});

describe('a draft for private team SEC after its owner left SEC', () => {
  it('stays the owner’s, holds only what she sent, and reaches no SEC member', async () => {
    await transaction((repo) => repo.purge('TeamMembership', anaMembership));
    const { rows } = await h.pool.query<{ sync_groups: string[] }>(
      'SELECT sync_groups FROM drafts WHERE id = $1',
      [secDraftId],
    );
    expect(rows[0]?.sync_groups).toEqual([`user:${ana}`]);

    const owner = await bootstrapRows('anaLeft');
    const draft = owner.find((r) => r.m === 'Draft' && r.d.id === secDraftId);
    // Exactly the fields the model declares, and the data she saved: nothing read from SEC.
    expect(Object.keys(draft?.d ?? {}).sort()).toEqual(
      ['createdAt', 'data', 'id', 'issueId', 'kind', 'teamId', 'updatedAt', 'userId'].sort(),
    );
    expect(draft?.d['data']).toEqual({
      ...EMPTY_COMPOSER_DRAFT,
      title: before.secTitle,
      priority: 1,
    });
    // She no longer sees SEC: no row of it reaches her, so the draft's team id is all she has.
    const secRows = owner.filter(
      (r) =>
        r.d.id === h.teams.sec || (r.m !== 'Draft' && JSON.stringify(r.d).includes(h.teams.sec)),
    );
    expect(secRows).toEqual([]);

    const teammate = await bootstrapRows('sam');
    expect(teammate.filter((r) => r.m === 'Draft')).toEqual([]);
    expect(JSON.stringify(teammate)).not.toContain(before.secTitle);
  });

  it('can still be discarded by its owner, who needs no access to SEC', async () => {
    const result = await executor.execute(
      'draft.discard',
      { kind: 'composer', teamId: h.teams.sec },
      actors['anaLeft'] ?? actorFor({ id: '' }),
    );
    expect(result).toMatchObject({ ok: true, result: { discarded: true } });
  });
});

describe('logs (rule 6)', () => {
  it('hold no draft title, description or comment text, saved or refused', async () => {
    const logs = captureLogs();
    const { executor: logged } = testExecutor(h.pool, {
      log: pino({ level: 'trace' }, logs.stream),
    });
    const title = `Title in the logs ${randomUUID()}`;
    const body = `Description in the logs ${randomUUID()}`;
    const comment = `Comment in the logs ${randomUUID()}`;
    const actor = actors['bob'] ?? actorFor({ id: '' });
    const saved = await logged.execute(
      'draft.save',
      {
        kind: 'composer',
        teamId: h.teams.eng,
        data: { ...EMPTY_COMPOSER_DRAFT, title, description: doc(body) },
      },
      actor,
    );
    expect(saved.ok).toBe(true);
    const commented = await logged.execute(
      'draft.save',
      { kind: 'comment', issueId: ISSUE, data: { text: doc(comment) } },
      actor,
    );
    expect(commented.ok).toBe(true);
    // Refused: composer data under a comment key, so the input error path runs with the title.
    const refused = await logged.execute(
      'draft.save',
      { kind: 'comment', issueId: ISSUE, data: { ...EMPTY_COMPOSER_DRAFT, title } },
      actor,
    );
    expect(refused.ok).toBe(false);
    // The executor logged each call, so what is missing below was left out, not unlogged.
    expect(logs.lines.length).toBeGreaterThanOrEqual(3);
    expect(logs.text()).toContain('draft.save');
    for (const secret of [title, body, comment]) {
      expect(logs.text()).not.toContain(secret);
      if (!refused.ok) expect(refused.error.message).not.toContain(secret);
    }
  });
});
