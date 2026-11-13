// PLAN-013 S3 leak test (SPEC-013 AC-12, §5.1, §5.2; permissions.md §5; CLAUDE.md rule 4; not
// held, plans README §6). A SEC member comments on a private SEC issue, replies, edits, resolves
// and reacts, through the real operations (the reaction through the repo until `reaction.set`,
// PLAN-013 S4). For a user outside SEC (a Member and an Admin) and for an API key limited to ENG:
// - `/sync/content` leaves the SEC issue out exactly like an unknown one and returns no SEC
//   comment or reaction, alone or next to a visible ENG issue;
// - live deltas carry no SEC comment or reaction, nor its id, nor its text;
// - `comment.list` on the SEC issue is the `NOT_FOUND` of an issue that doesn't exist;
// - a `CommentRef` to a SEC comment is `NOT_FOUND`, worded as for a comment id that doesn't exist,
//   in every operation that takes one (and as `parent` of a reply on a visible issue);
// - `sync_log` stores SEC comment rows under `team:<SEC>` only (D12), and the outbox events carry
//   ids, never the body.
// The SEC member gets everything, so the answers come from visibility, not a broken path.
import { randomUUID } from 'node:crypto';
import { teamGroup, type Actor } from '@surface/domain';
import {
  ContentStreamReader,
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
import { lookup } from '../src/executor/refs/sources.js';
import { Lifecycle } from '../src/lifecycle.js';
import { createLogger } from '../src/logger.js';
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
/** Sam's own read-write key, limited to ENG: it must not reach SEC either (permissions §3.5). */
let samKeyActor: Actor;

const secIssue = uuidv7();
const engIssue = uuidv7();
const secThread = uuidv7();
const secReply = uuidv7();
const secReaction = uuidv7();
const engComment = uuidv7();
const SECRET = 'Rotate the leaked signing key';

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

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

async function ok(operation: string, input: object, actor: Actor): Promise<unknown> {
  const result = await executor.execute(operation, input, actor);
  if (!result.ok) throw new Error(`${operation}: ${result.error.message}`);
  return result.result;
}

async function refusal(operation: string, input: object, actor: Actor) {
  const result = await executor.execute(operation, input, actor);
  if (result.ok) throw new Error(`${operation} succeeded`);
  return result.error;
}

/** Sam's SEC thread: a comment, a reply, an edit, a resolve, and a reaction. */
async function secActivity(ids: { thread: string; reply: string; reaction: string }, text: string) {
  await ok('comment.create', { id: ids.thread, issue: secIssue, body: doc(text) }, samActor);
  await ok(
    'comment.create',
    { id: ids.reply, issue: secIssue, parent: ids.thread, body: doc(`${text}, reply`) },
    samActor,
  );
  await ok(
    'comment.update',
    { comment: ids.thread, baseVersion: 1, body: doc(`${text}, edited`) },
    samActor,
  );
  await ok('comment.resolve', { comment: ids.reply }, samActor);
  await transaction((repo) =>
    repo.insert('Reaction', {
      id: ids.reaction,
      issueId: secIssue,
      teamId: h.teams.sec,
      commentId: ids.thread,
      userId: sam,
      emoji: '👀',
    }),
  );
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
  samKeyActor = actorFor(
    { id: sam, memberships: [{ teamId: h.teams.sec, private: true }], publicTeams },
    {
      kind: 'api',
      apiKey: { id: 'key-1', scope: 'read_write', teamIds: [h.teams.eng], allowDestructive: true },
    },
  );

  executor = testExecutor(h.pool).executor;
  await ok('issue.create', { id: secIssue, team: 'SEC', title: 'Secret work' }, samActor);
  await ok('issue.create', { id: engIssue, team: 'ENG', title: 'Fix login' }, anaActor);
  await secActivity({ thread: secThread, reply: secReply, reaction: secReaction }, SECRET);
  await ok('comment.create', { id: engComment, issue: engIssue, body: 'Public note' }, anaActor);

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
      resolveActor: headerActor({ outsider: anaActor, admin: zoeActor, member: samActor }),
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
/** Who must see nothing of SEC; actors are built in `beforeAll`, so they are looked up late. */
const OUTSIDERS = [
  'a Member outside SEC',
  'an Admin outside SEC',
  'a SEC member’s key limited to ENG',
] as const;
const outsider = (who: (typeof OUTSIDERS)[number]): Actor =>
  ({
    'a Member outside SEC': anaActor,
    'an Admin outside SEC': zoeActor,
    'a SEC member’s key limited to ENG': samKeyActor,
  })[who];

/** Every SEC id and text that must never reach an outsider. */
const secMarks = () => [secIssue, secThread, secReply, secReaction, h.teams.sec, SECRET];
function expectNoSec(text: string) {
  for (const mark of secMarks()) expect(text).not.toContain(mark);
}

// ---------------------------------------------------------------------------------------------
// GET /sync/content

async function content(who: Who, parents: readonly ContentParent[]) {
  const res = await app.inject({
    url: `/sync/content?${encodeContentQuery({
      parents,
      userId: userOf(who),
      schemaHash: registry.schemaHash,
    })}`,
    headers: { 'x-test-actor': who },
  });
  expect(res.statusCode).toBe(200);
  const decoder = new NdjsonDecoder();
  const reader = new ContentStreamReader(parents);
  const frames: ContentFrame[] = [
    ...decoder.push(new Uint8Array(res.rawPayload)),
    ...decoder.end(),
  ].map((value) => reader.read(value));
  reader.finish();
  return { body: res.body, frames };
}

const commentRows = (frames: readonly ContentFrame[]) =>
  frames.flatMap((f) =>
    f.t === 'row' && (f.m === 'Comment' || f.m === 'Reaction') ? [`${f.m} ${f.d.id}`] : [],
  );

describe('/sync/content for a SEC issue’s comments', () => {
  it.each<Who>(['outsider', 'admin'])(
    'answers the %s exactly as for an issue that does not exist',
    async (who) => {
      const hidden = await content(who, [issueParent(secIssue)]);
      const missing = await content(who, [issueParent(uuidv7())]);
      expect(hidden.body).toBe(missing.body);
      expectNoSec(hidden.body);
    },
  );

  it.each<Who>(['outsider', 'admin'])(
    'gives the %s the ENG comment of a mix and nothing of SEC',
    async (who) => {
      const { frames, body } = await content(who, [issueParent(secIssue), issueParent(engIssue)]);
      expect(commentRows(frames)).toEqual([`Comment ${engComment}`]);
      expectNoSec(body);
    },
  );

  it('gives the SEC member the thread, its reply and the reaction', async () => {
    const { frames, body } = await content('member', [issueParent(secIssue)]);
    expect(commentRows(frames).sort()).toEqual(
      [`Comment ${secThread}`, `Comment ${secReply}`, `Reaction ${secReaction}`].sort(),
    );
    expect(body).toContain(SECRET);
  });
});

// ---------------------------------------------------------------------------------------------
// Live deltas

function connect(who: Who, since: number) {
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

/** `action Model id` of every comment and reaction packet. */
const commentPackets = (packets: readonly DeltaPacket[]) =>
  packets.flatMap((p) => {
    if (p.a === 'G' || (p.m !== 'Comment' && p.m !== 'Reaction')) return [];
    return [`${p.a} ${p.m} ${p.a === 'D' ? p.mid : String(p.d['id'])}`];
  });

describe('SEC comments in live deltas', () => {
  it('never reach an outsider; the member gets each write', async () => {
    const at = await head();
    const outsider = connect('outsider', at);
    const admin = connect('admin', at);
    const member = connect('member', at);
    try {
      const ids = { thread: uuidv7(), reply: uuidv7(), reaction: uuidv7() };
      await secActivity(ids, 'Live secret');
      await ok('comment.delete', { comment: ids.reply }, samActor);
      // Written last, one per connection (each follows its member teams, SPEC-011 §5.7).
      const marker = uuidv7();
      const secMarker = uuidv7();
      await ok('comment.create', { id: marker, issue: engIssue, body: 'Marker' }, anaActor);
      await ok('comment.create', { id: secMarker, issue: secIssue, body: 'Marker' }, samActor);
      await eventually(
        () =>
          outsider.text().includes(marker) &&
          admin.text().includes(marker) &&
          member.text().includes(secMarker),
      );
      for (const c of [outsider, admin]) {
        expect(commentPackets(c.packets())).toEqual([`I Comment ${marker}`]);
        for (const mark of [...Object.values(ids), secIssue, h.teams.sec, 'Live secret']) {
          expect(c.text()).not.toContain(mark);
        }
      }
      expect(commentPackets(member.packets())).toEqual(
        expect.arrayContaining([
          `I Comment ${ids.thread}`,
          `I Comment ${ids.reply}`,
          `U Comment ${ids.thread}`,
          `I Reaction ${ids.reaction}`,
          `D Comment ${ids.reply}`,
          `I Comment ${secMarker}`,
        ]),
      );
    } finally {
      outsider.close();
      admin.close();
      member.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Operations

/**
 * An error as the caller sees it, with the id it was asked about (which it echoes) replaced, and
 * no correlation id: a hidden row's answer must equal a missing one's, byte for byte.
 */
function errorShape(error: object, askedId: string): string {
  return JSON.stringify({ ...error, correlationId: '' }).replaceAll(askedId, '<id>');
}

describe('comment operations on SEC comments', () => {
  it.each(OUTSIDERS)('comment.list on the SEC issue is NOT_FOUND for %s', async (who) => {
    const actor = outsider(who);
    const hidden = await refusal('comment.list', { issue: secIssue }, actor);
    const missingId = uuidv7();
    const missing = await refusal('comment.list', { issue: missingId }, actor);
    expect(hidden.code).toBe('NOT_FOUND');
    expect(errorShape(hidden, secIssue)).toBe(errorShape(missing, missingId));
  });

  it.each(OUTSIDERS)(
    'a CommentRef to a SEC comment is NOT_FOUND, worded as a missing one, for %s',
    async (who) => {
      const actor = outsider(who);
      const missingId = uuidv7();
      const inputs: [string, (comment: string) => object][] = [
        ['comment.update', (comment) => ({ comment, baseVersion: 2, body: 'x' })],
        ['comment.delete', (comment) => ({ comment })],
        ['comment.resolve', (comment) => ({ comment })],
        ['comment.reopen', (comment) => ({ comment })],
        ['comment.create', (comment) => ({ issue: engIssue, parent: comment, body: 'x' })],
      ];
      for (const [operation, input] of inputs) {
        const hidden = await refusal(operation, input(secThread), actor);
        const missing = await refusal(operation, input(missingId), actor);
        expect({ operation, code: hidden.code }).toEqual({ operation, code: 'NOT_FOUND' });
        expect(errorShape(hidden, secThread)).toBe(errorShape(missing, missingId));
      }
      // Nothing changed: the thread is still Sam's, at version 2, resolved.
      const listed = (await ok('comment.list', { issue: secIssue }, samActor)) as {
        nodes: { id: string; version: number; resolved: unknown }[];
      };
      expect(listed.nodes.find((n) => n.id === secThread)).toMatchObject({ version: 2 });
    },
  );

  it('comment.list gives the SEC member the thread, with Markdown and JSON bodies', async () => {
    const listed = (await ok('comment.list', { issue: secIssue }, samActor)) as {
      nodes: { id: string; parentId: string | null; body: { markdown: string } | null }[];
    };
    expect(listed.nodes.slice(0, 2).map((n) => [n.id, n.parentId])).toEqual([
      [secThread, null],
      [secReply, secThread],
    ]);
    expect(listed.nodes[0]?.body?.markdown).toBe(`${SECRET}, edited`);
  });
});

// ---------------------------------------------------------------------------------------------
// What the database keeps

describe('the CommentRef lookup on its own', () => {
  // The executor's key scope (`key-scope.ts`) also refuses a row outside the key's teams; the
  // lookup's own `team_id` clause is the backstop, so it is checked without the executor.
  const resolve = async (actor: Actor) => {
    try {
      const row = await lookup('CommentRef', secThread, {
        db: h.pool,
        actor,
        path: ['comment'],
        allowInactive: false,
      });
      return row.id;
    } catch (error) {
      return (error as { code: string }).code;
    }
  };

  it('finds a SEC comment for Sam, and not for Sam’s key limited to ENG, or a Member outside SEC', async () => {
    expect(await resolve(samActor)).toBe(secThread);
    expect(await resolve(samKeyActor)).toBe('NOT_FOUND');
    expect(await resolve(anaActor)).toBe('NOT_FOUND');
  });
});

describe('stored SEC comment rows', () => {
  it('are logged under team:<SEC> only (D12)', async () => {
    const { rows } = await h.pool.query<{ model: string; groups: string[] }>(
      `SELECT model, groups FROM sync_log WHERE model IN ('Comment', 'Reaction')
         AND model_id = ANY($1::uuid[])`,
      [[secThread, secReply, secReaction]],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.groups).toEqual([teamGroup(h.teams.sec)]);
  });

  it('give outbox events with ids and the actor, never the body', async () => {
    const { rows } = await h.pool.query<{ type: string; doc: string }>(
      `SELECT type, row_to_json(e)::text AS doc FROM event_outbox e WHERE type LIKE 'comment.%'`,
    );
    expect(rows.map((r) => r.type)).toEqual(
      expect.arrayContaining(['comment.created', 'comment.updated', 'comment.resolved']),
    );
    for (const row of rows) {
      expect(row.doc).not.toContain(SECRET);
      expect(row.doc).not.toContain('Live secret');
      expect(row.doc).not.toContain('Public note');
    }
  });
});
