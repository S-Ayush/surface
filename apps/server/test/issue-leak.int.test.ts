// PLAN-011 S4 leak test (SPEC-011 AC-10, E13; permissions.md §5; CLAUDE.md rule 4; not held,
// plans README §6). For private team SEC and a user outside it (a Member and an Admin):
// - bootstrap, catch-up and live deltas carry no SEC issue, and not SEC's id;
// - `issue.get` and `issue.update`, and every `IssueRef`, answer for a SEC issue exactly like for
//   an issue that doesn't exist, by identifier and by id, and write nothing;
// - a SEC status or label named by id in an ENG issue's edit is as unknown as one that never
//   existed;
// - `issue.list`, `issue.count` and `issue.groupBy` never count SEC's issues or name its labels,
//   even when a filter asks for them, and naming SEC as `team` is an unknown team;
// - an API key limited to ENG gets the same for public team OPS (E13).
// A SEC member gets everything, so the answers come from visibility, not from broken operations.
import { randomUUID } from 'node:crypto';
import type { Actor } from '@surface/domain';
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
let secGroup: string;
const registry = syncRegistry({ includeFixtures: true });

const ana = randomUUID(); // a Member of ENG only
const zoe = randomUUID(); // an Admin, member of ENG only
const sam = randomUUID(); // the only member of private SEC
const ops = randomUUID(); // a second public team, OPS
let anaActor: Actor;
let zoeActor: Actor;
let samActor: Actor;
/** Zoe through an API key limited to ENG. */
let engKeyActor: Actor;

const secIssue = uuidv7();
const engIssue = uuidv7();
const opsIssue = uuidv7();
const secLabel = uuidv7();
const opsLabel = uuidv7();
let secStatusId = '';

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

async function ok(operation: string, input: object, actor: Actor): Promise<unknown> {
  const result = await executor.execute(operation, input, actor);
  if (!result.ok) throw new Error(`${operation}: ${result.error.message}`);
  return result.result;
}

