// PLAN-011 S5a, SPEC-011 §5.2, AC-9 (unit part; the Postgres endpoint test is held, plans README
// §6): `GET /sync/content`. The pool is a fake that keeps rows per table and answers the
// statements the endpoint sends, applying their group and parent filters, so the error statuses,
// the one snapshot, the left-out parents and the counts are checked without a database. The
// private-team leak against Postgres is `content-leak.int.test.ts`.
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { teamGroup } from '@surface/domain';
import {
  ContentStreamReader,
  encodeContentQuery,
  issueParent,
  NdjsonDecoder,
  type ContentFrame,
  type ContentParent,
} from '@surface/sync-protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { Lifecycle } from '../src/lifecycle.js';
import { createLogger } from '../src/logger.js';
import type { BootstrapClient, BootstrapPool } from '../src/sync/bootstrap.js';
import { syncRegistry } from '../src/sync/registry.js';
import { actorFor, captureLogs, headerActor, testConfig } from './helpers.js';

const registry = syncRegistry({ includeFixtures: false });
const ENG = randomUUID(); // public
const SEC = randomUUID(); // private
const AT = '2026-11-13T10:00:00.000Z';

/**
 * Ana: a member of public ENG only. Sam: a member of private SEC. Every user sees public ENG
 * (`publicTeams`, read with the session; SPEC-011 §5.6).
 */
const ana = actorFor({
  id: randomUUID(),
  memberships: [{ teamId: ENG, private: false }],
  publicTeams: [ENG],
});
const sam = actorFor({
  id: randomUUID(),
  memberships: [{ teamId: SEC, private: true }],
  publicTeams: [ENG],
});
const apiKey = actorFor(
  { id: randomUUID(), publicTeams: [ENG] },
  {
    kind: 'api',
    apiKey: { id: randomUUID(), scope: 'read', teamIds: [ENG], allowDestructive: false },
  },
);

const engIssue = randomUUID();
const secIssue = randomUUID();
const engHistory = [randomUUID(), randomUUID()];
const secHistory = randomUUID();
/** A visible issue without content rows (an issue from before S6 has none). */
const bareIssue = randomUUID();
/** Visible issues in the archive and in the trash: content is still served for them. */
const archivedIssue = randomUUID();
const trashedIssue = randomUUID();

type Row = Record<string, unknown>;

/** Created by someone else: Ana sees these issues through public ENG alone. */
const engIssueGroups = [teamGroup(ENG), `user:${randomUUID()}`];

/** Rows per table as `selectRows` aliases them (client field names), with their groups. */
function tables(): Record<string, Row[]> {
  const content = (issueId: string, teamId: string): Row => ({
    id: issueId,
    issueId,
    teamId,
    description: { type: 'doc', content: [] },
    version: 1,
    createdAt: new Date(AT),
    updatedAt: new Date(AT),
    __groups: [teamGroup(teamId)],
    __archived: false,
  });
  const history = (id: string, issueId: string, teamId: string): Row => ({
    id,
    issueId,
    teamId,
    actorKind: 'system',
    actorId: null,
    apiKeyId: null,
    kind: 'created',
    changes: {},
    createdAt: new Date(AT),
    updatedAt: new Date(AT),
    __groups: [teamGroup(teamId)],
    __archived: false,
  });
  return {
    // A public team's issue is in its team's group and its creator's (PLAN-011 S4b).
    issues: [
      { id: engIssue, __groups: engIssueGroups },
      { id: secIssue, __groups: [teamGroup(SEC)] },
      { id: bareIssue, __groups: engIssueGroups },
      { id: archivedIssue, __groups: engIssueGroups, __archived: true },
      { id: trashedIssue, __groups: engIssueGroups, __deleted: true },
    ],
    issue_content: [
      content(engIssue, ENG),
      content(secIssue, SEC),
      content(archivedIssue, ENG),
      content(trashedIssue, ENG),
    ],
    issue_history: [
      history(engHistory[0] ?? '', engIssue, ENG),
      history(engHistory[1] ?? '', engIssue, ENG),
      history(secHistory, secIssue, SEC),
    ],
  };
}

interface Statement {
  readonly text: string;
  readonly values: readonly unknown[];
}

/**
 * A pool over `tables()`. It answers the snapshot, the head, the parent query
 * (`id = ANY($1)`, `sync_groups && $2`, and an `archived_at`/`deleted_at` filter if one is sent)
 * and each content model's query (`sync_groups && $1`, parent `= ANY($2)`), as Postgres would. `failOn` makes a statement starting with it throw.
 */
