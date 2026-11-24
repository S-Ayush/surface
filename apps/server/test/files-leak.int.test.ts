// PLAN-014 S1 leak suite (SPEC-014 §4.2 matrix, AC-5, E5, E16; permissions.md §5; not held, plans
// README §6): every file read goes through one rule, on real Postgres, with real session cookies.
// The cells that need no issue: avatar, logo, own and someone else's unclaimed upload, a file an
// issue owns (no uploader exception), a detached file, a preview of an unclaimed file, and an API
// key's team limit. Each on `GET`, `HEAD`, `GET` with a matching `If-None-Match`, and
// `?download=1`; every 404 is identical to a missing file's apart from `correlationId`. PLAN-014
// S4a: owned files belong to real issues (`files.issue_id` has its foreign key), which adds the
// cells that need one: a public team's issue (live, archived, deleted), a private team's issue
// (its uploader outside the team gets nothing, E16), a preview of a visible and of an invisible
// source, a key limited to other teams, and FileRef's detached-file lookup (D28).
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Actor } from '@surface/domain';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { CSRF_HEADER } from '@surface/sync-protocol';
import { csrfToken } from '../src/auth/csrf.js';
import { createSession, SESSION_COOKIE } from '../src/auth/session.js';
import { SessionAuth } from '../src/auth/sessions.js';
import { pgAuthStore } from '../src/auth/store.js';
import type { FilePurpose } from '../src/db/schema/index.js';
import { uuidv7 } from '../src/db/uuidv7.js';
import { lookup } from '../src/executor/refs/sources.js';
import { transactionRunner } from '../src/executor/transaction.js';
import { localBlobStore } from '../src/files/blob-store.js';
import { PG_FILE_STORE } from '../src/files/store.js';
import { Lifecycle } from '../src/lifecycle.js';
import { createLogger } from '../src/logger.js';
import { syncRepo } from '../src/sync/repo.js';
import { FakeAttempts } from './auth-fakes.js';
import { executorHarness, testExecutor, type ExecutorHarness } from './executor.js';
import { actorFor, captureLogs, testConfig } from './helpers.js';

const users = {
  ada: randomUUID(), // uploads everything below; member of ENG
  ben: randomUUID(), // another member of ENG
  sam: randomUUID(), // the only member of private team SEC
} as const;
/** ENG (public) issues, live, archived and deleted, and a SEC (private) issue. */
const issues = {
  eng: uuidv7(),
  archived: uuidv7(),
  deleted: uuidv7(),
  sec: uuidv7(),
} as const;
type Who = keyof typeof users;

let h: ExecutorHarness;
let app: FastifyInstance;
let dataDir: string;
const cookies: Partial<Record<Who, string>> = {};
const csrf: Partial<Record<Who, string>> = {};
const ids: Record<string, string> = {};
const etags: Record<string, string> = {};

