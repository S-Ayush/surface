// PLAN-011 S5a leak test (SPEC-011 AC-10, §5.2, §5.6; permissions.md §5 "`/sync/content`";
// CLAUDE.md rule 4; not held, plans README §6). With SEC's description and history written by the
// operations (since S6: `issue.create`, `issue.update`, `issue.updateDescription`), for a user
// outside private SEC (a Member and an Admin):
// - `/sync/content` leaves SEC parents out exactly like unknown ones (byte-identical answers) and
//   never returns a SEC row, alone or next to a visible parent;
// - catch-up and live deltas carry no SEC content or history row, and not SEC's id;
// - bootstrap carries no content row at all (content loads per issue).
// A SEC member gets SEC's content everywhere, so the answers come from visibility, not from a
// broken endpoint. Content rows declare no groups, so a member's rows carry none at all.
import { randomUUID } from 'node:crypto';
import type { Actor } from '@surface/domain';
import {
  ContentStreamReader,
  decodeBootstrapFrame,
  decodeServerMessage,
  encodeContentQuery,
  encodeSocketConnectParams,
  issueParent,
  NdjsonDecoder,
  SOCKET_PATH,
  type ContentFrame,
  type ContentParent,
  type DeltaPacket,
  type DeltasMessage,
} from '@surface/sync-protocol';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { uuidv7 } from '../src/db/uuidv7.js';
import type { Executor } from '../src/executor/execute.js';
import { Lifecycle } from '../src/lifecycle.js';
import { createLogger } from '../src/logger.js';
import { contentFrames } from '../src/sync/content.js';
import { pgSyncLogSource } from '../src/sync/hub-source.js';
import { SyncHub } from '../src/sync/hub.js';
import { syncRegistry } from '../src/sync/registry.js';
import { syncRepo, type Repo } from '../src/sync/repo.js';
import { executorHarness, testExecutor, type ExecutorHarness } from './executor.js';
import { actorFor, captureLogs, headerActor, testConfig } from './helpers.js';

let h: ExecutorHarness;
let executor: Executor;
let app: FastifyInstance;
let hub: SyncHub;
let socketUrl: string;
const registry = syncRegistry({ includeFixtures: true });

const ana = randomUUID(); // a Member of ENG only
const zoe = randomUUID(); // an Admin, member of ENG only
const sam = randomUUID(); // the only member of private SEC
let anaActor: Actor;
let zoeActor: Actor;
let samActor: Actor;
let keyActor: Actor;

const secIssue = uuidv7();
const engIssue = uuidv7();
/** The issues' one history entry each (their `created`, the creator's edits folded in, §4.4). */
let secHistory: string;
let engHistory: string;
/** The last write of the setup, an ENG issue: what an ENG member's catch-up waits for. */
const engMarker = uuidv7();
const SECRET = 'Rotate the leaked signing key';

/** One committed transaction through the repo, as the executor runs it. */
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

/** A description holding `text`, so a leak of it shows in any answer. */
const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/**
 * An issue with `text` in its description, written as a user does: created with a description,
 * renamed (the title stays free of `text`: issues are in the bootstrap), the description saved
 * again. The creator's edits fold into the
 * one `created` entry (§4.4), whose id this returns.
 */
async function writeContent(
  issueId: string,
  team: string,
  actor: Actor,
  text: string,
): Promise<string> {
  await ok('issue.create', { id: issueId, team, title: 'Draft', description: doc(text) }, actor);
  await ok('issue.update', { issue: issueId, title: 'Renamed' }, actor);
  await ok(
    'issue.updateDescription',
    { issue: issueId, baseVersion: 1, description: doc(`${text}, again`) },
    actor,
  );
  const { rows } = await h.pool.query<{ id: string }>(
    'SELECT id FROM issue_history WHERE issue_id = $1',
    [issueId],
  );
  const [entry, ...more] = rows;
  if (entry === undefined || more.length > 0) throw new Error(`${issueId}: not one entry`);
  return entry.id;
}

async function ok(operation: string, input: object, actor: Actor): Promise<unknown> {
  const result = await executor.execute(operation, input, actor);
  if (!result.ok) throw new Error(`${operation}: ${result.error.message}`);
  return result.result;
}