function fakePool({ failOn }: { failOn?: string } = {}) {
  const data = tables();
  const statements: Statement[] = [];
  const releases: boolean[] = [];
  let connects = 0;
  const overlaps = (row: Row, groups: unknown) =>
    Array.isArray(row['__groups']) &&
    Array.isArray(groups) &&
    row['__groups'].some((g) => groups.includes(g));
  const client: BootstrapClient = {
    query: <R extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) => {
      statements.push({ text, values });
      if (failOn !== undefined && text.startsWith(failOn)) {
        return Promise.reject(new Error('connection lost'));
      }
      const answer = (rows: Row[]) =>
        Promise.resolve({ rows: rows.filter((r): r is R => typeof r === 'object') });
      if (text.startsWith('SELECT last_sync_id')) return answer([{ last: '42' }]);
      const table = /FROM "?(\w+)"?/.exec(text)?.[1];
      if (table === 'issues') {
        const [ids, groups] = values;
        return answer(
          (data['issues'] ?? [])
            .filter((r) => Array.isArray(ids) && ids.includes(r['id']) && overlaps(r, groups))
            .filter((r) => !(r['__archived'] === true && /archived_at IS NULL/i.test(text)))
            .filter((r) => !(r['__deleted'] === true && /deleted_at IS NULL/i.test(text)))
            .map((r) => ({ id: r['id'] })),
        );
      }
      if (table !== undefined && table in data) {
        const [groups, parents] = values;
        return answer(
          (data[table] ?? []).filter(
            (r) => overlaps(r, groups) && Array.isArray(parents) && parents.includes(r['issueId']),
          ),
        );
      }
      return answer([]);
    },
    release: (destroy) => {
      releases.push(destroy === true);
    },
  };
  const pool: BootstrapPool = {
    connect: () => {
      connects += 1;
      return Promise.resolve(client);
    },
  };
  return { pool, statements, releases, connects: () => connects };
}

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function app({ ready = true, pool = fakePool().pool } = {}) {
  const config = testConfig();
  const lifecycle = new Lifecycle();
  const built = await buildApp({
    config,
    lifecycle,
    logger: createLogger(config, captureLogs().stream),
    sync: { pool, registry, resolveActor: headerActor({ ana, sam, apiKey }) },
  });
  if (ready) lifecycle.markReady();
  close = () => built.close();
  return built;
}

const userOf = (who: 'ana' | 'sam') => (who === 'ana' ? ana : sam).userId ?? '';

/** The request path; `extra` replaces a parameter, or removes it when `undefined`. */
function url(
  parents: readonly ContentParent[],
  who: 'ana' | 'sam',
  extra: Readonly<Record<string, string | undefined>> = {},
): string {
  const query = new URLSearchParams(
    encodeContentQuery({ parents, userId: userOf(who), schemaHash: registry.schemaHash }),
  );
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) query.delete(key);
    else query.set(key, value);
  }
  return `/sync/content?${query.toString()}`;
}

/** The frames of a 200 answer, checked by the protocol's stream reader. */
function framesOf(body: Buffer, requested: readonly ContentParent[]): ContentFrame[] {
  const decoder = new NdjsonDecoder();
  const reader = new ContentStreamReader(requested);
  const frames = [...decoder.push(new Uint8Array(body)), ...decoder.end()].map((v) =>
    reader.read(v),
  );
  reader.finish();
  return frames;
}

const rowsOf = (frames: readonly ContentFrame[]) =>
  frames.flatMap((f) => (f.t === 'row' ? [[f.m, f.d.id]] : []));

