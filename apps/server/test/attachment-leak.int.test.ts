// PLAN-014 S4a leak test (SPEC-014 AC-6, E5, E17; permissions.md §5; CLAUDE.md rule 4; not held,
// plans README §6). A member of private team SEC attaches a file and a link to a SEC issue,
// renames and removes them, through the real operations. For a user outside SEC (a Member and an
// Admin) and for the SEC member's own API key limited to ENG:
// - bootstrap, catch-up and live deltas carry no SEC Attachment row, nor its id, title or URL;
// - every attachment operation naming a SEC attachment (`AttachmentRef`), the SEC issue
//   (`IssueRef`) or a SEC file (`FileRef`) is `NOT_FOUND`, byte for byte as for an unknown id;
// - `createFile` refuses someone else's unclaimed upload exactly like an unknown file;
// - the `AttachmentRef` lookup narrows by a key's teams on its own (the backstop);
// - `sync_log` stores Attachment rows under `team:<teamId>` only: the assignee of a public team's
//   issue who doesn't follow that team gets the Issue (through `user:`) but none of its
//   attachments;
// - the outbox events carry ids, never a title or URL;
// - (PLAN-014 S4b, AC-8 leak half) a saved description or comment that references a SEC file, its
//   preview, a SEC inline image or someone else's unclaimed upload is refused byte for byte like
//   one referencing an unknown id, copying and claiming nothing.
// The SEC member gets everything, so the answers come from visibility, not a broken path.
import { randomUUID } from 'node:crypto';
import { teamGroup, type Actor } from '@surface/domain';
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
import { uuidv7 } from '../src/db/uuidv7.js';
import type { Executor } from '../src/executor/execute.js';
import { lookup } from '../src/executor/refs/sources.js';
import { seedTeamWorkflow, teamWorkflow } from '../src/handlers/teams/seed.js';
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
const ops = randomUUID(); // a public team nobody here is a member of
let anaActor: Actor;
let zoeActor: Actor;
let samActor: Actor;
/** Sam's own read-write key, limited to ENG: it must not reach SEC either (permissions §3.5). */
let samKeyActor: Actor;

const secIssue = uuidv7();
const engIssue = uuidv7();
const opsIssue = uuidv7();
const secFile = uuidv7();
const secFileAttachment = uuidv7();
const secLink = uuidv7();
/** Sam's unclaimed upload, which nobody else may attach. */
const samUpload = uuidv7();
const anaUpload = uuidv7();
const SECRET_TITLE = 'Leaked signing key report';
const SECRET_URL = 'https://vault.internal.example/keys/rotation';

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

/** An unclaimed `attachment` upload of `uploaderId` (server-only rows: plain SQL, no bytes). */
async function upload(id: string, uploaderId: string, name: string): Promise<void> {
  await h.pool.query(
    `INSERT INTO files (id, storage_key, purpose, name, mime_type, size, uploader_id)
     VALUES ($1, $2, 'attachment', $3, 'application/pdf', 2048, $4)`,
    [id, `sha256/00/${id}`, name, uploaderId],
  );
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
  const publicTeams = [h.teams.eng, ops];
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

  // The copy branch checks the bytes are there (SPEC-014 §4.3): these rows' keys have none.
  executor = testExecutor(h.pool, {
    blobs: { stat: () => Promise.resolve({ size: 2048 }) },
  }).executor;
  await ok('issue.create', { id: secIssue, team: 'SEC', title: 'Secret work' }, samActor);
  await ok('issue.create', { id: engIssue, team: 'ENG', title: 'Fix login' }, anaActor);
  // OPS is public; Ana is its issue's assignee but not a member, so her connection doesn't follow it.
  await ok(
    'issue.create',
    { id: opsIssue, team: 'OPS', title: 'Renew the cert', assignee: ana },
    zoeActor,
  );
  await upload(secFile, sam, 'keys.pdf');
  await upload(samUpload, sam, 'draft.pdf');
  await upload(anaUpload, ana, 'notes.pdf');
  await ok(
    'attachment.createFile',
    { id: secFileAttachment, issue: secIssue, file: secFile, title: SECRET_TITLE },
    samActor,
  );
  await ok(
    'attachment.createLink',
    { id: secLink, issue: secIssue, url: SECRET_URL, title: SECRET_TITLE },
    samActor,
  );

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
  await hub?.stop();
  await app?.close();
  await h?.close();
});