beforeAll(async () => {
  h = await executorHarness();
  await transaction(async (repo) => {
    for (const [id, name] of [
      [ana, 'ana'],
      [zoe, 'zoe'],
      [sam, 'sam'],
    ] as const) {
      await repo.insert('User', {
        id,
        email: `${name}@example.com`,
        name,
        displayName: name,
        role: name === 'zoe' ? 'admin' : 'member',
        syncGroups: [],
      });
    }
    for (const [teamId, userId] of [
      [h.teams.eng, ana],
      [h.teams.eng, zoe],
      [h.teams.sec, sam],
    ] as const) {
      await repo.insert('TeamMembership', { id: randomUUID(), teamId, userId, syncGroups: [] });
    }
  });
  // Every user sees public ENG (SPEC-011 §5.6), as the session store says.
  const publicTeams = [h.teams.eng];
  anaActor = actorFor({
    id: ana,
    memberships: [{ teamId: h.teams.eng, private: false }],
    publicTeams,
  });
  zoeActor = actorFor({
    id: zoe,
    role: 'admin',
    memberships: [{ teamId: h.teams.eng, private: false }],
    publicTeams,
  });
  samActor = actorFor({
    id: sam,
    memberships: [{ teamId: h.teams.sec, private: true }],
    publicTeams,
  });
  keyActor = actorFor(
    {
      id: zoe,
      role: 'admin',
      memberships: [{ teamId: h.teams.eng, private: false }],
      publicTeams,
    },
    {
      kind: 'api',
      apiKey: { id: 'key-1', scope: 'read', teamIds: [h.teams.eng], allowDestructive: false },
    },
  );

  executor = testExecutor(h.pool).executor;
  secHistory = await writeContent(secIssue, 'SEC', samActor, SECRET);
  engHistory = await writeContent(engIssue, 'ENG', anaActor, 'Public notes');
  // Last in the log, so an ENG member's catch-up can wait for it (since PLAN-011 S4b a socket
  // follows its member teams only, so SEC's member waits for SEC's content instead).
  await ok('issue.create', { id: engMarker, team: 'ENG', title: 'Marker' }, anaActor);

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
    sync: {
      pool: h.pool,
      registry,
      resolveActor: headerActor({
        outsider: anaActor,
        admin: zoeActor,
        member: samActor,
        key: keyActor,
      }),
      hub,
    },
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

type Who = 'outsider' | 'admin' | 'member';
const userOf = (who: Who) => ({ outsider: ana, admin: zoe, member: sam })[who];

// ---------------------------------------------------------------------------------------------
// GET /sync/content

async function content(who: Who | 'key', parents: readonly ContentParent[]) {
  const res = await app.inject({
    url: `/sync/content?${encodeContentQuery({
      parents,
      userId: userOf(who === 'key' ? 'admin' : who),
      schemaHash: registry.schemaHash,
    })}`,
    headers: { 'x-test-actor': who },
  });
  if (res.statusCode !== 200) return { status: res.statusCode, body: res.body, frames: [] };
  const decoder = new NdjsonDecoder();
  const reader = new ContentStreamReader(parents);
  const frames: ContentFrame[] = [
    ...decoder.push(new Uint8Array(res.rawPayload)),
    ...decoder.end(),
  ].map((value) => reader.read(value));
  reader.finish();
  return { status: 200, body: res.body, frames };
}

const rowIds = (frames: readonly ContentFrame[]) =>
  frames.flatMap((f) => (f.t === 'row' ? [`${f.m} ${f.d.id}`] : []));

describe('/sync/content for SEC issues', () => {
  it.each<Who>(['outsider', 'admin'])(
    'answers the %s exactly as for an issue that does not exist',
    async (who) => {
      const hidden = await content(who, [issueParent(secIssue)]);
      const missing = await content(who, [issueParent(uuidv7())]);
      expect(hidden.status).toBe(200);
      expect(hidden.body).toBe(missing.body);
      expect(hidden.frames[0]).toMatchObject({ t: 'meta', parents: [], rows: 0 });
      expect(hidden.body).not.toContain(secIssue);
      expect(hidden.body).not.toContain(h.teams.sec);
      expect(hidden.body).not.toContain(SECRET);
    },
  );

  it.each<Who>(['outsider', 'admin'])(
    'gives the %s the visible parent of a mix and nothing of SEC',
    async (who) => {
      const { frames, body } = await content(who, [issueParent(secIssue), issueParent(engIssue)]);
      expect(frames[0]).toMatchObject({ parents: [issueParent(engIssue)], rows: 2 });
      expect(rowIds(frames)).toEqual([`IssueContent ${engIssue}`, `IssueHistory ${engHistory}`]);
      expect(body).not.toContain(secIssue);
      expect(body).not.toContain(secHistory);
      expect(body).not.toContain(h.teams.sec);
      expect(body).not.toContain(SECRET);
    },
  );

  it('gives a SEC member SEC’s description and history, with no groups on the rows', async () => {
    const { frames } = await content('member', [issueParent(secIssue)]);
    expect(frames[0]).toMatchObject({ parents: [issueParent(secIssue)], rows: 2 });
    expect(rowIds(frames)).toEqual([`IssueContent ${secIssue}`, `IssueHistory ${secHistory}`]);
    for (const frame of frames) {
      if (frame.t !== 'row') continue;
      expect(Object.keys(frame.d)).not.toContain('groups');
      expect(Object.keys(frame.d)).not.toContain('syncGroups');
    }
    expect(JSON.stringify(frames)).toContain(SECRET);
  });

  it('refuses an API key, even one limited to a team, before reading anything', async () => {
    const { status, body } = await content('key', [issueParent(engIssue)]);
    expect(status).toBe(403);
    expect(body).not.toContain(engIssue);
  });
});

// ---------------------------------------------------------------------------------------------
// Bootstrap, catch-up, live

function connect(who: Who, since = 0) {
  const raw: string[] = [];
  const deltas: DeltasMessage[] = [];
  const query = encodeSocketConnectParams({
    since,
    clientId: randomUUID(),
    userId: userOf(who),
    schemaHash: registry.schemaHash,
  });
  const socket = new WebSocket(`${socketUrl}${SOCKET_PATH}?${query}`, {
    headers: { 'x-test-actor': who },
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

/** `Model id` of every content row a packet carries. */
const contentIn = (packets: readonly DeltaPacket[]) =>
  packets.flatMap((p) =>
    p.a !== 'D' && p.a !== 'G' && (p.m === 'IssueContent' || p.m === 'IssueHistory')
      ? [`${p.m} ${p.d.id}`]
      : [],
  );

/** The teams of the issues whose content rows the packets carry (stored `team_id`), sorted. */
async function contentTeams(packets: readonly DeltaPacket[]): Promise<string[]> {
  const ids = packets.flatMap((p) =>
    p.a !== 'D' && p.a !== 'G' && (p.m === 'IssueContent' || p.m === 'IssueHistory')
      ? [String(p.d['issueId'])]
      : [],
  );
  const { rows } = await h.pool.query<{ team_id: string }>(
    'SELECT DISTINCT team_id FROM issues WHERE id = ANY($1::uuid[]) ORDER BY team_id',
    [[...new Set(ids)]],
  );
  return rows.map((r) => r.team_id);
}

describe('SEC content in sync', () => {
  it('is never in a bootstrap: content loads per issue', async () => {
    for (const who of ['outsider', 'member'] as const) {
      const res = await app.inject({
        url: `/sync/bootstrap?userId=${userOf(who)}`,
        headers: { 'x-test-actor': who },
      });
      const decoder = new NdjsonDecoder();
      const models = [...decoder.push(new Uint8Array(res.rawPayload)), ...decoder.end()]
        .map(decodeBootstrapFrame)
        .flatMap((f) => (f.t === 'row' ? [f.m] : []));
      expect(models).not.toContain('IssueContent');
      expect(models).not.toContain('IssueHistory');
      expect(res.body).not.toContain(SECRET);
    }
  });

  it('is not in an outsider’s catch-up; the member gets it', async () => {
    // The member joined SEC after 0, so from 0 they would be told to bootstrap again; they catch
    // up from their membership instead.
    const joined = await h.pool.query<{ id: string }>(
      `SELECT max(sync_id) AS id FROM sync_log WHERE model = 'TeamMembership'`,
    );
    const outsider = connect('outsider');
    const admin = connect('admin');
    const member = connect('member', Number(joined.rows[0]?.id));
    try {
      await eventually(
        () =>
          outsider.text().includes(engMarker) &&
          admin.text().includes(engMarker) &&
          contentIn(member.packets()).includes(`IssueHistory ${secHistory}`),
      );
      for (const c of [outsider, admin]) {
        // (an ENG member's catch-up also carries the marker's description and history)
        // Since PLAN-011 S4b an ENG member's socket follows `team:ENG`, so ENG's content comes
        // (the control); SEC's never does.
        expect(contentIn(c.packets())).toEqual(
          expect.arrayContaining([`IssueContent ${engIssue}`, `IssueHistory ${engHistory}`]),
        );
        expect(await contentTeams(c.packets())).toEqual([h.teams.eng]);
        expect(c.text()).not.toContain(secIssue);
        expect(c.text()).not.toContain(secHistory);
        expect(c.text()).not.toContain(h.teams.sec);
        expect(c.text()).not.toContain(SECRET);
      }
      expect(contentIn(member.packets())).toEqual(
        expect.arrayContaining([`IssueContent ${secIssue}`, `IssueHistory ${secHistory}`]),
      );
    } finally {
      outsider.close();
      admin.close();
      member.close();
    }
  });

  it('written live never reaches an outsider', async () => {
    const at = await head();
    const outsider = connect('outsider', at);
    const member = connect('member', at);
    try {
      const live = uuidv7();
      const liveHistory = await writeContent(live, 'SEC', samActor, 'Live secret text');
      // Written last: once they arrive, anything earlier would have arrived too. One per
      // connection: since PLAN-011 S4b each follows its member teams only (SPEC-011 §5.7).
      const marker = uuidv7();
      const secMarker = uuidv7();
      await ok('issue.create', { id: marker, team: 'ENG', title: 'Marker' }, anaActor);
      await ok('issue.create', { id: secMarker, team: 'SEC', title: 'Marker' }, samActor);
      await eventually(() => outsider.text().includes(marker) && member.text().includes(secMarker));
      // Only the ENG marker's own description and history.
      expect(contentIn(outsider.packets())).toHaveLength(2);
      expect(await contentTeams(outsider.packets())).toEqual([h.teams.eng]);
      expect(outsider.text()).not.toContain(live);
      expect(outsider.text()).not.toContain(liveHistory);
      expect(outsider.text()).not.toContain(h.teams.sec);
      expect(outsider.text()).not.toContain('Live secret');
      // The create's rows, then the fold of the rename and the save (`U`), then the marker's.
      expect(contentIn(member.packets())).toEqual(
        expect.arrayContaining([`IssueContent ${live}`, `IssueHistory ${liveHistory}`]),
      );
      expect(await contentTeams(member.packets())).toEqual([h.teams.sec]);
      const rows = member
        .packets()
        .flatMap((p) => (p.a === 'I' && p.m === 'IssueContent' ? [p.d] : []));
      expect(rows.length).toBeGreaterThan(0);
      for (const d of rows) {
        expect(Object.keys(d).sort()).toEqual([
          'createdAt',
          'description',
          'id',
          'issueId',
          'teamId',
          'updatedAt',
          'version',
        ]);
      }
    } finally {
      outsider.close();
      member.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The byte budget (PLAN-011 S8; SPEC-011 §5.2, D16)

describe('a content answer cut by its byte budget', () => {
  /** One answer as `/sync/content` builds it, with the head left out (writes move it). */
  async function answer(actor: Actor, parents: readonly string[], budgetBytes: number) {
    const frames = await contentFrames({
      pool: h.pool,
      registry,
      actor,
      parents: parents.map(issueParent),
      budgetBytes,
    });
    return frames.map((f) => (f.t === 'meta' ? { ...f, lastSyncId: 0 } : f));
  }

  it('reveals nothing of a large SEC parent: it neither counts nor cuts, as if it were not asked for', async () => {
    const large = uuidv7();
    await writeContent(large, 'SEC', samActor, `${SECRET} ${'x'.repeat(150_000)}`);
    // ENG's two parents fit together; the SEC one alone would not.
    const budget = 20 * 1024;
    for (const actor of [anaActor, zoeActor]) {
      const hidden = await answer(actor, [engIssue, large, engMarker], budget);
      expect(hidden).toEqual(await answer(actor, [engIssue, uuidv7(), engMarker], budget));
      expect(hidden[0]).toMatchObject({
        parents: [issueParent(engIssue), issueParent(engMarker)],
      });
      // First in the request, where a visible parent always comes whole.
      const first = await answer(actor, [large, engIssue, engMarker], 1);
      expect(first).toEqual(await answer(actor, [uuidv7(), engIssue, engMarker], 1));
      expect(first[0]).toMatchObject({ parents: [issueParent(engIssue)] });
      for (const text of [large, h.teams.sec, SECRET]) {
        expect(JSON.stringify([hidden, first]), text).not.toContain(text);
      }
    }
    // SEC's member sees it: it doesn't fit after ENG's first parent, so the answer stops there.
    // The cut above comes from visibility, not from a budget too large to cut.
    const control = await answer(samActor, [engIssue, large, engMarker], budget);
    expect(control[0]).toMatchObject({ parents: [issueParent(engIssue)] });
  });
});
