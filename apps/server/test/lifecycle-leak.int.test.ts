// PLAN-015 S5 leak test (SPEC-015 AC-11, E12, E13; permissions.md §5; CLAUDE.md rule 4; not held,
// plans README §6). `issue-leak.int.test.ts` already covers the lifecycle operations on a *live*
// SEC issue, `issue.purge` on a deleted one (E12), `issue.listDeleted` with `withTotal`, the jobs'
// `A`/`U` in SEC's group and the system purge's `D`. This file covers what is left, on issues of
// private team SEC that are **archived or deleted** and hold content, comments and attachments:
// - every operation that names one (`issue.get`/`delete`/`restore`/`purge`/`update`, comments,
//   attachments, by identifier and by id) answers a Member and an Admin outside SEC exactly like
//   an issue that doesn't exist, never with the §4.2 lifecycle wording, and writes nothing;
// - `issue.list`/`count` with `includeArchived` (the archive tab and its footer) and
//   `issue.listDeleted` never list or count them;
// - `/sync/content` leaves them out byte for byte like an unknown parent;
// - `GET /files/:id` of their attachment and inline files is the missing file's 404 on every way
//   of reading it, for the Admin too;
// - the deltas of a delete, a restore (with its Attachment re-log), the job's archive, a restore
//   from Archived (`V`) and a purge never reach an outsider's connection, and sit in SEC's group
//   only;
// - the catalog MCP's `search_operations` will draw its examples from (`GET /api/ops`) is the same
//   for the lifecycle operations whoever asks, and names nothing of SEC or OPS;
// - an API key limited to ENG gets the same for public team OPS's archived and deleted issues in
//   every one of them (a key has no socket and no `/sync/content`: both refuse it, which this file
//   checks too).
// SEC's member gets everything, so each answer comes from visibility, not from a broken path.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { systemActor, type Actor } from '@surface/domain';
import { ALL_OPERATIONS, createRegistry } from '@surface/operations';
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
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../src/app.js';
import { createSession, SESSION_COOKIE } from '../src/auth/session.js';
import { SessionAuth } from '../src/auth/sessions.js';
import { pgAuthStore } from '../src/auth/store.js';
import type { FilePurpose } from '../src/db/schema/index.js';
import { uuidv7 } from '../src/db/uuidv7.js';
import type { Executor } from '../src/executor/execute.js';
import { lookup } from '../src/executor/refs/sources.js';
import { transactionRunner } from '../src/executor/transaction.js';
import { localBlobStore } from '../src/files/blob-store.js';
import { PG_FILE_STORE } from '../src/files/store.js';
import { seedTeamWorkflow, teamWorkflow } from '../src/handlers/teams/seed.js';
import { Lifecycle } from '../src/lifecycle.js';
import { createLogger } from '../src/logger.js';
import { pgSyncLogSource } from '../src/sync/hub-source.js';
import { SyncHub } from '../src/sync/hub.js';
import { syncRegistry } from '../src/sync/registry.js';
import { syncRepo, type Repo } from '../src/sync/repo.js';
import { FakeAttempts } from './auth-fakes.js';
import { executorHarness, testExecutor, type ExecutorHarness } from './executor.js';
import { actorFor, captureLogs, headerActor, testConfig } from './helpers.js';

let h: ExecutorHarness;
let executor: Executor;
let app: FastifyInstance;
let hub: SyncHub;
let socketUrl: string;
let dataDir: string;
let secGroup: string;
const registry = syncRegistry({ includeFixtures: true });

const users = {
  ana: randomUUID(), // a Member of ENG only
  zoe: randomUUID(), // an Admin, member of ENG only
  sam: randomUUID(), // the only member of private SEC
} as const;
type Name = keyof typeof users;
const ops = randomUUID(); // a second public team, nobody's
let anaActor: Actor;
let zoeActor: Actor;
let samActor: Actor;
/** Zoe through a read-write API key limited to ENG, with "allow destructive". */
let engKeyActor: Actor;

const SECRET = 'Rotate the leaked signing key';
const SECRET_URL = 'https://vault.internal.example/keys/rotation';
const OPS_SECRET = 'Renew the on-call certificate';