type Who = 'outsider' | 'admin' | 'member';
const userOf = (who: Who) => ({ outsider: ana, admin: zoe, member: sam })[who];
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
const secMarks = () => [
  secIssue,
  secFile,
  secFileAttachment,
  secLink,
  h.teams.sec,
  SECRET_TITLE,
  SECRET_URL,
];
function expectNoSec(text: string) {
  for (const mark of secMarks()) expect(text).not.toContain(mark);
}

// ---------------------------------------------------------------------------------------------
// Sync: bootstrap, catch-up, live

async function bootstrap(who: Who) {
  const res = await app.inject({
    url: `/sync/bootstrap?userId=${userOf(who)}`,
    headers: { 'x-test-actor': who },
  });
  expect(res.statusCode).toBe(200);
  const decoder = new NdjsonDecoder();
  const rows = [...decoder.push(new Uint8Array(res.rawPayload)), ...decoder.end()]
    .map(decodeBootstrapFrame)
    .filter((f): f is Extract<BootstrapFrame, { t: 'row' }> => f.t === 'row');
  return { body: res.body, rows };
}

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

/** `action id` of every Attachment packet. */
const attachmentPackets = (packets: readonly DeltaPacket[]) =>
  packets.flatMap((p) => {
    if (p.a === 'G' || p.m !== 'Attachment') return [];
    return [`${p.a} ${p.a === 'D' ? p.mid : String(p.d['id'])}`];
  });