describe('GET /sync/content refuses, before any database work', () => {
  const parents = [issueParent(engIssue)];

  it.each([
    ['nobody signed in', {}, () => url(parents, 'ana'), 401, 'UNAUTHENTICATED'],
    ['an API key', { 'x-test-actor': 'apiKey' }, () => url(parents, 'ana'), 403, 'FORBIDDEN'],
    [
      'another user’s replica (SPEC-002 E14)',
      { 'x-test-actor': 'ana' },
      () => url(parents, 'sam'),
      401,
      'UNAUTHENTICATED',
    ],
    [
      'a client without userId',
      { 'x-test-actor': 'ana' },
      () => url(parents, 'ana', { userId: undefined }),
      426,
      'CLIENT_OUTDATED',
    ],
    [
      'a client of another schema',
      { 'x-test-actor': 'ana' },
      () => url(parents, 'ana', { schemaHash: 'b'.repeat(64) }),
      426,
      'CLIENT_OUTDATED',
    ],
    [
      'no schemaHash',
      { 'x-test-actor': 'ana' },
      () => url(parents, 'ana', { schemaHash: undefined }),
      400,
      'INVALID_INPUT',
    ],
    [
      'no parents',
      { 'x-test-actor': 'ana' },
      () => url(parents, 'ana', { parents: '' }),
      400,
      'INVALID_INPUT',
    ],
    [
      'more than 50 parents',
      { 'x-test-actor': 'ana' },
      () =>
        url(
          Array.from({ length: 51 }, () => issueParent(randomUUID())),
          'ana',
        ),
      400,
      'INVALID_INPUT',
    ],
    [
      'a malformed parent',
      { 'x-test-actor': 'ana' },
      () => url(parents, 'ana', { parents: 'issue:ENG-1' }),
      400,
      'INVALID_INPUT',
    ],
    [
      'a duplicate parent',
      { 'x-test-actor': 'ana' },
      () => url([issueParent(engIssue), issueParent(engIssue)], 'ana'),
      400,
      'INVALID_INPUT',
    ],
    [
      'a userId that is not a uuid',
      { 'x-test-actor': 'ana' },
      () => url(parents, 'ana', { userId: 'ana' }),
      400,
      'INVALID_INPUT',
    ],
  ])('%s, with %i', async (_case, headers, path, status, code) => {
    const fake = fakePool();
    const res = await (await app({ pool: fake.pool })).inject({ url: path(), headers });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ ok: false, error: { code } });
    expect(fake.connects()).toBe(0);
  });

  it('while the server is starting, with 503 and Retry-After', async () => {
    const fake = fakePool();
    const res = await (
      await app({ ready: false, pool: fake.pool })
    ).inject({
      url: url(parents, 'ana'),
      headers: { 'x-test-actor': 'ana' },
    });
    expect([res.statusCode, res.headers['retry-after']]).toEqual([503, '5']);
    expect(fake.connects()).toBe(0);
  });
});

