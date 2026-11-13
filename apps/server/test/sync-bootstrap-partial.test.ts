// PLAN-011 S4b, SPEC-011 §5.7, AC-26 and AC-28 (unit parts), AC-29 (server part), E32: the partial
// bootstrap `GET /sync/bootstrap?groups=team:<id>` and what any bootstrap leaves out, against a
// pool that records every statement and answers from a few fixed teams. What Postgres streams for
// these statements is the held `sync-bootstrap-partial.int.test.ts`; `subscribe-leak.int.test.ts`
// checks the leak half against Postgres.
import { randomUUID } from 'node:crypto';
import { teamGroup, userGroup } from '@surface/domain';
import { Issue } from '@surface/domain/model';
import { decodeBootstrapFrame, NdjsonDecoder, type BootstrapFrame } from '@surface/sync-protocol';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { Lifecycle } from '../src/lifecycle.js';
import { createLogger } from '../src/logger.js';
import { rowsWhere, selectRows, type BootstrapPool } from '../src/sync/bootstrap.js';
import { syncModel, syncRegistry, type SyncModel } from '../src/sync/registry.js';
import { issues } from '../src/db/schema/index.js';
import { actorFor, captureLogs, headerActor, testConfig } from './helpers.js';

const registry = syncRegistry({ includeFixtures: true });
const ENG = randomUUID(); // public, the member's team
const DES = randomUUID(); // public, not the member's
const SEC = randomUUID(); // private, the member is in it
const OPS = randomUUID(); // private, the member is not in it
const UNKNOWN = randomUUID();

const member = actorFor({
  id: randomUUID(),
  memberships: [
    { teamId: ENG, private: false },
    { teamId: SEC, private: true },
  ],
  publicTeams: [ENG, DES],
});
const userId = member.userId ?? '';

interface Recorded {
  readonly text: string;
  readonly values: readonly unknown[];
}

/** A pool whose one connection records statements, and answers the team check from `TEAMS`. */
function recordingPool() {
  const statements: Recorded[] = [];
  let lastSyncId = 40;
  const teams = new Map<string, { private: boolean; members: string[] }>([
    [ENG, { private: false, members: [userId] }],
    [DES, { private: false, members: [] }],
    [SEC, { private: true, members: [userId] }],
    [OPS, { private: true, members: [] }],
  ]);
  const pool: BootstrapPool = {
    connect: () =>
      Promise.resolve({
        query<R extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
          statements.push({ text, values });
          const rows = (list: unknown[]) => Promise.resolve({ rows: list as R[] });
          if (text.includes('FROM teams t')) {
            const [asked, user] = values as [string[], string];
            return rows(
              asked
                .filter((id) => {
                  const team = teams.get(id);
                  return team !== undefined && (!team.private || team.members.includes(user));
                })
                .map((id) => ({ id })),
            );
          }
          if (text.includes('FROM sync_state')) return rows([{ last: String((lastSyncId += 1)) }]);
          if (text.startsWith('SELECT count(*)')) return rows([{ n: '0' }]);
          return rows([]);
        },
        release() {},
      }),
  };
  return { pool, statements };
}

async function bootstrap(query: string) {
  const { pool, statements } = recordingPool();
  const config = testConfig();
  const lifecycle = new Lifecycle();
  const app = await buildApp({
    config,
    lifecycle,
    logger: createLogger(config, captureLogs().stream),
    sync: { pool, registry, resolveActor: headerActor({ member }) },
  });
  lifecycle.markReady();
  const res = await app.inject({
    url: `/sync/bootstrap?userId=${userId}${query}`,
    headers: { 'x-test-actor': 'member' },
  });
  await app.close();
  const decoder = new NdjsonDecoder();
  const frames =
    res.statusCode === 200
      ? [...decoder.push(new Uint8Array(res.rawPayload)), ...decoder.end()].map(
          decodeBootstrapFrame,
        )
      : [];
  return { res, frames, statements };
}

const partial = (...teams: string[]) =>
  `&schemaHash=${registry.schemaHash}&groups=${teams.map((t) => teamGroup(t)).join(',')}`;
const metaOf = (frames: readonly BootstrapFrame[]) =>
  frames.find((f): f is Extract<BootstrapFrame, { t: 'meta' }> => f.t === 'meta');
/** The tables the bootstrap counted rows of, with the groups it filtered on. */
const counted = (statements: readonly Recorded[]) =>
  statements
    .filter(({ text }) => text.startsWith('SELECT count(*)'))
    .map(({ text, values }) => [/FROM "(\w+)"/.exec(text)?.[1], values[0]]);