describe('SEC attachments in sync (AC-6)', () => {
  it.each<Who>(['outsider', 'admin'])(
    'are not in the %s’s bootstrap; the member gets them in SEC’s group only',
    async (who) => {
      const { body, rows } = await bootstrap(who);
      expect(rows.filter((r) => r.m === 'Attachment')).toEqual([]);
      expectNoSec(body);
      const member = await bootstrap('member');
      const held = member.rows.filter((r) => r.m === 'Attachment');
      expect(held.map((r) => r.d.id).sort()).toEqual([secFileAttachment, secLink].sort());
      for (const row of held) expect(row.d['groups']).toEqual([teamGroup(h.teams.sec)]);
    },
  );

  it('are not in an outsider’s catch-up', async () => {
    // An ENG attachment written last, before connecting: once it arrives, the catch-up is done.
    const marker = uuidv7();
    await ok(
      'attachment.createLink',
      { id: marker, issue: engIssue, url: 'https://example.com/catch-up' },
      anaActor,
    );
    const last = await head();
    const outsiderSocket = connect('outsider', 0);
    try {
      await eventually(() => outsiderSocket.packets().some((p) => p.id >= last));
      expect(attachmentPackets(outsiderSocket.packets())).toEqual([`I ${marker}`]);
      expectNoSec(outsiderSocket.text());
    } finally {
      outsiderSocket.close();
    }
  });

  it('created, renamed and removed live never reach an outsider; the member gets each', async () => {
    const at = await head();
    const outsiderSocket = connect('outsider', at);
    const adminSocket = connect('admin', at);
    const memberSocket = connect('member', at);
    try {
      const live = uuidv7();
      await ok(
        'attachment.createLink',
        { id: live, issue: secIssue, url: `${SECRET_URL}/live`, title: 'Live secret' },
        samActor,
      );
      await ok('attachment.update', { attachment: live, title: 'Live secret, renamed' }, samActor);
      await ok('attachment.delete', { attachment: live }, samActor);
      // Written last, one per connection (each follows its member teams, SPEC-011 §5.7).
      const marker = uuidv7();
      const secMarker = uuidv7();
      await ok(
        'attachment.createLink',
        { id: marker, issue: engIssue, url: 'https://example.com/marker' },
        anaActor,
      );
      await ok(
        'attachment.createLink',
        { id: secMarker, issue: secIssue, url: 'https://example.com/marker' },
        samActor,
      );
      await eventually(
        () =>
          outsiderSocket.text().includes(marker) &&
          adminSocket.text().includes(marker) &&
          memberSocket.text().includes(secMarker),
      );
      for (const c of [outsiderSocket, adminSocket]) {
        expect(attachmentPackets(c.packets())).toEqual([`I ${marker}`]);
        for (const mark of [live, secIssue, h.teams.sec, 'Live secret', SECRET_URL]) {
          expect(c.text()).not.toContain(mark);
        }
      }
      expect(attachmentPackets(memberSocket.packets())).toEqual(
        expect.arrayContaining([`I ${live}`, `U ${live}`, `D ${live}`, `I ${secMarker}`]),
      );
    } finally {
      outsiderSocket.close();
      adminSocket.close();
      memberSocket.close();
    }
  });

  it('never reach the assignee of a public team’s issue who doesn’t follow that team (§4.1)', async () => {
    const at = await head();
    const anaSocket = connect('outsider', at);
    try {
      const opsAttachment = uuidv7();
      await ok(
        'attachment.createLink',
        { id: opsAttachment, issue: opsIssue, url: 'https://example.com/cert', title: 'Cert' },
        zoeActor,
      );
      // An issue change Ana does get, through `user:<ana>`, written last.
      await ok('issue.update', { issue: opsIssue, title: 'Renew the cert today' }, zoeActor);
      await eventually(() => anaSocket.text().includes('Renew the cert today'));
      expect(attachmentPackets(anaSocket.packets())).toEqual([]);
      expect(anaSocket.text()).not.toContain(opsAttachment);
      const { rows } = await h.pool.query<{ groups: string[] }>(
        `SELECT groups FROM sync_log WHERE model = 'Attachment' AND model_id = $1`,
        [opsAttachment],
      );
      expect(rows.map((r) => r.groups)).toEqual([[teamGroup(ops)]]);
    } finally {
      anaSocket.close();
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

describe('attachment operations on SEC rows (AC-6, E5, E17)', () => {
  it.each(OUTSIDERS)(
    'an AttachmentRef to a SEC attachment is NOT_FOUND, worded as a missing one, for %s',
    async (who) => {
      const actor = outsider(who);
      const missingId = uuidv7();
      const inputs: [string, (attachment: string) => object][] = [
        ['attachment.update', (attachment) => ({ attachment, title: 'Mine now' })],
        ['attachment.delete', (attachment) => ({ attachment })],
      ];
      for (const target of [secLink, secFileAttachment]) {
        for (const [operation, input] of inputs) {
          const hidden = await refusal(operation, input(target), actor);
          const missing = await refusal(operation, input(missingId), actor);
          expect({ operation, code: hidden.code }).toEqual({ operation, code: 'NOT_FOUND' });
          expect(errorShape(hidden, target)).toBe(errorShape(missing, missingId));
        }
      }
      const { rows } = await h.pool.query<{ id: string; title: string }>(
        'SELECT id, title FROM attachments WHERE issue_id = $1 ORDER BY id',
        [secIssue],
      );
      expect(rows.filter((r) => r.id === secLink || r.id === secFileAttachment)).toHaveLength(2);
      for (const row of rows) expect(row.title).not.toBe('Mine now');
    },
  );

  it.each(OUTSIDERS)(
    'attaching to the SEC issue is NOT_FOUND, worded as a missing issue, for %s',
    async (who) => {
      const actor = outsider(who);
      const missingId = uuidv7();
      const inputs: [string, (issue: string) => object][] = [
        ['attachment.createLink', (issue) => ({ issue, url: 'https://example.com/x' })],
        ['attachment.createFile', (issue) => ({ issue, file: anaUpload })],
      ];
      for (const [operation, input] of inputs) {
        const hidden = await refusal(operation, input(secIssue), actor);
        const missing = await refusal(operation, input(missingId), actor);
        expect({ operation, code: hidden.code }).toEqual({ operation, code: 'NOT_FOUND' });
        expect(errorShape(hidden, secIssue)).toBe(errorShape(missing, missingId));
      }
    },
  );

  it.each(OUTSIDERS)(
    'a FileRef to a SEC file is NOT_FOUND, worded as a missing file, for %s (E17)',
    async (who) => {
      const actor = outsider(who);
      const missingId = uuidv7();
      const hidden = await refusal(
        'attachment.createFile',
        { issue: engIssue, file: secFile },
        actor,
      );
      const missing = await refusal(
        'attachment.createFile',
        { issue: engIssue, file: missingId },
        actor,
      );
      expect(hidden.code).toBe('NOT_FOUND');
      expect(errorShape(hidden, secFile)).toBe(errorShape(missing, missingId));
    },
  );

  it('refuses someone else’s unclaimed upload exactly like an unknown file, and leaves it unclaimed', async () => {
    const missingId = uuidv7();
    const borrowed = await refusal(
      'attachment.createFile',
      { issue: engIssue, file: samUpload },
      anaActor,
    );
    const missing = await refusal(
      'attachment.createFile',
      { issue: engIssue, file: missingId },
      anaActor,
    );
    expect(borrowed.code).toBe('NOT_FOUND');
    expect(errorShape(borrowed, samUpload)).toBe(errorShape(missing, missingId));
    const { rows } = await h.pool.query<{ issue_id: string | null }>(
      'SELECT issue_id FROM files WHERE id = $1',
      [samUpload],
    );
    expect(rows).toEqual([{ issue_id: null }]);
  });

  it('gives the SEC member the attachments in issue.get, and outsiders’ issue.get of ENG none of them', async () => {
    const sec = (await ok('issue.get', { issue: secIssue }, samActor)) as {
      attachments: { id: string; downloadUrl: string | null }[];
    };
    expect(sec.attachments.map((a) => a.id)).toEqual(
      expect.arrayContaining([secFileAttachment, secLink]),
    );
    expect(sec.attachments.find((a) => a.id === secFileAttachment)?.downloadUrl).toMatch(
      new RegExp(`/files/${secFile}$`),
    );
    const eng = (await ok('issue.get', { issue: engIssue }, anaActor)) as object;
    expectNoSec(JSON.stringify(eng));
  });
});

describe('documents referencing SEC files (SPEC-014 §4.3, AC-8 leak half, E17)', () => {
  /** A preview of the SEC attachment's file, and an inline image of the SEC issue (plain SQL). */
  const secPreview = uuidv7();
  const secInline = uuidv7();
  /** Sam's unclaimed inline upload, which only Sam may claim. */
  const samInline = uuidv7();
  beforeAll(async () => {
    await h.pool.query(
      `INSERT INTO files (id, storage_key, purpose, name, mime_type, size, uploader_id, preview_of)
       VALUES ($1, $2, 'preview', 'keys.webp', 'image/webp', 512, $3, $4)`,
      [secPreview, `sha256/00/${secPreview}`, sam, secFile],
    );
    for (const [id, issueId] of [
      [secInline, secIssue],
      [samInline, null],
    ] as const) {
      await h.pool.query(
        `INSERT INTO files (id, storage_key, purpose, name, mime_type, size, uploader_id, issue_id)
         VALUES ($1, $2, 'inline', 'diagram.png', 'image/png', 1024, $3, $4)`,
        [id, `sha256/00/${id}`, sam, issueId],
      );
    }
  });

  const docWith = (fileId: string) => ({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Look:' }] },
      { type: 'image', attrs: { src: `/files/${fileId}`, alt: null } },
    ],
  });
  /** Each operation that saves a document, saving one that references `fileId` on ENG. */
  const saves = async (actor: Actor): Promise<[string, (fileId: string) => object][]> => {
    const { version } = (await ok('issue.get', { issue: engIssue }, actor)) as { version: number };
    return [
      ['issue.create', (f) => ({ team: 'ENG', title: 'Copy', description: docWith(f) })],
      [
        'issue.updateDescription',
        (f) => ({ issue: engIssue, baseVersion: version, description: docWith(f) }),
      ],
      ['comment.create', (f) => ({ issue: engIssue, body: docWith(f) })],
    ];
  };
  const fileCount = async () =>
    Number((await h.pool.query<{ n: string }>('SELECT count(*) AS n FROM files')).rows[0]?.n);

  it.each(OUTSIDERS)(
    'a document naming a SEC file, its preview or a SEC inline image is refused exactly like an unknown id, for %s',
    async (who) => {
      const actor = outsider(who);
      const before = await fileCount();
      for (const [operation, input] of await saves(actor)) {
        const missingId = uuidv7();
        const missing = await refusal(operation, input(missingId), actor);
        expect({ operation, code: missing.code }).toEqual({ operation, code: 'INVALID_INPUT' });
        // Sam's own upload is his key's to claim (D25), so it is hidden from the others only.
        const hiddenIds = [
          secFile,
          secPreview,
          secInline,
          ...(actor.userId === sam ? [] : [samInline]),
        ];
        for (const hiddenId of hiddenIds) {
          const hidden = await refusal(operation, input(hiddenId), actor);
          expect({ operation, hiddenId, shape: errorShape(hidden, hiddenId) }).toEqual({
            operation,
            hiddenId,
            shape: errorShape(missing, missingId),
          });
        }
      }
      // Nothing copied or claimed.
      expect(await fileCount()).toBe(before);
      const { rows } = await h.pool.query<{ issue_id: string | null }>(
        'SELECT issue_id FROM files WHERE id = $1',
        [samInline],
      );
      expect(rows).toEqual([{ issue_id: null }]);
    },
  );

  it('lets the SEC member copy the SEC file into an ENG comment, as a new inline row on the same bytes', async () => {
    const comment = (await ok(
      'comment.create',
      { issue: engIssue, body: docWith(secFile) },
      samActor,
    )) as { id: string };
    const { rows } = await h.pool.query<{ body: unknown }>(
      'SELECT body FROM comments WHERE id = $1',
      [comment.id],
    );
    const stored = JSON.stringify(rows[0]?.body);
    expect(stored).not.toContain(secFile);
    const copyId = /\/files\/([0-9a-f-]{36})/.exec(stored)?.[1];
    const copy = await h.pool.query<{ purpose: string; issue_id: string; storage_key: string }>(
      'SELECT purpose, issue_id, storage_key FROM files WHERE id = $1',
      [copyId],
    );
    expect(copy.rows).toEqual([
      { purpose: 'inline', issue_id: engIssue, storage_key: `sha256/00/${secFile}` },
    ]);
  });
});

describe('the AttachmentRef lookup on its own', () => {
  // The executor's key scope (`key-scope.ts`) also refuses a row outside the key's teams; the
  // lookup's own `team_id` clause is the backstop, so it is checked without the executor.
  const resolve = async (actor: Actor) => {
    try {
      const row = await lookup('AttachmentRef', secLink, {
        db: h.pool,
        actor,
        path: ['attachment'],
        allowInactive: false,
      });
      return row.id;
    } catch (error) {
      return (error as { code: string }).code;
    }
  };

  it('finds a SEC attachment for Sam, and not for Sam’s key limited to ENG, or anyone outside SEC', async () => {
    expect(await resolve(samActor)).toBe(secLink);
    expect(await resolve(samKeyActor)).toBe('NOT_FOUND');
    expect(await resolve(anaActor)).toBe('NOT_FOUND');
    expect(await resolve(zoeActor)).toBe('NOT_FOUND');
  });
});

describe('stored SEC attachment rows', () => {
  it('are logged under team:<SEC> only', async () => {
    const { rows } = await h.pool.query<{ groups: string[] }>(
      `SELECT groups FROM sync_log WHERE model = 'Attachment' AND model_id = ANY($1::uuid[])`,
      [[secFileAttachment, secLink]],
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.groups).toEqual([teamGroup(h.teams.sec)]);
  });

  it('give outbox events with ids, never a title or URL', async () => {
    const { rows } = await h.pool.query<{ type: string; doc: string }>(
      `SELECT type, row_to_json(e)::text AS doc FROM event_outbox e WHERE type LIKE 'attachment.%'`,
    );
    expect(rows.map((r) => r.type)).toEqual(
      expect.arrayContaining(['attachment.created', 'attachment.deleted']),
    );
    for (const row of rows) {
      expect(row.doc).not.toContain(SECRET_TITLE);
      expect(row.doc).not.toContain(SECRET_URL);
      expect(row.doc).not.toContain('Live secret');
    }
  });
});