beforeAll(async () => {
  h = await executorHarness();
  dataDir = await mkdtemp(path.join(tmpdir(), 'surface-files-leak-'));
  const blobs = localBlobStore(path.join(dataDir, 'uploads'));

  const client = await h.pool.connect();
  try {
    await client.query('BEGIN');
    const repo = syncRepo(drizzle({ client, casing: 'snake_case' }), new Date());
    const workspaceId = randomUUID();
    await repo.insert('Workspace', { id: workspaceId, name: 'Acme', syncGroups: [] });
    for (const [name, id] of Object.entries(users)) {
      await repo.insert('User', {
        id,
        email: `${name}@example.com`,
        name,
        displayName: name,
        syncGroups: [],
      });
    }
    const member = (teamId: string, userId: string) =>
      repo.insert('TeamMembership', { id: randomUUID(), teamId, userId, syncGroups: [] });
    await member(h.teams.eng, users.ada);
    await member(h.teams.eng, users.ben);
    await member(h.teams.sec, users.sam);
    await repo.flush({});
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    client.release();
    throw error;
  }
  // The issues, through the real operation (PLAN-014 S4a: files name real issues).
  const { executor } = testExecutor(h.pool);
  const publicTeams = [h.teams.eng];
  const adaActor = actorFor({
    id: users.ada,
    memberships: [{ teamId: h.teams.eng, private: false }],
    publicTeams,
  });
  const samActor = actorFor({
    id: users.sam,
    memberships: [{ teamId: h.teams.sec, private: true }],
    publicTeams,
  });
  for (const [id, team, actor] of [
    [issues.eng, 'ENG', adaActor],
    [issues.archived, 'ENG', adaActor],
    [issues.deleted, 'ENG', adaActor],
    [issues.sec, 'SEC', samActor],
  ] as const) {
    const result = await executor.execute('issue.create', { id, team, title: 'Files' }, actor);
    if (!result.ok) throw new Error(result.error.message);
  }

  try {
    await client.query('BEGIN');
    const repo = syncRepo(drizzle({ client, casing: 'snake_case' }), new Date());
    const workspaceId = (await client.query<{ id: string }>('SELECT id FROM workspace LIMIT 1'))
      .rows[0]?.id;
    if (workspaceId === undefined) throw new Error('no workspace');
    // Archived and deleted, through the repo like the jobs and `issue.delete` write them.
    await repo.update('Issue', issues.archived, { archivedAt: new Date() });
    await repo.update('Issue', issues.deleted, { deletedAt: new Date(), deletedById: users.ada });

    // Distinct bytes per file, so each has its own key and ETag.
    const file = async (
      label: string,
      purpose: FilePurpose,
      extra: { issueId?: string; detached?: boolean; previewOf?: string } = {},
    ) => {
      const temp = await blobs.putStream(Readable.from([Buffer.from(`bytes of ${label}`)]));
      const storageKey = temp.key;
      const id = uuidv7();
      await PG_FILE_STORE.insertUpload(client, blobs, temp, {
        id,
        purpose,
        name: `${label}.bin`,
        mimeType: 'application/octet-stream',
        size: 9 + label.length,
        uploaderId: users.ada,
        issueId: extra.issueId ?? null,
        previewOf: extra.previewOf ?? null,
      });
      if (extra.detached) {
        await client.query('UPDATE files SET detached_at = now() WHERE id = $1', [id]);
      }
      ids[label] = id;
      etags[label] = `"${storageKey.slice(storageKey.lastIndexOf('/') + 1)}"`;
      return id;
    };
    await file('unclaimedAttachment', 'attachment');
    await file('unclaimedInline', 'inline');
    // Ada's uploads, claimed by issues: a public team's (live, archived, deleted) and SEC's.
    await file('engAttachment', 'attachment', { issueId: issues.eng });
    await file('engInline', 'inline', { issueId: issues.eng });
    await file('archivedAttachment', 'attachment', { issueId: issues.archived });
    await file('deletedAttachment', 'attachment', { issueId: issues.deleted });
    await file('secAttachment', 'attachment', { issueId: issues.sec });
    await file('secInline', 'inline', { issueId: issues.sec });
    await file('detached', 'attachment', { issueId: issues.eng, detached: true });
    await file('secDetached', 'attachment', { issueId: issues.sec, detached: true });
    await file('previewOfUnclaimed', 'preview', { previewOf: ids['unclaimedAttachment'] ?? '' });
    await file('previewOfEng', 'preview', { previewOf: ids['engAttachment'] ?? '' });
    await file('previewOfSec', 'preview', { previewOf: ids['secAttachment'] ?? '' });
    await file('previewOfDetached', 'preview', { previewOf: ids['detached'] ?? '' });
    await file('unusedAvatar', 'avatar');
    await file('unusedLogo', 'logo');
    await repo.update('User', users.ada, { avatarFileId: await file('avatar', 'avatar') });
    await repo.update('Workspace', workspaceId, { logoFileId: await file('logo', 'logo') });
    await repo.flush({});
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  for (const [name, id] of Object.entries(users)) {
    const session = await createSession(h.pool, {
      userId: id,
      userAgent: undefined,
      ip: undefined,
      now: new Date(),
    });
    cookies[name as Who] = `${SESSION_COOKIE}=${session.token}`;
    csrf[name as Who] = csrfToken(testConfig().sessionSecret, session.id);
  }

  const config = testConfig({ dataDir });
  const lifecycle = new Lifecycle();
  const store = pgAuthStore(h.pool);
  app = await buildApp({
    config,
    lifecycle,
    logger: createLogger(config, captureLogs().stream),
    auth: {
      auth: new SessionAuth(store),
      store,
      attempts: new FakeAttempts(),
      withTransaction: transactionRunner(h.pool),
    },
  });
  lifecycle.markReady();
});
afterAll(async () => {
  await app?.close();
  await h?.close();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

const MISSING = '01930000-0000-7000-8000-00000000dead';

type Way = 'GET' | 'HEAD' | 'If-None-Match' | '?download=1';
const WAYS: readonly Way[] = ['GET', 'HEAD', 'If-None-Match', '?download=1'];

function read(who: Who, label: string, way: Way): Promise<LightMyRequestResponse> {
  const id = ids[label] ?? MISSING;
  const cookie = cookies[who] ?? '';
  switch (way) {
    case 'GET':
      return app.inject({ method: 'GET', url: `/files/${id}`, headers: { cookie } });
    case 'HEAD':
      return app.inject({ method: 'HEAD', url: `/files/${id}`, headers: { cookie } });
    case 'If-None-Match':
      return app.inject({
        method: 'GET',
        url: `/files/${id}`,
        // The right ETag: a hidden file must not answer 304 and so confirm it exists.
        headers: { cookie, 'if-none-match': etags[label] ?? '"x"' },
      });
    case '?download=1':
      return app.inject({ method: 'GET', url: `/files/${id}?download=1`, headers: { cookie } });
  }
}

/** What a reader can compare between two answers: everything but the correlation id. */
function shape(response: LightMyRequestResponse) {
  const headers = { ...response.headers };
  for (const varying of ['date', 'x-request-id', 'content-length', 'connection', 'keep-alive']) {
    delete headers[varying];
  }
  const body: unknown = response.body === '' ? '' : response.json();
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const { error } = body as { error: Record<string, unknown> };
    expect(typeof error['correlationId']).toBe('string');
    delete error['correlationId'];
  }
  return { status: response.statusCode, headers, body };
}

async function expectHidden(who: Who, label: string): Promise<void> {
  for (const way of WAYS) {
    const answer = shape(await read(who, label, way));
    const missing = shape(await read(who, 'missing', way === 'If-None-Match' ? 'GET' : way));
    expect({ who, label, way, ...answer }).toEqual({ who, label, way, ...missing });
    expect(answer.status).toBe(404);
  }
}

async function expectVisible(who: Who, label: string): Promise<void> {
  const get = await read(who, label, 'GET');
  expect({ who, label, status: get.statusCode }).toEqual({ who, label, status: 200 });
  expect(get.body).toBe(`bytes of ${label}`);
  expect((await read(who, label, 'HEAD')).statusCode).toBe(200);
  expect((await read(who, label, 'If-None-Match')).statusCode).toBe(304);
  expect((await read(who, label, '?download=1')).statusCode).toBe(200);
}

describe('a missing file (the reference answer)', () => {
  it('is 404 NOT_FOUND on every way of reading it', async () => {
    for (const way of WAYS) {
      const response = await read('ada', 'missing', way);
      expect(response.statusCode).toBe(404);
      if (way !== 'HEAD') expect(response.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
  });
});

describe('the SPEC-014 §4.2 matrix, cells without an issue (AC-5)', () => {
  it('unclaimed attachment or inline upload: its uploader only', async () => {
    for (const label of ['unclaimedAttachment', 'unclaimedInline']) {
      await expectVisible('ada', label);
      await expectHidden('ben', label);
      await expectHidden('sam', label);
    }
  });

  it('a detached file is readable by nobody, its uploader and its issue’s readers included (E8)', async () => {
    for (const label of ['detached', 'secDetached', 'previewOfDetached']) {
      for (const who of ['ada', 'ben', 'sam'] as const) await expectHidden(who, label);
    }
  });

  it('a preview of an unclaimed upload is readable by nobody, its source’s uploader included', async () => {
    for (const who of ['ada', 'ben', 'sam'] as const) {
      await expectHidden(who, 'previewOfUnclaimed');
    }
  });

  it('avatar and logo in use: the M0 rule, everyone', async () => {
    for (const label of ['avatar', 'logo']) {
      for (const who of ['ada', 'ben', 'sam'] as const) await expectVisible(who, label);
    }
  });

  it('an avatar or logo nothing uses yet: the M0 rule, its uploader only', async () => {
    for (const label of ['unusedAvatar', 'unusedLogo']) {
      await expectVisible('ada', label);
      await expectHidden('ben', label);
      await expectHidden('sam', label);
    }
  });
});

describe('the SPEC-014 §4.2 matrix, cells with an issue (AC-5, PLAN-014 S4a)', () => {
  it('a public team’s issue: everyone who sees the issue, whatever its lifecycle state', async () => {
    for (const label of ['engAttachment', 'engInline', 'archivedAttachment', 'deletedAttachment']) {
      // Ben and Sam never uploaded it; Sam isn't a member of ENG, which is public.
      for (const who of ['ada', 'ben', 'sam'] as const) await expectVisible(who, label);
    }
  });

  it('a private team’s issue: its members only; its uploader outside the team gets nothing (E5, E16)', async () => {
    for (const label of ['secAttachment', 'secInline']) {
      await expectVisible('sam', label);
      await expectHidden('ada', label);
      await expectHidden('ben', label);
    }
  });

  it('a preview follows its source: visible with a visible one, hidden with a hidden one', async () => {
    for (const who of ['ada', 'ben', 'sam'] as const) await expectVisible(who, 'previewOfEng');
    await expectVisible('sam', 'previewOfSec');
    await expectHidden('ada', 'previewOfSec');
    await expectHidden('ben', 'previewOfSec');
  });
});

describe('a file uploaded through the streaming route (PLAN-014 S2)', () => {
  it('is its uploader’s alone until claimed, on every way of reading it', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/files/upload?purpose=attachment',
      payload: 'bytes of uploaded',
      headers: {
        cookie: cookies.ada ?? '',
        [CSRF_HEADER]: csrf.ada ?? '',
        'content-type': 'application/octet-stream',
        'x-file-name': 'plan.txt',
      },
    });
    expect(response.statusCode).toBe(201);
    const { result } = response.json<{ result: { id: string } }>();
    ids['uploaded'] = result.id;
    const { rows } = await h.pool.query<{ storage_key: string; issue_id: string | null }>(
      'SELECT storage_key, issue_id FROM files WHERE id = $1',
      [result.id],
    );
    expect(rows[0]?.issue_id).toBeNull();
    const key = rows[0]?.storage_key ?? '';
    etags['uploaded'] = `"${key.slice(key.lastIndexOf('/') + 1)}"`;
    await expectVisible('ada', 'uploaded');
    await expectHidden('ben', 'uploaded');
    await expectHidden('sam', 'uploaded');
  });
});

describe('FileRef resolves by the same rule (permissions.md §4)', () => {
  const resolve = async (label: string, actor: Actor) => {
    try {
      const row = await lookup('FileRef', ids[label] ?? MISSING, {
        db: h.pool,
        actor,
        path: ['file'],
        allowInactive: false,
      });
      return row.id;
    } catch (error) {
      const { code, message } = error as { code: string; message: string };
      return { code, message: message.replace(ids[label] ?? MISSING, '<id>') };
    }
  };
  // Every user sees public team ENG (SPEC-011 §5.6), as the session store says.
  const ada = () =>
    actorFor({
      id: users.ada,
      memberships: [{ teamId: h.teams.eng, private: false }],
      publicTeams: [h.teams.eng],
    });
  const ben = () =>
    actorFor({
      id: users.ben,
      memberships: [{ teamId: h.teams.eng, private: false }],
      publicTeams: [h.teams.eng],
    });
  const key = (teamIds: string[]) => () =>
    actorFor(
      {
        id: users.ada,
        memberships: [{ teamId: h.teams.eng, private: false }],
        publicTeams: [h.teams.eng],
      },
      {
        kind: 'api',
        apiKey: { id: randomUUID(), scope: 'read_write', teamIds, allowDestructive: false },
      },
    );

  const hidden = async (label: string, actor: Actor) =>
    expect(await resolve(label, actor)).toEqual(await resolve('missing', actor));

  const sam = () =>
    actorFor({
      id: users.sam,
      memberships: [{ teamId: h.teams.sec, private: true }],
      publicTeams: [h.teams.eng],
    });

  it('matches GET for a session, cell by cell', async () => {
    expect(await resolve('unclaimedAttachment', ada())).toBe(ids['unclaimedAttachment']);
    await hidden('unclaimedAttachment', ben());
    for (const label of ['engAttachment', 'engInline', 'archivedAttachment', 'previewOfEng']) {
      expect(await resolve(label, ben())).toBe(ids[label]);
    }
    for (const label of ['secAttachment', 'secInline', 'previewOfSec', 'previewOfUnclaimed']) {
      await hidden(label, ada());
    }
    expect(await resolve('secAttachment', sam())).toBe(ids['secAttachment']);
    expect(await resolve('avatar', ben())).toBe(ids['avatar']);
    expect(await resolve('logo', ben())).toBe(ids['logo']);
    await hidden('unusedAvatar', ben());
  });

  it('resolves a detached attachment file only for its issue’s readers, for the undo (D28)', async () => {
    // Unreadable as ever (GET above); `attachment.createFile` can name it again within 24 hours.
    expect(await resolve('detached', ben())).toBe(ids['detached']);
    expect(await resolve('secDetached', sam())).toBe(ids['secDetached']);
    await hidden('secDetached', ada());
    await hidden('secDetached', ben());
    await hidden('previewOfDetached', ben());
    await hidden('detached', key([h.teams.sec])());
  });

  it('a key limited to some teams reads no unclaimed upload, but the M0 rule still applies', async () => {
    const narrowed = key([h.teams.eng])();
    await hidden('unclaimedAttachment', narrowed);
    await hidden('unclaimedInline', narrowed);
    expect(await resolve('avatar', narrowed)).toBe(ids['avatar']);
    expect(await resolve('unusedAvatar', narrowed)).toBe(ids['unusedAvatar']);
    expect(await resolve('engAttachment', narrowed)).toBe(ids['engAttachment']);
    // A key for every team reads like its owner's session.
    expect(await resolve('unclaimedAttachment', key([])())).toBe(ids['unclaimedAttachment']);
  });

  it('a key limited to other teams reads none of an issue’s files, public team included', async () => {
    const elsewhere = key([h.teams.sec])();
    for (const label of ['engAttachment', 'engInline', 'previewOfEng', 'deletedAttachment']) {
      await hidden(label, elsewhere);
    }
  });

  it('answers a hidden file exactly like an unknown id', async () => {
    expect(await resolve('missing', ben())).toEqual({
      code: 'NOT_FOUND',
      message:
        'File "<id>" not found. That upload has expired or isn\'t yours. Upload the file again.',
    });
  });

  it('lets nobody set another user’s avatar or logo file, answering like an unknown id', async () => {
    // FileRef resolves Ada's avatar for Ben (it is in use, everyone sees it), but setting it would
    // pin Ada's file with the RESTRICT key: user.updateProfile and workspace.update take only
    // your own upload or the current one (review of PLAN-014 S1, SPEC-003 §4).
    const { executor } = testExecutor(h.pool);
    const failure = async (op: string, field: string, label: string, actor: Actor) => {
      const id = ids[label] ?? MISSING;
      const result = await executor.execute(op, { [field]: id }, actor);
      if (result.ok) return { ok: true };
      const hide = (text: string) => text.replaceAll(id, '<id>');
      return {
        code: result.error.code,
        message: hide(result.error.message),
        issues: (result.error.issues ?? []).map((i) => ({ ...i, message: hide(i.message) })),
      };
    };
    const benAdmin = () =>
      actorFor({
        id: users.ben,
        role: 'admin',
        memberships: [{ teamId: h.teams.eng, private: false }],
      });
    for (const label of ['avatar', 'unusedAvatar']) {
      const borrowed = await failure('user.updateProfile', 'avatar', label, ben());
      expect(borrowed).toEqual(await failure('user.updateProfile', 'avatar', 'missing', ben()));
      expect(borrowed).toMatchObject({ code: 'NOT_FOUND' });
    }
    // Ada's unused logo upload: Ben, an Admin, can't set it either.
    expect(await failure('workspace.update', 'logo', 'unusedLogo', benAdmin())).toEqual(
      await failure('workspace.update', 'logo', 'missing', benAdmin()),
    );
    const { rows } = await h.pool.query<{ avatarFileId: string | null }>(
      'SELECT avatar_file_id AS "avatarFileId" FROM users WHERE id = $1',
      [users.ben],
    );
    expect(rows).toEqual([{ avatarFileId: null }]);
  });
});