beforeAll(async () => {
  h = await executorHarness();
  secGroup = `team:${h.teams.sec}`;
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
  anaActor = actorFor({ id: ana, memberships: [{ teamId: h.teams.eng, private: false }] });
  zoeActor = actorFor({
    id: zoe,
    role: 'admin',
    memberships: [{ teamId: h.teams.eng, private: false }],
  });
  samActor = actorFor({ id: sam, memberships: [{ teamId: h.teams.sec, private: true }] });
  engKeyActor = actorFor(
    { id: zoe, role: 'admin', memberships: [{ teamId: h.teams.eng, private: false }] },
    {
      kind: 'api',
      apiKey: { id: 'key-1', scope: 'read_write', teamIds: [h.teams.eng], allowDestructive: false },
    },
  );
  const { rows } = await h.pool.query<{ id: string }>(
    `SELECT id FROM workflow_statuses WHERE team_id = $1 AND name = 'Todo'`,
    [h.teams.sec],
  );
  secStatusId = rows[0]?.id ?? '';

  executor = testExecutor(h.pool).executor;
  await ok('label.create', { id: secLabel, team: 'SEC', name: 'Secret sauce' }, samActor);
  await ok(
    'issue.create',
    {
      id: secIssue,
      team: 'SEC',
      title: 'Rotate the leaked token',
      status: 'Todo',
      assignee: 'me',
      labels: ['Secret sauce'],
    },
    samActor,
  );
  await ok('issue.create', { id: engIssue, team: 'ENG', title: 'Fix login' }, anaActor);
  await ok('issue.create', { id: opsIssue, team: 'OPS', title: 'Renew the cert' }, anaActor);
  await ok('label.create', { id: opsLabel, team: 'OPS', name: 'On call' }, zoeActor);

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
      resolveActor: headerActor({ outsider: anaActor, member: samActor }),
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

// ---------------------------------------------------------------------------------------------
// Sync: bootstrap, catch-up, live

type Who = 'outsider' | 'member';
const userOf = (who: Who) => (who === 'outsider' ? ana : sam);

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

const issueIdsIn = (packets: readonly DeltaPacket[]) =>
  packets.flatMap((p) => (p.a !== 'D' && p.a !== 'G' && p.m === 'Issue' ? [p.d.id] : []));

describe('SEC issues in sync', () => {
  async function bootstrap(who: Who) {
    const res = await app.inject({
      url: `/sync/bootstrap?userId=${userOf(who)}`,
      headers: { 'x-test-actor': who },
    });
    expect(res.statusCode).toBe(200);
    const decoder = new NdjsonDecoder();
    return [...decoder.push(new Uint8Array(res.rawPayload)), ...decoder.end()]
      .map(decodeBootstrapFrame)
      .filter((f): f is Extract<BootstrapFrame, { t: 'row' }> => f.t === 'row');
  }

  it('are not in an outsider’s bootstrap, and are in the member’s with the private group only', async () => {
    const outsider = await bootstrap('outsider');
    const issues = outsider.filter((r) => r.m === 'Issue').map((r) => r.d.id);
    expect(issues).toEqual(expect.arrayContaining([engIssue, opsIssue]));
    expect(issues).not.toContain(secIssue);
    expect(JSON.stringify(outsider)).not.toContain(h.teams.sec);
    expect(JSON.stringify(outsider)).not.toContain('Rotate the leaked token');
    const member = await bootstrap('member');
    const row = member.find((r) => r.m === 'Issue' && r.d.id === secIssue);
    expect(row).toMatchObject({ d: { groups: [secGroup], title: 'Rotate the leaked token' } });
  });

  it('are not in an outsider’s catch-up; the member gets them once in SEC', async () => {
    // From the start for the outsider. The member joined SEC after 0, so from 0 they are told
    // to bootstrap again (`resync: groups`); they catch up from their membership instead.
    const joined = await h.pool.query<{ id: string }>(
      `SELECT max(sync_id) AS id FROM sync_log WHERE model = 'TeamMembership'`,
    );
    const outsider = connect('outsider');
    const member = connect('member', Number(joined.rows[0]?.id));
    try {
      const last = await head();
      await eventually(
        () =>
          outsider.packets().some((p) => p.id >= last) &&
          member.packets().some((p) => p.id >= last),
      );
      expect(issueIdsIn(outsider.packets())).toEqual(expect.arrayContaining([engIssue, opsIssue]));
      expect(issueIdsIn(outsider.packets())).not.toContain(secIssue);
      expect(outsider.text()).not.toContain(secIssue);
      expect(outsider.text()).not.toContain(h.teams.sec);
      expect(issueIdsIn(member.packets())).toContain(secIssue);
    } finally {
      outsider.close();
      member.close();
    }
  });

  it('created and edited live never reach an outsider', async () => {
    const at = await head();
    const outsider = connect('outsider', at);
    const member = connect('member', at);
    try {
      const live = uuidv7();
      await ok('issue.create', { id: live, team: 'SEC', title: 'Live secret' }, samActor);
      await ok('issue.update', { issue: live, status: 'Done', priority: 1 }, samActor);
      await ok('issue.update', { issue: secIssue, removeLabels: ['Secret sauce'] }, samActor);
      // Written last: once it arrives, anything earlier would have arrived too.
      const marker = uuidv7();
      await ok('issue.create', { id: marker, team: 'ENG', title: 'Marker' }, anaActor);
      await eventually(() => outsider.text().includes(marker) && member.text().includes(marker));
      expect(outsider.text()).not.toContain(live);
      expect(outsider.text()).not.toContain(secIssue);
      expect(outsider.text()).not.toContain(h.teams.sec);
      expect(outsider.text()).not.toContain('Live secret');
      expect(issueIdsIn(member.packets())).toEqual(expect.arrayContaining([live, secIssue]));
      // Put the label back for the operation tests below.
      await ok('issue.update', { issue: secIssue, addLabels: ['Secret sauce'] }, samActor);
    } finally {
      outsider.close();
      member.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Operations

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

const SEC_REFS = (): [string, string][] => [
  ['SEC-1', 'SEC-99'],
  ['sec-1', 'ZZZ-1'],
  [secIssue, uuidv7()],
];

for (const [who, actor] of [
  ['a Member', () => anaActor],
  ['an Admin', () => zoeActor],
] as const) {
  describe(`${who} outside private team SEC`, () => {
    it('gets NOT_FOUND for a SEC issue from get and update, like an issue that doesn’t exist', async () => {
      const before = await logLength();
      for (const [secRef, unknown] of SEC_REFS()) {
        for (const [operation, input] of [
          ['issue.get', (issue: string) => ({ issue })],
          ['issue.update', (issue: string) => ({ issue, title: 'Leaked' })],
          ['issue.update', (issue: string) => ({ issue, status: 'Done', addLabels: ['Bug'] })],
        ] as const) {
          const real = await failure(operation, input(secRef), actor(), [secRef]);
          const none = await failure(operation, input(unknown), actor(), [unknown]);
          expect(real, `${operation} ${secRef}`).toMatchObject({ code: 'NOT_FOUND' });
          expect(real).toEqual(none);
        }
      }
      expect(await logLength()).toBe(before);
    });

    it('gets the same answer for a SEC status or label id in an ENG issue’s edit as for an unknown one', async () => {
      const before = await logLength();
      for (const [field, secId] of [
        ['status', secStatusId],
        ['addLabels', secLabel],
        ['removeLabels', secLabel],
      ] as const) {
        const input = (id: string) => ({
          issue: engIssue,
          [field]: field === 'status' ? id : [id],
        });
        const unknown = uuidv7();
        const real = await failure('issue.update', input(secId), actor(), [secId]);
        const none = await failure('issue.update', input(unknown), actor(), [unknown]);
        expect(real, field).toMatchObject({ code: 'NOT_FOUND' });
        expect(real).toEqual(none);
      }
      for (const [field, secId] of [
        ['status', secStatusId],
        ['labels', secLabel],
      ] as const) {
        const input = (id: string) => ({
          team: 'ENG',
          title: 'Sneaky',
          [field]: field === 'status' ? id : [id],
        });
        const unknown = uuidv7();
        const real = await failure('issue.create', input(secId), actor(), [secId]);
        const none = await failure('issue.create', input(unknown), actor(), [unknown]);
        expect(real, field).toMatchObject({ code: 'NOT_FOUND' });
        expect(real).toEqual(none);
      }
      expect(await logLength()).toBe(before);
    });

    it('gets NOT_FOUND for SEC as the team of list, count, groupBy and create, like an unknown team', async () => {
      for (const [operation, extra] of [
        ['issue.list', {}],
        ['issue.count', {}],
        ['issue.groupBy', { by: 'status' }],
        ['issue.create', { title: 'Leak' }],
      ] as const) {
        for (const [secRef, unknown] of [
          ['SEC', 'ZZZ'],
          [h.teams.sec, randomUUID()],
        ] as const) {
          const real = await failure(operation, { ...extra, team: secRef }, actor(), [secRef]);
          const none = await failure(operation, { ...extra, team: unknown }, actor(), [unknown]);
          expect(real, `${operation} ${secRef}`).toMatchObject({ code: 'NOT_FOUND' });
          expect(real).toEqual(none);
        }
      }
    });

    it('never lists, counts or groups SEC issues, even when a filter asks for them', async () => {
      const bySec = { field: 'team', op: 'eq', value: h.teams.sec };
      const byLabel = { field: 'labels', op: 'hasAny', value: [secLabel] };
      for (const filter of [undefined, bySec]) {
        const input = filter === undefined ? { limit: 100 } : { filter, limit: 100 };
        const listed = await ok('issue.list', { ...input, includeArchived: true }, actor());
        expect(JSON.stringify(listed)).not.toContain(secIssue);
        expect(JSON.stringify(listed)).not.toContain('Secret sauce');
      }
      expect(await ok('issue.count', { filter: bySec }, actor())).toEqual({ count: 0 });
      // A SEC label id in a filter is unknown, like a label that never existed.
      const unknown = uuidv7();
      const real = await failure('issue.count', { filter: byLabel }, actor(), [secLabel]);
      const none = await failure(
        'issue.count',
        { filter: { ...byLabel, value: [unknown] } },
        actor(),
        [unknown],
      );
      expect(real).toEqual(none);
      const all = (await ok('issue.count', {}, actor())) as { count: number };
      const withSec = (await ok('issue.count', {}, samActor)) as { count: number };
      expect(all.count).toBeGreaterThan(0);
      for (const by of ['status', 'assignee', 'priority', 'label'] as const) {
        const grouped = await ok('issue.groupBy', { by }, actor());
        const text = JSON.stringify(grouped);
        expect(text, by).not.toContain('Secret sauce');
        expect(text, by).not.toContain(secLabel);
        expect(text, by).not.toContain(secStatusId);
        expect(text, by).not.toContain(sam);
        const total = (grouped as { groups: { count: number }[] }).groups.reduce(
          (n, g) => n + (by === 'label' ? 0 : g.count),
          0,
        );
        if (by !== 'label') expect(total, by).toBe(all.count);
      }
      // The control: SEC's member counts the SEC issues the others don't.
      expect(withSec.count).toBeGreaterThan(0);
    });
  });
}

describe('an API key limited to ENG (E13)', () => {
  it('answers for an issue of public team OPS like for one that doesn’t exist', async () => {
    const before = await logLength();
    for (const [opsRef, unknown] of [
      ['OPS-1', 'OPS-99'],
      [opsIssue, uuidv7()],
    ] as const) {
      for (const [operation, input] of [
        ['issue.get', (issue: string) => ({ issue })],
        ['issue.update', (issue: string) => ({ issue, priority: 2 })],
      ] as const) {
        const real = await failure(operation, input(opsRef), engKeyActor, [opsRef]);
        const none = await failure(operation, input(unknown), engKeyActor, [unknown]);
        expect(real, `${operation} ${opsRef}`).toMatchObject({ code: 'NOT_FOUND' });
        expect(real).toEqual(none);
      }
    }
    // A label id resolves only to a label of the key's teams or a workspace label (SPEC-010 §6).
    for (const operation of ['issue.update', 'issue.create'] as const) {
      const input = (label: string) =>
        operation === 'issue.update'
          ? { issue: engIssue, addLabels: [label] }
          : { team: 'ENG', title: 'Tag it', labels: [label] };
      const unknown = uuidv7();
      const real = await failure(operation, input(opsLabel), engKeyActor, [opsLabel]);
      const none = await failure(operation, input(unknown), engKeyActor, [unknown]);
      expect(real, operation).toMatchObject({ code: 'NOT_FOUND' });
      expect(real).toEqual(none);
    }
    const real = await failure('issue.list', { team: 'OPS' }, engKeyActor, ['OPS']);
    const none = await failure('issue.list', { team: 'ZZZ' }, engKeyActor, ['ZZZ']);
    expect(real).toMatchObject({ code: 'NOT_FOUND' });
    expect(real).toEqual(none);
    expect(await logLength()).toBe(before);
  });

  it('never lists, counts or groups OPS issues', async () => {
    const listed = await ok('issue.list', { limit: 100, includeArchived: true }, engKeyActor);
    expect(JSON.stringify(listed)).not.toContain(opsIssue);
    expect(JSON.stringify(listed)).toContain(engIssue);
    const byOps = { field: 'team', op: 'eq', value: ops };
    expect(await ok('issue.count', { filter: byOps }, engKeyActor)).toEqual({ count: 0 });
    const withKey = (await ok('issue.count', {}, engKeyActor)) as { count: number };
    const without = (await ok('issue.count', {}, zoeActor)) as { count: number };
    expect(withKey.count).toBeLessThan(without.count);
    const grouped = (await ok('issue.groupBy', { by: 'priority' }, engKeyActor)) as {
      groups: { count: number }[];
    };
    expect(grouped.groups.reduce((n, g) => n + g.count, 0)).toBe(withKey.count);
  });
});

describe('a member of SEC', () => {
  it('gets, edits, lists and groups SEC issues by identifier and id', async () => {
    expect(await ok('issue.get', { issue: 'SEC-1' }, samActor)).toMatchObject({
      id: secIssue,
      identifier: 'SEC-1',
      labels: [{ name: 'Secret sauce' }],
      // Absolute, on `SURFACE_URL` (D11).
      url: 'https://surface.example.com/issue/SEC-1/rotate-the-leaked-token',
    });
    expect(await ok('issue.update', { issue: secIssue, priority: 2 }, samActor)).toMatchObject({
      priority: 2,
    });
    const listed = await ok('issue.list', { team: 'SEC' }, samActor);
    expect(JSON.stringify(listed)).toContain(secIssue);
    const grouped = await ok('issue.groupBy', { team: 'SEC', by: 'label' }, samActor);
    expect(JSON.stringify(grouped)).toContain('Secret sauce');
  });

  it('may edit a public ENG issue, but not give it a SEC status or label (INV-06)', async () => {
    // A status resolves within the issue's team, so another team's is NOT_FOUND (§6.4).
    const status = await executor.execute(
      'issue.update',
      { issue: engIssue, status: secStatusId },
      samActor,
    );
    expect(status).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    // A label id resolves to any label the actor sees; INV-06 then refuses it (§4.2).
    const label = await executor.execute(
      'issue.update',
      { issue: engIssue, addLabels: [secLabel] },
      samActor,
    );
    expect(label).toMatchObject({
      ok: false,
      error: {
        code: 'INVALID_INPUT',
        message: 'That label belongs to another team. Use a label of ENG or a workspace label.',
      },
    });
    // A status name resolves in the issue's own team (ENG), never in SEC.
    expect(
      await ok('issue.update', { issue: engIssue, status: 'In Progress' }, samActor),
    ).toMatchObject({ status: { name: 'In Progress' } });
  });
});