describe('the partial bootstrap (SPEC-011 §5.7)', () => {
  it('streams only the Issue rows of a team the user may follow, from one snapshot', async () => {
    const { res, frames, statements } = await bootstrap(partial(DES));
    expect(res.statusCode).toBe(200);
    expect(metaOf(frames)).toMatchObject({ groups: [teamGroup(DES)], rows: 0 });
    expect(frames.at(-1)).toEqual({ t: 'end', rows: 0 });
    // Issue alone (it has no eager child yet: Attachment comes with PLAN-014), live ones only.
    expect(counted(statements)).toEqual([['issues', [teamGroup(DES)]]]);
    expect(statements.find(({ text }) => text.startsWith('DECLARE'))?.text).toContain(
      'archived_at IS NULL AND deleted_at IS NULL',
    );
    expect(statements[0]?.text).toContain('FROM teams t');
    expect(statements.map(({ text }) => text.split(' ')[0])).toContain('BEGIN');
  });

  it('follows several teams at once, keeping the ones the user may follow', async () => {
    const { frames, statements } = await bootstrap(partial(ENG, OPS, SEC));
    expect(metaOf(frames)?.groups).toEqual([teamGroup(ENG), teamGroup(SEC)]);
    expect(counted(statements)).toEqual([['issues', [teamGroup(ENG), teamGroup(SEC)]]]);
  });

  it('answers a private team the user isn’t in exactly as an unknown team (AC-28, E32)', async () => {
    const hidden = await bootstrap(partial(OPS));
    const unknown = await bootstrap(partial(UNKNOWN));
    for (const { res } of [hidden, unknown]) {
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/x-ndjson');
    }
    // Byte-identical apart from `lastSyncId` and `serverTime`.
    const blank = (body: string) =>
      body
        .replace(/"lastSyncId":\d+/, '"lastSyncId":0')
        .replace(/"serverTime":"[^"]+"/, '"serverTime":""');
    expect(blank(hidden.res.body)).toBe(blank(unknown.res.body));
    expect(metaOf(hidden.frames)).toMatchObject({ groups: [], rows: 0 });
    expect(hidden.frames.map((f) => f.t)).toEqual(['meta', 'end']);
    // Neither reads a row of any group: the hidden team's never reaches a query but the check.
    for (const { statements } of [hidden, unknown]) {
      expect(counted(statements)).toEqual([['issues', []]]);
    }
    expect(JSON.stringify(hidden.statements.slice(1))).not.toContain(OPS);
  });

  it.each([
    ['no schema hash', `&groups=${teamGroup(ENG)}`],
    ['another schema hash', `&schemaHash=${'0'.repeat(64)}&groups=${teamGroup(ENG)}`],
  ])('is 426 CLIENT_OUTDATED with %s, before the first frame', async (_case, query) => {
    const { res, statements } = await bootstrap(query);
    expect(res.statusCode).toBe(426);
    expect(res.json()).toMatchObject({ ok: false, error: { code: 'CLIENT_OUTDATED' } });
    expect(statements).toEqual([]);
  });

  it.each([
    ['the workspace group', 'workspace'],
    ['a user group', userGroup(userId)],
    ['a team that is not a uuid', 'team:ENG'],
    ['a repeated team', `${teamGroup(ENG)},${teamGroup(ENG)}`],
  ])('is 400 for %s, before any read', async (_case, groups) => {
    const { res, statements } = await bootstrap(
      `&schemaHash=${registry.schemaHash}&groups=${groups}`,
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(statements).toEqual([]);
  });
});

describe('the full bootstrap (SPEC-011 §5.7)', () => {
  it('covers the home groups and every member team, public ones included', async () => {
    const { frames, statements } = await bootstrap('');
    const groups = ['workspace', userGroup(userId), teamGroup(SEC), teamGroup(ENG)];
    expect(metaOf(frames)?.groups).toEqual(groups);
    // DES is visible (`visibleGroups`) but no member team: its issues load on demand.
    for (const [, values] of counted(statements)) expect(values).toEqual(groups);
    expect(statements.some(({ text }) => text.includes('FROM teams t'))).toBe(false);
  });

  it('checks a schema hash when the client sends one', async () => {
    expect((await bootstrap(`&schemaHash=${'0'.repeat(64)}`)).res.statusCode).toBe(426);
    expect((await bootstrap(`&schemaHash=${registry.schemaHash}`)).res.statusCode).toBe(200);
  });
});

describe('archived and deleted issues (AC-26, AC-29 server part)', () => {
  const issueModel = syncModel('Issue', Issue, issues);

  it('are left out of every bootstrap, counted and streamed alike', () => {
    expect(rowsWhere(issueModel)).toBe(
      'sync_groups && $1::text[] AND archived_at IS NULL AND deleted_at IS NULL',
    );
    expect(selectRows(issueModel)).toMatch(
      / FROM "issues" WHERE sync_groups && \$1::text\[\] AND archived_at IS NULL AND deleted_at IS NULL$/,
    );
  });

  it('take their eager children with them', () => {
    // An eager issue child (SPEC-014's Attachment) by its `issueId`.
    const child: SyncModel = {
      name: 'Issue',
      def: Issue,
      table: 'attachments',
      columns: new Map([['issueId', 'issue_id']]),
      archivable: false,
      issueRows: 'child',
    };
    expect(rowsWhere(child)).toBe(
      'sync_groups && $1::text[] AND EXISTS (SELECT 1 FROM issues i WHERE i.id = "attachments"."issue_id" AND i.archived_at IS NULL AND i.deleted_at IS NULL)',
    );
  });

  it('leave every other model as it was: archived labels still go out', () => {
    const label = registry.models.find((m) => m.name === 'Label');
    expect(label && rowsWhere(label)).toBe('sync_groups && $1::text[]');
    expect(registry.models.filter((m) => m.issueRows !== undefined).map((m) => m.name)).toEqual([
      'Issue',
    ]);
  });
});
