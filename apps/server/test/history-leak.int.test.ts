// Private-team leak test for issue history (permissions.md §5 "History"; SPEC-011 §4.4 "No
// snapshot of what a viewer can't see", D15; CLAUDE.md rule 4; not held, plans README §6).
//
// An entry snapshots the *names* of the rows it mentions (status, assignee, labels), so the rule
// holds only if every row an entry names is visible to everyone who can read the issue. In M1 that
// is true by construction (INV-06: an edit can't give an issue another team's status or label; a
// move between teams doesn't exist yet). This test proves it on the wire: a public ENG issue is
// edited as hard as the operations allow, SEC's names are offered to it and refused, and then
// every path an ENG-only reader has (`/sync/content`, a socket catch-up from 0, and the activity
// lines the issue page renders from those rows) is searched for SEC's team name, key, status and
// label names and ids. A SEC member reading SEC's own history is the control: the names are real.
import { randomUUID } from 'node:crypto';
import { activityLines, parseHistoryChanges, type Actor } from '@surface/domain';
import {
  ContentStreamReader,
  decodeServerMessage,
  encodeContentQuery,
  encodeSocketConnectParams,
  issueParent,
  NdjsonDecoder,
  SOCKET_PATH,
  type ContentFrame,
  type DeltaPacket,
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

const secIssue = uuidv7();
const engIssue = uuidv7();
const secLabel = uuidv7();
const engLabel = uuidv7();
let secStatusId = '';
/** Names only SEC's members can see: its team name, a status and a label. */
const SEC_NAMES = ['Security', 'Embargoed', 'Secret sauce'];
const SEC_KEY = 'SEC';
/** The ENG names the history does carry, so a green test isn't an empty one. */
const ENG_NAMES = ['In Progress', 'Customer facing'];
/** ENG issue entries: created, status, label added, assignee + priority, assignee, label removed. */
const ENG_ENTRIES = 6;

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
  executor = testExecutor(h.pool).executor;

  // SEC: a status and a label with names no ENG row has, and an issue that wears both.
  await ok('status.create', { team: 'SEC', name: 'Embargoed', category: 'started' }, samActor);
  const { rows } = await h.pool.query<{ id: string }>(
    `SELECT id FROM workflow_statuses WHERE team_id = $1 AND name = 'Embargoed'`,
    [h.teams.sec],
  );
  secStatusId = rows[0]?.id ?? '';
  if (secStatusId === '') throw new Error('SEC status not created');
  await ok('label.create', { id: secLabel, team: 'SEC', name: 'Secret sauce' }, samActor);
  await ok(
    'issue.create',
    {
      id: secIssue,
      team: 'SEC',
      title: 'Rotate the leaked token',
      status: 'Embargoed',
      assignee: 'me',
      labels: ['Secret sauce'],
    },
    samActor,
  );

  // ENG: a public issue, edited by people other than its creator so every change is its own
  // entry (no creator fold), including by a SEC member, the one reader who knows SEC's names.
  await ok('label.create', { id: engLabel, team: 'ENG', name: 'Customer facing' }, zoeActor);
  await ok('issue.create', { id: engIssue, team: 'ENG', title: 'Fix login' }, anaActor);
  await ok('issue.update', { issue: engIssue, status: 'In Progress' }, zoeActor);
  await ok('issue.update', { issue: engIssue, addLabels: ['Customer facing'] }, zoeActor);
  await ok('issue.update', { issue: engIssue, assignee: 'me', priority: 2 }, zoeActor);
  await ok('issue.update', { issue: engIssue, assignee: 'me' }, samActor);
  await ok('issue.update', { issue: engIssue, removeLabels: ['Customer facing'] }, zoeActor);
  // The cross-team attempts an editor can make: SEC's status and label by id (refused, INV-06).
  const refusedStatus = await executor.execute(
    'issue.update',
    { issue: engIssue, status: secStatusId },
    zoeActor,
  );
  const refusedLabel = await executor.execute(
    'issue.update',
    { issue: engIssue, addLabels: [secLabel] },
    zoeActor,
  );
  expect(refusedStatus.ok).toBe(false);
  expect(refusedLabel.ok).toBe(false);

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

async function content(who: Who, issueId: string) {
  const parents = [issueParent(issueId)];
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

interface Entry {
  readonly kind: string;
  readonly actorKind: 'user' | 'api' | 'mcp' | 'system';
  readonly actorId: string | null;
  readonly changes: unknown;
}

/** One history row as the activity line reads it (none, if it isn't a history row). */
function entryOf(d: Record<string, unknown>): Entry[] {
  const { kind, actorKind, actorId, changes } = d;
  if (
    typeof kind !== 'string' ||
    (actorKind !== 'user' && actorKind !== 'api' && actorKind !== 'mcp' && actorKind !== 'system')
  ) {
    return [];
  }
  return [{ kind, actorKind, actorId: typeof actorId === 'string' ? actorId : null, changes }];
}
const entriesInFrames = (frames: readonly ContentFrame[]) =>
  frames.flatMap((f) => (f.t === 'row' && f.m === 'IssueHistory' ? entryOf(f.d) : []));
const entriesInPackets = (packets: readonly DeltaPacket[]) =>
  packets.flatMap((p) =>
    p.a !== 'D' && p.a !== 'G' && p.m === 'IssueHistory' && p.d['issueId'] === engIssue
      ? entryOf(p.d)
      : [],
  );

/** Every line the issue page would render for these entries (the actor's name is the replica's). */
const linesOf = (entries: readonly Entry[]) => entries.flatMap((e) => activityLines(e, 'someone'));

/** The ids an entry list's `changes` reference, by kind. */
function referencedIds(entries: readonly Entry[]) {
  const statuses: string[] = [];
  const labelIds: string[] = [];
  const userIds: string[] = [];
  for (const e of entries) {
    const changes = parseHistoryChanges(e.changes);
    for (const side of [changes.status?.from, changes.status?.to]) {
      if (side) statuses.push(side.id);
    }
    for (const side of [changes.assignee?.from, changes.assignee?.to]) {
      if (side) userIds.push(side.id);
    }
    const labels = changes.labels;
    if (labels !== undefined) {
      const named = 'to' in labels ? labels.to : [...labels.added, ...labels.removed];
      for (const l of named) labelIds.push(l.id);
    }
  }
  return { statuses, labelIds, userIds };
}

function expectNoSecret(text: string, where: string) {
  for (const name of SEC_NAMES) expect(text, `${where}: ${name}`).not.toContain(name);
  expect(text, `${where}: SEC key`).not.toMatch(new RegExp(`\\b${SEC_KEY}\\b`));
  for (const id of [h.teams.sec, secStatusId, secLabel, secIssue]) {
    expect(text, `${where}: ${id}`).not.toContain(id);
  }
}

describe('history of a public issue', () => {
  it('never names a private team’s status, label or user to someone who can read the issue', async () => {
    for (const who of ['outsider', 'admin'] as const) {
      const { body, frames } = await content(who, engIssue);
      const entries = entriesInFrames(frames);
      expect(entries).toHaveLength(ENG_ENTRIES);
      // Wire bytes: no SEC team name, key, status, label, or any of their ids.
      expectNoSecret(body, `/sync/content as ${who}`);
      // Rendered lines (what the issue page shows).
      const lines = linesOf(entries).join('\n');
      expectNoSecret(lines, `activity lines for ${who}`);
      // Not an empty pass: the history does name ENG's own rows.
      for (const name of ENG_NAMES) expect(body).toContain(name);
      expect(lines).toContain('moved from Backlog to In Progress');
      expect(lines).toContain('Customer facing');
      // Every id it references is a row of ENG, none of SEC's.
      const refs = referencedIds(entries);
      expect(refs.statuses.length).toBeGreaterThan(0);
      expect(refs.labelIds.length).toBeGreaterThan(0);
      expect(refs.userIds.length).toBeGreaterThan(0);
      const statusTeams = await h.pool.query<{ team_id: string }>(
        'SELECT DISTINCT team_id FROM workflow_statuses WHERE id = ANY($1::uuid[])',
        [refs.statuses],
      );
      expect(statusTeams.rows.map((r) => r.team_id)).toEqual([h.teams.eng]);
      const labelTeams = await h.pool.query<{ team_id: string | null }>(
        'SELECT DISTINCT team_id FROM labels WHERE id = ANY($1::uuid[])',
        [refs.labelIds],
      );
      expect(labelTeams.rows.map((r) => r.team_id)).toEqual([h.teams.eng]);
      // Users are visible to every viewer (§4.4), including one known mostly through SEC.
      expect(refs.userIds).toEqual(expect.arrayContaining([zoe, sam]));
    }
  });

  it('is clean in a socket catch-up from the start too', async () => {
    const raw: string[] = [];
    const packets: DeltaPacket[] = [];
    const query = encodeSocketConnectParams({
      since: 0,
      clientId: randomUUID(),
      userId: ana,
      schemaHash: registry.schemaHash,
    });
    const socket = new WebSocket(`${socketUrl}${SOCKET_PATH}?${query}`, {
      headers: { 'x-test-actor': 'outsider' },
    });
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') throw new Error('binary frame');
      raw.push(event.data);
      const message = decodeServerMessage(event.data);
      if (message.t === 'deltas') packets.push(...message.packets);
    });
    try {
      const deadline = Date.now() + 5000;
      while (entriesInPackets(packets).length < ENG_ENTRIES) {
        if (Date.now() > deadline) throw new Error('history not delivered in 5 s');
        await new Promise((resolve) => setImmediate(resolve));
      }
      const text = raw.join('\n');
      expectNoSecret(text, 'catch-up');
      expectNoSecret(linesOf(entriesInPackets(packets)).join('\n'), 'catch-up lines');
      expect(text).toContain('In Progress');
    } finally {
      socket.close();
    }
  });

  it('shows a SEC member SEC’s real names in SEC’s own history (the control)', async () => {
    const { body, frames } = await content('member', secIssue);
    expect(entriesInFrames(frames).map((e) => e.kind)).toEqual(['created']);
    expect(body).toContain('Embargoed');
    expect(body).toContain('Secret sauce');
    expect(body).toContain(secStatusId);
  });

  it('gives an ENG-only reader nothing of SEC’s history, not even a name', async () => {
    for (const who of ['outsider', 'admin'] as const) {
      const { body, frames } = await content(who, secIssue);
      expect(entriesInFrames(frames)).toEqual([]);
      expectNoSecret(body, `SEC issue as ${who}`);
    }
  });
});