describe('GET /sync/content answers', () => {
  async function get(parents: readonly ContentParent[], who: 'ana' | 'sam', pool = fakePool()) {
    const res = await (
      await app({ pool: pool.pool })
    ).inject({
      url: url(parents, who),
      headers: { 'x-test-actor': who },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/x-ndjson');
    expect(res.headers['cache-control']).toBe('no-store');
    return { body: res.rawPayload, frames: framesOf(res.rawPayload, parents) };
  }

  it('from one REPEATABLE READ snapshot, committed and released before the body', async () => {
    const pool = fakePool();
    await get([issueParent(engIssue)], 'ana', pool);
    const texts = pool.statements.map((s) => s.text);
    expect(texts[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(texts[1]).toMatch(/^SELECT last_sync_id/);
    expect(texts.at(-1)).toBe('COMMIT');
    expect(texts.filter((t) => t.startsWith('BEGIN'))).toHaveLength(1);
    expect([pool.connects(), pool.releases]).toEqual([1, [false]]);
  });

  it('with lastSyncId, the visible parents, and each content row of them, counted', async () => {
    const { frames } = await get([issueParent(engIssue)], 'ana');
    expect(frames[0]).toEqual({
      t: 'meta',
      lastSyncId: 42,
      parents: [issueParent(engIssue)],
      rows: 3,
    });
    expect(rowsOf(frames)).toEqual([
      ['IssueContent', engIssue],
      ...engHistory.map((id) => ['IssueHistory', id]),
    ]);
    expect(frames.at(-1)).toEqual({ t: 'end', rows: 3 });
  });

  it('rows hold exactly the model’s declared fields, instants as ISO strings, no sync groups', async () => {
    const { frames } = await get([issueParent(engIssue)], 'ana');
    const content = frames.find((f) => f.t === 'row' && f.m === 'IssueContent');
    expect(content).toEqual({
      t: 'row',
      m: 'IssueContent',
      d: {
        id: engIssue,
        issueId: engIssue,
        teamId: ENG,
        description: { type: 'doc', content: [] },
        version: 1,
        createdAt: AT,
        updatedAt: AT,
      },
    });
  });

  it('filters parents and rows with every group the actor may see, public teams included', async () => {
    // `visibleGroups(actor)`: the home groups plus every public team's.
    const pool = fakePool();
    await get([issueParent(engIssue)], 'ana', pool);
    const parentQuery = pool.statements.find((s) => /FROM "issues"/.test(s.text));
    expect(parentQuery?.text).toMatch(/sync_groups && \$2::text\[\]/);
    expect(parentQuery?.values[1]).toEqual(
      expect.arrayContaining(['workspace', `user:${ana.userId ?? ''}`, teamGroup(ENG)]),
    );
    expect(parentQuery?.values[1]).not.toContain(teamGroup(SEC));
    // From the actor alone: no teams read in the snapshot.
    expect(pool.statements.some((st) => /FROM "?teams"?/.test(st.text))).toBe(false);
    for (const s of pool.statements.filter((st) =>
      /FROM "issue_(content|history)"/.test(st.text),
    )) {
      expect(s.text).toMatch(/sync_groups && \$1::text\[\]/);
      expect(s.values[0]).toEqual(parentQuery?.values[1]);
    }
  });

  it('leaves out an invisible parent exactly like an unknown one, never an error', async () => {
    const hidden = await get([issueParent(secIssue)], 'ana');
    const unknown = await get([issueParent(randomUUID())], 'ana');
    expect(hidden.frames).toEqual([
      { t: 'meta', lastSyncId: 42, parents: [], rows: 0 },
      { t: 'end', rows: 0 },
    ]);
    expect(hidden.body.equals(unknown.body)).toBe(true);
    expect(hidden.body.toString()).not.toContain(secIssue);
    expect(hidden.body.toString()).not.toContain(SEC);
  });

  it('a mix keeps the visible parents only; a member sees the private one', async () => {
    const parents = [issueParent(secIssue), issueParent(engIssue)];
    const outsider = await get(parents, 'ana');
    expect(outsider.frames[0]).toMatchObject({ parents: [issueParent(engIssue)], rows: 3 });
    expect(outsider.body.toString()).not.toContain(secIssue);
    const member = await get([issueParent(secIssue)], 'sam');
    expect(member.frames[0]).toMatchObject({ parents: [issueParent(secIssue)], rows: 2 });
    expect(rowsOf(member.frames)).toEqual([
      ['IssueContent', secIssue],
      ['IssueHistory', secHistory],
    ]);
  });

  it('a visible parent with no content rows is still listed, so it is hydrated', async () => {
    const { frames } = await get([issueParent(bareIssue)], 'ana');
    expect(frames).toEqual([
      { t: 'meta', lastSyncId: 42, parents: [issueParent(bareIssue)], rows: 0 },
      { t: 'end', rows: 0 },
    ]);
    // Without visible parents no content query runs at all.
    const none = fakePool();
    await get([issueParent(secIssue)], 'ana', none);
    expect(none.statements.some((s) => /FROM "issue_(content|history)"/.test(s.text))).toBe(false);
  });

  it('for archived and trashed parents too, unlike bootstrap (SPEC-011 §5.7)', async () => {
    const pool = fakePool();
    const parents = [issueParent(archivedIssue), issueParent(trashedIssue)];
    const { frames } = await get(parents, 'ana', pool);
    const meta = frames[0];
    expect(meta?.t === 'meta' ? new Set(meta.parents) : undefined).toEqual(new Set(parents));
    expect(meta).toMatchObject({ rows: 2 });
    expect(rowsOf(frames)).toEqual(
      expect.arrayContaining([
        ['IssueContent', archivedIssue],
        ['IssueContent', trashedIssue],
      ]),
    );
    const parentQuery = pool.statements.find((s) => /FROM "issues"/.test(s.text));
    expect(parentQuery?.text).not.toMatch(/archived_at|deleted_at/);
  });

  it('gzip-encoded when accepted, with the same frames', async () => {
    const res = await (
      await app()
    ).inject({
      url: url([issueParent(engIssue)], 'ana'),
      headers: { 'x-test-actor': 'ana', 'accept-encoding': 'gzip' },
    });
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.headers['vary']).toBe('accept-encoding');
    const frames = framesOf(gunzipSync(res.rawPayload), [issueParent(engIssue)]);
    expect(frames.at(-1)).toEqual({ t: 'end', rows: 3 });
  });

  it('a database error is a 500 before any frame, rolled back and released', async () => {
    const pool = fakePool({ failOn: 'SELECT "id"' });
    const res = await (
      await app({ pool: pool.pool })
    ).inject({
      url: url([issueParent(engIssue)], 'ana'),
      headers: { 'x-test-actor': 'ana' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ ok: false, error: { code: 'INTERNAL' } });
    expect(res.body).not.toContain('connection lost');
    expect(pool.statements.at(-1)?.text).toBe('ROLLBACK');
    expect(pool.releases).toEqual([false]);
  });
});
