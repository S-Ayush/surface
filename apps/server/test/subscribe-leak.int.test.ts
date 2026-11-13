// PLAN-011 S4b leak test (SPEC-011 §5.7, AC-28, E32; §5.6; permissions.md §5; CLAUDE.md rule 4;
// not held, plans README §6). Partial issue loading must not open a side door to private team SEC
// for Ana, who isn't in it:
// - asking for SEC, on the socket URL, in `subscribe`/`unsubscribe` or as a partial bootstrap's
//   `?groups=team:SEC`, is answered exactly like asking for a team that doesn't exist;
// - a SEC issue Ana created or is assigned is in `team:SEC` only, so `user:<ana>` never carries it
//   in a bootstrap, catch-up or live (a public team's issue does: the control);
// - an API key limited to ENG never sees a public OPS issue, even one in `user:<ana>` (§5.6).
// SEC's member Sam gets SEC's issues, so the answers come from visibility, not broken routes.
// Issue children (IssueContent, IssueHistory) are in `team:<teamId>` only: one of Ana's own SEC
// issue never reaches her, and neither does one of her OPS issue, which `user:<ana>` carries.
import { randomUUID } from 'node:crypto';
import type { Actor } from '@surface/domain';
import {
  decodeBootstrapFrame,
  decodeServerMessage,
  encodeSocketConnectParams,
  encodeSocketMessage,
  NdjsonDecoder,
  SOCKET_PATH,
  type BootstrapFrame,
  type ClientMessage,
  type DeltaPacket,
  type ServerMessage,
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
import { acceptedTeams } from '../src/sync/groups.js';
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

const ana = randomUUID(); // a Member of public ENG only
const sam = randomUUID(); // the only member of private SEC
const bea = randomUUID(); // a Member of no team
const ops = randomUUID(); // a second public team, OPS, nobody's
const unknownTeam = randomUUID();
let sec = '';
let anaActor: Actor;
let samActor: Actor;
/** Ana through an API key limited to ENG. */
let anaKeyActor: Actor;

/** SEC issues Ana created or is assigned: `team:SEC` only all the same. */
const secByAna = uuidv7();
const secForAna = uuidv7();
/** OPS issues: one Ana is assigned (in `user:<ana>`), one nobody she knows touched. */
const opsForAna = uuidv7();
const opsOther = uuidv7();
const statusOf = new Map<string, string>();
const numbers = new Map<string, number>();

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

/** An issue written by the repo, numbered here (no `issue.create`: its counter isn't used). */
function insertIssue(
  repo: Repo,
  id: string,
  teamId: string,
  creatorId: string,
  assigneeId: string | null = null,
) {
  const number = (numbers.get(teamId) ?? 0) + 1;
  numbers.set(teamId, number);
  return repo.insert('Issue', {
    id,
    teamId,
    number,
    title: `Issue ${String(number)}`,
    statusId: statusOf.get(teamId) ?? '',
    sortOrder: `a${String(number)}`,
    creatorId,
    assigneeId,
  });
}

beforeAll(async () => {
  h = await executorHarness();
  sec = h.teams.sec;
  await transaction(async (repo) => {
    for (const [id, name] of [
      [ana, 'ana'],
      [sam, 'sam'],
      [bea, 'bea'],
    ] as const) {
      await repo.insert('User', {
        id,
        email: `${name}@example.com`,
        name,
        displayName: name,
        role: 'member',
        syncGroups: [],
      });
    }
    for (const [teamId, userId] of [
      [h.teams.eng, ana],
      [sec, sam],
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
  const { rows } = await h.pool.query<{ id: string; status: string }>(
    'SELECT id::text, default_status_id::text AS status FROM teams',
  );
  for (const row of rows) statusOf.set(row.id, row.status);
  await transaction(async (repo) => {
    await insertIssue(repo, secByAna, sec, ana);
    await insertIssue(repo, secForAna, sec, sam, ana);
    await insertIssue(repo, opsForAna, ops, sam, ana);
    await insertIssue(repo, opsOther, ops, bea);
  });

  const publicTeams = [h.teams.eng, ops];
  const engMembership = { teamId: h.teams.eng, private: false };
  anaActor = actorFor({ id: ana, memberships: [engMembership], publicTeams });
  samActor = actorFor({ id: sam, memberships: [{ teamId: sec, private: true }], publicTeams });
  anaKeyActor = actorFor(
    { id: ana, memberships: [engMembership], publicTeams },
    {
      kind: 'api',
      apiKey: {
        id: randomUUID(),
        scope: 'read_write',
        teamIds: [h.teams.eng],
        allowDestructive: false,
      },
    },
  );
  executor = testExecutor(h.pool).executor;

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
    // As `serve()` wires it: the database decides, at each request.
    teamAccess: (userId, teamIds) => acceptedTeams(h.pool, userId, teamIds),
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
// Helpers

type Who = 'outsider' | 'member';
const userOf = (who: Who) => (who === 'outsider' ? ana : sam);
/** Everything that names private team SEC or one of its issues. */
const secWords = () => [sec, secByAna, secForAna];

/** A live WebSocket recording every message; `teams` absent follows the member teams. */
function connect(who: Who, { since = 0, teams }: { since?: number; teams?: string[] } = {}) {
  const raw: string[] = [];
  const messages: ServerMessage[] = [];
  const query = encodeSocketConnectParams({
    since,
    clientId: randomUUID(),
    userId: userOf(who),
    schemaHash: registry.schemaHash,
    ...(teams === undefined ? {} : { teams }),
  });
  const socket = new WebSocket(`${socketUrl}${SOCKET_PATH}?${query}`, {
    headers: { 'x-test-actor': who },
  });
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('socket failed')));
  });
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') throw new Error('binary frame');
    raw.push(event.data);
    messages.push(decodeServerMessage(event.data));
  });
  return {
    messages,
    text: () => raw.join('\n'),
    packets: () => messages.flatMap((m) => (m.t === 'deltas' ? m.packets : [])),
    acks: () => messages.filter((m) => m.t === 'subscribed' || m.t === 'unsubscribed'),
    send: async (message: ClientMessage) => {
      await opened;
      socket.send(encodeSocketMessage(message));
    },
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

/** A row everyone sees, written last: once it reaches a socket, every earlier write has too. */
async function marker(): Promise<string> {
  const id = randomUUID();
  await transaction((repo) =>
    repo.insert('DebugItem', { id, title: 'Marker', syncGroups: ['workspace'] }),
  );
  return id;
}

/** A history entry of `issueId` by Ana, in its own transaction. */
const writeHistory = (id: string, issueId: string, teamId: string) =>
  transaction((repo) =>
    repo.insert('IssueHistory', {
      id,
      issueId,
      teamId,
      actorKind: 'user',
      actorId: ana,
      kind: 'updated',
      changes: { title: { from: 'Old', to: 'New' } },
    }),
  );
const childIdsIn = (packets: readonly DeltaPacket[]) =>
  packets.flatMap((p) =>
    p.a !== 'D' && p.a !== 'G' && (p.m === 'IssueContent' || p.m === 'IssueHistory')
      ? [p.d.id]
      : [],
  );

const issueIdsIn = (packets: readonly DeltaPacket[]) =>
  packets.flatMap((p) => (p.a !== 'D' && p.a !== 'G' && p.m === 'Issue' ? [p.d.id] : []));
const deletedIn = (packets: readonly DeltaPacket[]) =>
  packets.flatMap((p) => (p.a === 'D' && p.m === 'Issue' ? [p.mid] : []));

function expectNoSec(text: string) {
  for (const word of secWords()) expect(text).not.toContain(word);
}

async function bootstrap(who: Who, query = '') {
  const res = await app.inject({
    url: `/sync/bootstrap?userId=${userOf(who)}${query}`,
    headers: { 'x-test-actor': who },
  });
  expect(res.statusCode).toBe(200);
  const decoder = new NdjsonDecoder();
  const frames = [...decoder.push(new Uint8Array(res.rawPayload)), ...decoder.end()].map(
    decodeBootstrapFrame,
  );
  const issues = frames
    .filter((f): f is Extract<BootstrapFrame, { t: 'row' }> => f.t === 'row' && f.m === 'Issue')
    .map((f) => f.d.id);
  return { body: res.body, issues };
}

const partial = (teamId: string) => `&schemaHash=${registry.schemaHash}&groups=team:${teamId}`;
/** A bootstrap body with the values that change between two requests blanked. */
const blank = (body: string) =>
  body
    .replace(/"lastSyncId":\d+/, '"lastSyncId":0')
    .replace(/"serverTime":"[^"]+"/, '"serverTime":""');

// ---------------------------------------------------------------------------------------------

describe('a SEC issue Ana created or is assigned', () => {
  it('is stored in team:SEC only, a public team’s in its people’s user: groups too', async () => {
    const { rows } = await h.pool.query<{ id: string; groups: string[] }>(
      'SELECT id::text, sync_groups AS groups FROM issues WHERE id = ANY($1::uuid[])',
      [[secByAna, secForAna, opsForAna]],
    );
    const groups = new Map(rows.map((r) => [r.id, r.groups]));
    expect(groups.get(secByAna)).toEqual([`team:${sec}`]);
    expect(groups.get(secForAna)).toEqual([`team:${sec}`]);
    expect(groups.get(opsForAna)).toEqual([`team:${ops}`, `user:${sam}`, `user:${ana}`]);
  });

  it('is not in Ana’s full bootstrap, which has her public issue through user:<ana>', async () => {
    const { body, issues } = await bootstrap('outsider');
    expectNoSec(body);
    expect(issues).toContain(opsForAna);
    expect(issues).not.toContain(opsOther); // OPS isn't hers: it loads on demand
    expect((await bootstrap('member')).issues).toEqual(
      expect.arrayContaining([secByAna, secForAna]),
    );
  });

  it('is not in Ana’s catch-up, which has her public issue', async () => {
    const done = await marker();
    const outsider = connect('outsider');
    try {
      await eventually(() => outsider.text().includes(done));
      expectNoSec(outsider.text());
      expect(issueIdsIn(outsider.packets())).toContain(opsForAna);
    } finally {
      outsider.close();
    }
  });

  it('never reaches Ana live, created, reassigned or edited; her public issue’s D does', async () => {
    const outsider = connect('outsider', { since: await head() });
    const member = connect('member', { since: await head() });
    try {
      const live = uuidv7();
      await transaction((repo) => insertIssue(repo, live, sec, ana, ana));
      await transaction((repo) => repo.update('Issue', secForAna, { assigneeId: null }));
      await transaction((repo) => repo.update('Issue', secForAna, { assigneeId: ana }));
      await transaction((repo) => repo.update('Issue', secByAna, { title: 'Live secret' }));
      // Child rows travel in `team:<teamId>` only, even of an issue `user:<ana>` carries.
      const secChild = uuidv7();
      const opsChild = uuidv7();
      await writeHistory(secChild, secByAna, sec);
      await writeHistory(opsChild, opsForAna, ops);
      // The control: reassigning her OPS issue away is a D for Ana (E29).
      await transaction((repo) => repo.update('Issue', opsForAna, { assigneeId: bea }));
      const done = await marker();
      await eventually(() => outsider.text().includes(done));
      expectNoSec(outsider.text());
      expect(outsider.text()).not.toContain(live);
      expect(outsider.text()).not.toContain('Live secret');
      expect(deletedIn(outsider.packets())).toEqual([opsForAna]);
      expect(childIdsIn(outsider.packets())).toEqual([]);
      expect(outsider.text()).not.toContain(opsChild);
      await eventually(() => childIdsIn(member.packets()).includes(secChild));
      await eventually(() => issueIdsIn(member.packets()).includes(live));
      expect(issueIdsIn(member.packets())).toEqual(
        expect.arrayContaining([live, secForAna, secByAna]),
      );
      // Back to Ana for the tests below (a U in `user:<ana>` again).
      await transaction((repo) => repo.update('Issue', opsForAna, { assigneeId: ana }));
      await eventually(() => issueIdsIn(outsider.packets()).includes(opsForAna));
    } finally {
      outsider.close();
      member.close();
    }
  });
});

describe('asking to follow SEC, as Ana, is like asking for a team that doesn’t exist (AC-28, E32)', () => {
  it('on the socket URL: the same ack and the same stream', async () => {
    const done = await marker();
    const viaSec = connect('outsider', { teams: [sec] });
    const viaUnknown = connect('outsider', { teams: [unknownTeam] });
    const viaOps = connect('outsider', { teams: [ops] });
    try {
      const caughtUp = (socket: ReturnType<typeof connect>) => socket.text().includes(done);
      await eventually(() => caughtUp(viaSec) && caughtUp(viaUnknown) && caughtUp(viaOps));
      expect(viaSec.messages[0]).toEqual({ t: 'subscribed', teams: [], at: 0 });
      expect(viaUnknown.messages[0]).toEqual(viaSec.messages[0]);
      expect(viaSec.packets()).toEqual(viaUnknown.packets());
      expectNoSec(viaSec.text());
      // Neither follows ENG: naming `teams` replaces the member teams. OPS is in no group of theirs.
      expect(issueIdsIn(viaSec.packets())).not.toContain(opsOther);
      // The control: a public team is accepted and streamed.
      expect(viaOps.messages[0]).toEqual({ t: 'subscribed', teams: [ops], at: 0 });
      expect(issueIdsIn(viaOps.packets())).toContain(opsOther);
      expectNoSec(viaOps.text());
    } finally {
      for (const socket of [viaSec, viaUnknown, viaOps]) socket.close();
    }
  });

  it('in subscribe and unsubscribe: the same acks, and nothing of SEC streamed', async () => {
    const at = await head();
    const outsider = connect('outsider', { since: at, teams: [] });
    try {
      await eventually(() => outsider.acks().length === 1);
      expect(outsider.acks()).toEqual([{ t: 'subscribed', teams: [], at }]);
      await outsider.send({ t: 'subscribe', teams: [sec] });
      await outsider.send({ t: 'subscribe', teams: [unknownTeam] });
      await outsider.send({ t: 'unsubscribe', teams: [sec] });
      await outsider.send({ t: 'unsubscribe', teams: [unknownTeam] });
      await outsider.send({ t: 'subscribe', teams: [ops] });
      await eventually(() => outsider.acks().length === 6);
      const [, ...answers] = outsider.acks();
      // `at` aside, and with the asked id blanked: `unsubscribed` names every team asked that
      // isn't a home group, followed or not, so SEC and the unknown team read the same.
      const withoutAt = answers.map(({ t, teams }) => ({
        t,
        teams: teams.map((team) => (team === sec || team === unknownTeam ? '<asked>' : team)),
      }));
      expect(withoutAt).toEqual([
        { t: 'subscribed', teams: [] },
        { t: 'subscribed', teams: [] },
        { t: 'unsubscribed', teams: ['<asked>'] },
        { t: 'unsubscribed', teams: ['<asked>'] },
        { t: 'subscribed', teams: [ops] },
      ]);

      // Live: SEC's writes never come; OPS's do, now that it is followed.
      const live = uuidv7();
      await transaction((repo) => insertIssue(repo, live, sec, sam));
      await transaction((repo) => repo.update('Issue', secByAna, { title: 'Still secret' }));
      const opsLive = uuidv7();
      await transaction((repo) => insertIssue(repo, opsLive, ops, bea));
      await eventually(() => issueIdsIn(outsider.packets()).includes(opsLive));
      // Only the deltas: the `unsubscribed` ack names the SEC id Ana sent herself.
      const deltas = JSON.stringify(outsider.packets());
      expectNoSec(deltas);
      expect(deltas).not.toContain(live);
      expect(deltas).not.toContain('Still secret');
    } finally {
      outsider.close();
    }
  });

  it('as a partial bootstrap: the same body, and SEC’s member gets SEC’s issues', async () => {
    const viaSec = await bootstrap('outsider', partial(sec));
    const viaUnknown = await bootstrap('outsider', partial(unknownTeam));
    expect(blank(viaSec.body)).toBe(blank(viaUnknown.body));
    expect(viaSec.issues).toEqual([]);
    expectNoSec(viaSec.body);
    // The controls: a public team's issues for Ana, SEC's for Sam.
    const viaOps = await bootstrap('outsider', partial(ops));
    expect(viaOps.issues).toEqual(expect.arrayContaining([opsForAna, opsOther]));
    expectNoSec(viaOps.body);
    expect((await bootstrap('member', partial(sec))).issues).toEqual(
      expect.arrayContaining([secByAna, secForAna]),
    );
  });
});

describe('an API key limited to ENG (SPEC-011 §5.6)', () => {
  async function failure(operation: string, input: object, hidden: string) {
    const result = await executor.execute(operation, input, anaKeyActor);
    if (result.ok) return { ok: true };
    const { code, message } = result.error;
    return { code, message: message.replaceAll(hidden, '<ref>') };
  }

  it('never sees an OPS issue in user:<ana>, which Ana herself sees', async () => {
    const real = await failure('issue.get', { issue: opsForAna }, opsForAna);
    const unknown = uuidv7();
    expect(real).toMatchObject({ code: 'NOT_FOUND' });
    expect(real).toEqual(await failure('issue.get', { issue: unknown }, unknown));
    const listed = await executor.execute('issue.list', { limit: 100 }, anaKeyActor);
    expect(listed.ok).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(opsForAna);
    // The control: without the key, Ana gets it.
    expect(await executor.execute('issue.get', { issue: opsForAna }, anaActor)).toMatchObject({
      ok: true,
      result: { id: opsForAna },
    });
  });
});