/** One SEC issue per locked state, each with a description, a comment and attachments. */
interface Locked {
  readonly id: string;
  identifier: string;
  readonly comment: string;
  readonly link: string;
  readonly fileAttachment: string;
  readonly file: string;
  readonly inline: string;
  history: string;
}
const lockedIssue = (): Locked => ({
  id: uuidv7(),
  identifier: '',
  comment: uuidv7(),
  link: uuidv7(),
  fileAttachment: uuidv7(),
  file: uuidv7(),
  inline: uuidv7(),
  history: '',
});
const sec = { archived: lockedIssue(), deleted: lockedIssue() };
const opsIssues = { archived: lockedIssue(), deleted: lockedIssue() };
const engIssue = uuidv7();
type State = keyof typeof sec;
const STATES: readonly State[] = ['archived', 'deleted'];

const etags: Record<string, string> = {};
const cookies: Partial<Record<Name, string>> = {};

async function transaction(write: (repo: Repo, client: pg.PoolClient) => Promise<unknown>) {
  const client = await h.pool.connect();
  try {
    await client.query('BEGIN');
    const repo = syncRepo(drizzle({ client, casing: 'snake_case' }), new Date());
    await write(repo, client);
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

const IdentifierSchema = z.object({ identifier: z.string() });
const PageSchema = z.object({
  nodes: z.array(z.object({ id: z.string() })),
  totalCount: z.number().optional(),
});
const CountSchema = z.object({ count: z.number() });

/** A description holding `text`, so a leak of it shows in any answer. */
const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** Closed and last touched 13 months ago, so the `auto-archive` job takes it (§6.3). */
async function ageClosed(issueId: string): Promise<void> {
  // Test setup, so the unlogged write is harmless: the job's logged `A` follows it.
  await h.pool.query(
    `UPDATE issues SET completed_at = now() - interval '13 months',
                       updated_at = now() - interval '13 months'
      WHERE id = $1`,
    [issueId],
  );
}

/**
 * Writes `issue` in `team` as `actor` does: a description holding `secret`, a comment, a link
 * and a file attachment (the actor's own upload, claimed by `attachment.createFile`), plus an
 * inline image of the description (inserted owned, as `claimInlineFiles` leaves it). Then the
 * issue is archived by the job or deleted.
 */
async function writeLocked(
  issue: Locked,
  team: 'SEC' | 'OPS',
  state: State,
  actor: Actor,
  secret: string,
): Promise<void> {
  const blobs = localBlobStore(path.join(dataDir, 'uploads'));
  await ok(
    'issue.create',
    {
      id: issue.id,
      team,
      title: `${state} work`,
      description: doc(secret),
      ...(state === 'archived' ? { status: 'Done' } : {}),
    },
    actor,
  );
  issue.identifier = IdentifierSchema.parse(
    await ok('issue.get', { issue: issue.id }, actor),
  ).identifier;
  await ok('comment.create', { id: issue.comment, issue: issue.id, body: secret }, actor);
  await ok(
    'attachment.createLink',
    { id: issue.link, issue: issue.id, url: SECRET_URL, title: secret },
    actor,
  );
  const client = await h.pool.connect();
  try {
    for (const [fileId, purpose, owner] of [
      [issue.file, 'attachment', null],
      [issue.inline, 'inline', issue.id],
    ] as const) {
      const temp = await blobs.putStream(Readable.from([Buffer.from(`bytes of ${fileId}`)]));
      etags[fileId] = `"${temp.key.slice(temp.key.lastIndexOf('/') + 1)}"`;
      await PG_FILE_STORE.insertUpload(client, blobs, temp, {
        id: fileId,
        purpose: purpose satisfies FilePurpose,
        name: `${secret}.bin`,
        mimeType: 'application/octet-stream',
        size: `bytes of ${fileId}`.length,
        uploaderId: actor.userId ?? '',
        issueId: owner,
        previewOf: null,
      });
    }
  } finally {
    client.release();
  }
  await ok(
    'attachment.createFile',
    { id: issue.fileAttachment, issue: issue.id, file: issue.file, title: secret },
    actor,
  );
  const { rows } = await h.pool.query<{ id: string }>(
    'SELECT id FROM issue_history WHERE issue_id = $1 ORDER BY id LIMIT 1',
    [issue.id],
  );
  issue.history = rows[0]?.id ?? '';
  if (state === 'archived') {
    await ageClosed(issue.id);
    await ok('issue.autoArchive', { issue: issue.id }, systemActor());
  } else {
    await ok('issue.delete', { issue: issue.id }, actor);
  }
}

beforeAll(async () => {
  h = await executorHarness();
  secGroup = `team:${h.teams.sec}`;
  dataDir = await mkdtemp(path.join(tmpdir(), 'surface-lifecycle-leak-'));
  await transaction(async (repo) => {
    await repo.insert('Workspace', { id: randomUUID(), name: 'Acme', syncGroups: [] });
    for (const [name, id] of Object.entries(users)) {
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
      [h.teams.eng, users.ana],
      [h.teams.eng, users.zoe],
      [h.teams.sec, users.sam],
    ] as const) {
      await repo.insert('TeamMembership', { id: randomUUID(), teamId, userId, syncGroups: [] });
    }
    const workflow = teamWorkflow(ops);
    await repo.insert('Team', {
      id: ops,
      key: 'OPS',
      name: 'Operations',
      private: false,
      defaultStatusId: workflow.defaultStatusId,
      syncGroups: [],
    });
    await seedTeamWorkflow(repo, workflow);
  });
  // Every user sees the public teams ENG and OPS (SPEC-011 §5.6), as the session store says.
  const publicTeams = [h.teams.eng, ops];
  anaActor = actorFor({
    id: users.ana,
    memberships: [{ teamId: h.teams.eng, private: false }],
    publicTeams,
  });
  zoeActor = actorFor({
    id: users.zoe,
    role: 'admin',
    memberships: [{ teamId: h.teams.eng, private: false }],
    publicTeams,
  });
  samActor = actorFor({
    id: users.sam,
    memberships: [{ teamId: h.teams.sec, private: true }],
    publicTeams,
  });
  engKeyActor = actorFor(
    {
      id: users.zoe,
      role: 'admin',
      memberships: [{ teamId: h.teams.eng, private: false }],
      publicTeams,
    },
    {
      kind: 'api',
      apiKey: { id: 'key-1', scope: 'read_write', teamIds: [h.teams.eng], allowDestructive: true },
    },
  );

  executor = testExecutor(h.pool).executor;
  await ok('issue.create', { id: engIssue, team: 'ENG', title: 'Fix login' }, anaActor);
  for (const state of STATES) {
    await writeLocked(sec[state], 'SEC', state, samActor, SECRET);
    await writeLocked(opsIssues[state], 'OPS', state, anaActor, OPS_SECRET);
  }

  for (const [name, id] of Object.entries(users)) {
    const session = await createSession(h.pool, {
      userId: id,
      userAgent: undefined,
      ip: undefined,
      now: new Date(),
    });
    if (name === 'ana' || name === 'zoe' || name === 'sam') {
      cookies[name] = `${SESSION_COOKIE}=${session.token}`;
    }
  }

  const config = testConfig({ dataDir });
  const lifecycle = new Lifecycle();
  const logger = createLogger(config, captureLogs().stream);
  const resolveActor = headerActor({
    outsider: anaActor,
    admin: zoeActor,
    member: samActor,
    key: engKeyActor,
  });
  hub = new SyncHub({
    source: pgSyncLogSource({
      pool: h.pool,
      listenClient: () => new pg.Client({ connectionString: h.db.url }),
    }),
    registry,
    log: logger,
  });
  const store = pgAuthStore(h.pool);
  app = await buildApp({
    config,
    lifecycle,
    logger,
    ops: {
      registry: createRegistry(ALL_OPERATIONS),
      resolveActor,
      createExecutor: () => executor,
    },
    sync: { pool: h.pool, registry, resolveActor, hub },
    auth: {
      auth: new SessionAuth(store),
      store,
      attempts: new FakeAttempts(),
      withTransaction: transactionRunner(h.pool),
    },
  });
  await hub.start();
  lifecycle.markReady();
  socketUrl = (await app.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/, 'ws');
});
afterAll(async () => {
  await hub?.stop();
  await app?.close();
  await h?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

/** Every SEC id and text that must never reach an outsider. */
function secMarks(): string[] {
  return [
    h.teams.sec,
    SECRET,
    SECRET_URL,
    ...STATES.flatMap((state) => {
      const issue = sec[state];
      return [issue.id, issue.comment, issue.link, issue.fileAttachment, issue.file, issue.inline];
    }),
  ];
}
function expectNoSec(text: string, context: string) {
  for (const mark of secMarks()) expect(text, `${context}: ${mark}`).not.toContain(mark);
}

async function logLength(): Promise<number> {
  const { rows } = await h.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM sync_log');
  return rows[0]?.n ?? 0;
}

/** The failure of `operation`, with `hidden` replaced, so two answers can be compared. */
async function failure(operation: string, input: object, actor: Actor, hidden: string[]) {
  const result = await executor.execute(operation, input, actor);
  if (result.ok) return { ok: true };
  const hide = (text: string) => hidden.reduce((t, word) => t.replaceAll(word, '<ref>'), text);
  const { code, message, issues } = result.error;
  return {
    code,
    message: hide(message),
    issues: (issues ?? []).map((issue) => ({ ...issue, message: hide(issue.message) })),
  };
}

// ---------------------------------------------------------------------------------------------
// Operations (AC-11, E12, E13)

/** Every operation that names an issue, its comment or its attachment, as `refs` fill it. */
const OPERATIONS: readonly [
  string,
  (r: { issue: string; comment: string; attachment: string }) => object,
][] = [
  ['issue.get', (r) => ({ issue: r.issue })],
  ['issue.delete', (r) => ({ issue: r.issue })],
  ['issue.restore', (r) => ({ issue: r.issue })],
  ['issue.purge', (r) => ({ issue: r.issue })],
  ['issue.update', (r) => ({ issue: r.issue, title: 'Leaked' })],
  ['issue.updateDescription', (r) => ({ issue: r.issue, baseVersion: 1, description: 'Leaked' })],
  ['comment.create', (r) => ({ issue: r.issue, body: 'Leaked' })],
  ['comment.update', (r) => ({ comment: r.comment, baseVersion: 1, body: 'Leaked' })],
  ['comment.delete', (r) => ({ comment: r.comment })],
  ['reaction.set', (r) => ({ comment: r.comment, emoji: '👍', reacted: true })],
  ['reaction.set', (r) => ({ issue: r.issue, emoji: '👍', reacted: true })],
  ['attachment.createLink', (r) => ({ issue: r.issue, url: 'https://example.com/leak' })],
  ['attachment.update', (r) => ({ attachment: r.attachment, title: 'Leaked' })],
  ['attachment.delete', (r) => ({ attachment: r.attachment })],
];

/** Each operation on `issue` by identifier and by id, against the same on unknown refs. */
async function expectAllUnknown(issue: Locked, unknownIdentifier: string, actor: Actor) {
  const before = await logLength();
  for (const [issueRef, unknownIssue] of [
    [issue.identifier, unknownIdentifier],
    [issue.id, uuidv7()],
  ] as const) {
    const real = { issue: issueRef, comment: issue.comment, attachment: issue.fileAttachment };
    const none = { issue: unknownIssue, comment: uuidv7(), attachment: uuidv7() };
    for (const [operation, input] of OPERATIONS) {
      const hidden = Object.values(real);
      const answer = await failure(operation, input(real), actor, hidden);
      const missing = await failure(operation, input(none), actor, Object.values(none));
      expect(answer, `${operation} ${issueRef}`).toMatchObject({ code: 'NOT_FOUND' });
      expect(answer, `${operation} ${issueRef}`).toEqual(missing);
    }
  }
  expect(await logLength()).toBe(before);
}

describe.each(STATES)('a %s SEC issue, named by someone outside SEC', (state) => {
  it.each([
    ['a Member', () => anaActor],
    ['an Admin (E12)', () => zoeActor],
  ] as const)(
    'is NOT_FOUND for %s from every operation, like an issue that doesn’t exist, and writes nothing',
    async (_who, actor) => {
      await expectAllUnknown(sec[state], 'SEC-999', actor());
    },
  );

  it('is there for SEC’s member, who gets the lifecycle refusals instead (the control)', async () => {
    const issue = sec[state];
    expect(await ok('issue.get', { issue: issue.identifier }, samActor)).toMatchObject({
      id: issue.id,
    });
    const verb = state === 'archived' ? 'is archived' : 'was deleted';
    expect(
      await failure('issue.update', { issue: issue.id, title: 'x' }, samActor, []),
    ).toMatchObject({
      code: 'CONFLICT',
      message: `${issue.identifier} ${verb}. Restore it to edit it.`,
    });
    // Not an Admin: the purge is FORBIDDEN, so the outsiders' NOT_FOUND comes from visibility.
    expect(await failure('issue.purge', { issue: issue.id }, samActor, [])).toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('is NOT_FOUND for an API key limited to ENG on the same OPS issue (E13)', async () => {
    await expectAllUnknown(opsIssues[state], 'OPS-999', engKeyActor);
    // Zoe herself sees it: the key's teams are what hid it.
    expect(await ok('issue.get', { issue: opsIssues[state].id }, zoeActor)).toMatchObject({
      id: opsIssues[state].id,
    });
  });
});

describe('lists and counts that take archived and deleted issues', () => {
  const ARCHIVED = { field: 'archivedAt', op: 'exists', value: true };
  const ids = (page: unknown) => PageSchema.parse(page).nodes.map((node) => node.id);

  it.each([
    ['a Member', () => anaActor],
    ['an Admin', () => zoeActor],
  ] as const)(
    'never list or count a SEC issue for %s outside SEC: the archive tab, its footer, Recently deleted',
    async (_who, actor) => {
      const answers = [
        await ok('issue.list', { includeArchived: true, filter: ARCHIVED, limit: 100 }, actor()),
        await ok('issue.list', { includeArchived: true, limit: 100, withTotal: true }, actor()),
        await ok('issue.listDeleted', { limit: 100, withTotal: true }, actor()),
        await ok('issue.groupBy', { by: 'status', includeArchived: true }, actor()),
      ];
      for (const answer of answers) expectNoSec(JSON.stringify(answer), 'list');
      const archived = CountSchema.parse(
        await ok('issue.count', { includeArchived: true, filter: ARCHIVED }, actor()),
      );
      // OPS's archived issue only: public, and no SEC one counted.
      expect(archived.count).toBe(1);
      const deleted = PageSchema.parse(answers[2]);
      expect(deleted.totalCount).toBe(deleted.nodes.length);
      expect(ids(deleted)).toEqual([opsIssues.deleted.id]);
      // The control: SEC's member counts both archived issues.
      expect(
        await ok('issue.count', { includeArchived: true, filter: ARCHIVED }, samActor),
      ).toEqual({ count: 2 });
    },
  );

  it('never list or count an OPS issue for an API key limited to ENG', async () => {
    for (const answer of [
      await ok('issue.list', { includeArchived: true, filter: ARCHIVED }, engKeyActor),
      await ok('issue.listDeleted', { withTotal: true }, engKeyActor),
    ]) {
      expect(PageSchema.parse(answer)).toMatchObject({ nodes: [] });
      expect(JSON.stringify(answer)).not.toContain(OPS_SECRET);
    }
    expect(
      await ok('issue.count', { includeArchived: true, filter: ARCHIVED }, engKeyActor),
    ).toEqual({ count: 0 });
  });
});

// ---------------------------------------------------------------------------------------------
// GET /sync/content (AC-11, AC-20)

type Who = 'outsider' | 'admin' | 'member';
const userOf = (who: Who) => ({ outsider: users.ana, admin: users.zoe, member: users.sam })[who];

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
  frames.flatMap((f) => (f.t === 'row' ? [`${f.m} ${f.d.id}`] : [])).sort();

describe.each(STATES)('/sync/content for a %s SEC issue', (state) => {
  it.each<Who>(['outsider', 'admin'])(
    'answers the %s exactly as for an issue that doesn’t exist',
    async (who) => {
      const hidden = await content(who, [issueParent(sec[state].id)]);
      const missing = await content(who, [issueParent(uuidv7())]);
      expect(hidden.status).toBe(200);
      expect(hidden.body).toBe(missing.body);
      expect(hidden.frames[0]).toMatchObject({ t: 'meta', parents: [], rows: 0 });
      expectNoSec(hidden.body, who);
      // Next to a visible parent, only the visible one's rows.
      const mixed = await content(who, [issueParent(sec[state].id), issueParent(engIssue)]);
      expect(mixed.frames[0]).toMatchObject({ parents: [issueParent(engIssue)] });
      expectNoSec(mixed.body, `${who} mixed`);
    },
  );

  it('gives SEC’s member its description, history and comment for the read-only page (AC-20)', async () => {
    const issue = sec[state];
    const { frames, body } = await content('member', [issueParent(issue.id)]);
    expect(frames[0]).toMatchObject({ parents: [issueParent(issue.id)] });
    expect(rowIds(frames)).toEqual(
      expect.arrayContaining([
        `IssueContent ${issue.id}`,
        `IssueHistory ${issue.history}`,
        `Comment ${issue.comment}`,
      ]),
    );
    expect(body).toContain(SECRET);
  });

  it('refuses an API key before reading anything, a key limited to ENG naming OPS included', async () => {
    const { status, body } = await content('key', [issueParent(opsIssues[state].id)]);
    expect(status).toBe(403);
    expect(body).not.toContain(opsIssues[state].id);
    expect(body).not.toContain(OPS_SECRET);
  });
});

// ---------------------------------------------------------------------------------------------
// GET /files/:id (AC-11; SPEC-014 §4.2)

const MISSING = '01930000-0000-7000-8000-00000000dead';
type Way = 'GET' | 'HEAD' | 'If-None-Match' | '?download=1';
const WAYS: readonly Way[] = ['GET', 'HEAD', 'If-None-Match', '?download=1'];

function read(who: Name, fileId: string, way: Way): Promise<LightMyRequestResponse> {
  const cookie = cookies[who] ?? '';
  switch (way) {
    case 'GET':
      return app.inject({ method: 'GET', url: `/files/${fileId}`, headers: { cookie } });
    case 'HEAD':
      return app.inject({ method: 'HEAD', url: `/files/${fileId}`, headers: { cookie } });
    case 'If-None-Match':
      return app.inject({
        method: 'GET',
        url: `/files/${fileId}`,
        // The right ETag: a hidden file must not answer 304 and so confirm it exists.
        headers: { cookie, 'if-none-match': etags[fileId] ?? '"x"' },
      });
    case '?download=1':
      return app.inject({ method: 'GET', url: `/files/${fileId}?download=1`, headers: { cookie } });
  }
}

const ErrorBodySchema = z.object({
  ok: z.literal(false),
  error: z.object({ code: z.string(), message: z.string(), correlationId: z.string() }),
});

/** What a reader can compare between two answers: everything but the correlation id. */
function shape(response: LightMyRequestResponse) {
  const headers = { ...response.headers };
  for (const varying of ['date', 'x-request-id', 'content-length', 'connection', 'keep-alive']) {
    delete headers[varying];
  }
  if (response.body === '') return { status: response.statusCode, headers, body: '' };
  const { error } = ErrorBodySchema.parse(response.json());
  return {
    status: response.statusCode,
    headers,
    body: { code: error.code, message: error.message },
  };
}

describe.each(STATES)('GET /files/:id of a %s SEC issue’s files', (state) => {
  const files = () => [sec[state].file, sec[state].inline];

  it.each<Name>(['ana', 'zoe'])(
    'is the missing file’s 404 for %s, outside SEC, on every way of reading it',
    async (who) => {
      for (const fileId of files()) {
        for (const way of WAYS) {
          const response = await read(who, fileId, way);
          const answer = shape(response);
          const missing = shape(await read(who, MISSING, way === 'If-None-Match' ? 'GET' : way));
          expect({ fileId, way, ...answer }).toEqual({ fileId, way, ...missing });
          expect(answer.status).toBe(404);
          expectNoSec(response.body, `${who} ${way}`);
        }
      }
    },
  );

  it('is readable by SEC’s member, whatever its lifecycle state (the control)', async () => {
    for (const fileId of files()) {
      const response = await read('sam', fileId, 'GET');
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(`bytes of ${fileId}`);
    }
  });

  it('resolves for no API key limited to ENG: the same OPS files are unknown ids', async () => {
    const resolve = async (fileId: string) => {
      try {
        return (
          await lookup('FileRef', fileId, {
            db: h.pool,
            actor: engKeyActor,
            path: ['file'],
            allowInactive: false,
            allowDetached: false,
          })
        ).id;
      } catch (error) {
        const parsed = z.object({ code: z.string(), message: z.string() }).parse(error);
        return { code: parsed.code, message: parsed.message.replace(fileId, '<id>') };
      }
    };
    for (const fileId of [opsIssues[state].file, opsIssues[state].inline]) {
      const answer = await resolve(fileId);
      expect(answer).toMatchObject({ code: 'NOT_FOUND' });
      expect(answer).toEqual(await resolve(MISSING));
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Deltas: U, A, V, D (AC-11)

function connect(who: Who, since: number, teams: readonly string[]) {
  const raw: string[] = [];
  const deltas: DeltasMessage[] = [];
  const query = encodeSocketConnectParams({
    since,
    clientId: randomUUID(),
    userId: userOf(who),
    schemaHash: registry.schemaHash,
    teams: [...teams],
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

/** `action model id` of each packet. */
const described = (packets: readonly DeltaPacket[]) =>
  packets.flatMap((p) =>
    p.a === 'G' ? [] : [`${p.a} ${p.m} ${p.a === 'D' ? p.mid : String(p.d['id'])}`],
  );

describe('the lifecycle deltas of SEC issues', () => {
  it('never reach a Member’s or an Admin’s connection outside SEC, and sit in SEC’s group only', async () => {
    const at = await head();
    // The outsiders ask for SEC as well: asking is ignored like an unknown team (SPEC-011 §5.7).
    const outsider = connect('outsider', at, [h.teams.eng, h.teams.sec]);
    const admin = connect('admin', at, [h.teams.eng, h.teams.sec]);
    const member = connect('member', at, [h.teams.sec]);
    try {
      const trashed = uuidv7();
      const archived = uuidv7();
      const purged = uuidv7();
      const link = uuidv7();
      const archivedLink = uuidv7();
      await ok('issue.create', { id: trashed, team: 'SEC', title: SECRET }, samActor);
      await ok(
        'issue.create',
        { id: archived, team: 'SEC', title: SECRET, status: 'Done' },
        samActor,
      );
      await ok('issue.create', { id: purged, team: 'SEC', title: SECRET }, samActor);
      await ok('attachment.createLink', { id: link, issue: trashed, url: SECRET_URL }, samActor);
      await ok(
        'attachment.createLink',
        { id: archivedLink, issue: archived, url: SECRET_URL },
        samActor,
      );
      const after = await head();
      // U and U (with the Attachment re-log), as `issue.delete` and `issue.restore` write them.
      await ok('issue.delete', { issue: trashed }, samActor);
      await ok('issue.restore', { issue: trashed }, samActor);
      // A from the job, then V (with the re-log) from a restore.
      await ageClosed(archived);
      await ok('issue.autoArchive', { issue: archived }, systemActor());
      await ok('issue.restore', { issue: archived }, samActor);
      // D from the job's purge, due 721 h after the delete (test setup, as in issue-leak).
      await ok('issue.delete', { issue: purged }, samActor);
      await h.pool.query(
        `UPDATE issues SET deleted_at = deleted_at - interval '721 hours' WHERE id = $1`,
        [purged],
      );
      expect(await ok('issue.purge', { issue: purged }, systemActor())).toEqual({ purged: true });
      // Written last: once they arrive, anything earlier would have arrived too.
      const marker = uuidv7();
      const secMarker = uuidv7();
      await ok('issue.create', { id: marker, team: 'ENG', title: 'Marker' }, anaActor);
      await ok('issue.create', { id: secMarker, team: 'SEC', title: 'Marker' }, samActor);
      await eventually(
        () =>
          outsider.text().includes(marker) &&
          admin.text().includes(marker) &&
          member.text().includes(secMarker),
      );
      for (const [who, connection] of [
        ['outsider', outsider],
        ['admin', admin],
      ] as const) {
        const text = connection.text();
        for (const mark of [trashed, archived, purged, link, archivedLink]) {
          expect(text, `${who}: ${mark}`).not.toContain(mark);
        }
        expectNoSec(text, who);
      }
      // Each transition's packets, in SEC's group only.
      const { rows } = await h.pool.query<{ entry: string; groups: string[] }>(
        `SELECT action || ' ' || model || ' ' || model_id AS entry, groups FROM sync_log
          WHERE sync_id > $1 AND model_id = ANY($2::uuid[]) ORDER BY sync_id`,
        [after, [trashed, archived, purged, link, archivedLink]],
      );
      expect(rows.map((r) => r.entry)).toEqual(
        expect.arrayContaining([
          `U Issue ${trashed}`,
          `U Attachment ${link}`,
          `A Issue ${archived}`,
          `V Issue ${archived}`,
          `U Attachment ${archivedLink}`,
          `D Issue ${purged}`,
        ]),
      );
      for (const row of rows) expect(row.groups, row.entry).toEqual([secGroup]);
      // The control: SEC's member, subscribed to SEC, gets them.
      expect(described(member.packets())).toEqual(
        expect.arrayContaining([
          `U Issue ${trashed}`,
          `U Attachment ${link}`,
          `A Issue ${archived}`,
          `V Issue ${archived}`,
          `U Attachment ${archivedLink}`,
          `D Issue ${purged}`,
        ]),
      );
    } finally {
      outsider.close();
      admin.close();
      member.close();
    }
  });

  it('refuses a socket to an API key, so a key limited to ENG gets no OPS delta either', async () => {
    const res = await app.inject({
      url: `/sync/bootstrap?userId=${users.zoe}`,
      headers: { 'x-test-actor': 'key' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain(ops);
  });
});

// ---------------------------------------------------------------------------------------------
// The catalog MCP's `search_operations` draws its examples from (AC-11, permissions.md §5)

const LIFECYCLE_OPERATIONS = [
  'issue.delete',
  'issue.restore',
  'issue.purge',
  'issue.listDeleted',
  'team.updateAutomations',
] as const;

const CatalogSchema = z.object({
  ok: z.literal(true),
  result: z.object({ operations: z.array(z.object({ name: z.string() }).passthrough()) }),
});

async function catalog(who: Who | 'key') {
  const res = await app.inject({ url: '/api/ops', headers: { 'x-test-actor': who } });
  expect(res.statusCode).toBe(200);
  return { body: res.body, operations: CatalogSchema.parse(res.json()).result.operations };
}

describe('GET /api/ops, where MCP’s search_operations takes its examples', () => {
  it('describes the lifecycle operations the same for everyone, and names nothing of SEC or OPS', async () => {
    const member = await catalog('member');
    const byName = new Map(member.operations.map((op) => [op.name, op]));
    for (const name of LIFECYCLE_OPERATIONS) expect(byName.has(name), name).toBe(true);
    // The jobs' operations are never listed (SPEC-003 §9).
    expect(byName.has('issue.autoArchive')).toBe(false);
    expect(byName.has('issue.autoClose')).toBe(false);
    for (const who of ['outsider', 'admin', 'key'] as const) {
      const { body, operations } = await catalog(who);
      expectNoSec(body, who);
      expect(body, who).not.toContain(ops);
      expect(body, who).not.toContain(OPS_SECRET);
      for (const op of operations) {
        if (!(LIFECYCLE_OPERATIONS as readonly string[]).includes(op.name)) continue;
        expect(op, `${who} ${op.name}`).toEqual(byName.get(op.name));
      }
      expect(operations.map((op) => op.name)).not.toContain('issue.autoArchive');
    }
  });
});
