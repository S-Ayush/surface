// SPEC-011 §5.7, E30, E35; PLAN-011 S4c: how storage writes a partial bootstrap answer and an
// unsubscribe, on every backend, and how the store keeps live packets above the answer's id.
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { IssueShape, StoredChange, SyncStorage } from '../src/storage/types.js';
import type { SyncStore } from '../src/store.js';
import { FakeHub } from './support/hub.js';
import { eventually, keptMemoryStorage, teamStore, teamView, until } from './support/live.js';
import { OTHER_USER, USER_ID, id } from './support/models.js';
import { BACKENDS, closePorts, uniqueName } from './support/storage.js';

const MODELS = ['Task', 'TaskPart', 'TaskNote'];
const SHAPE: IssueShape = {
  issue: 'Task',
  children: [{ model: 'TaskPart', field: 'issueId' }],
  content: [{ model: 'TaskNote', field: 'issueId' }],
};
const SQUAD_A = id(1);
const SQUAD_B = id(2);
const HASH = 'a'.repeat(64);

const task = (n: number, team: string, fields: Record<string, unknown> = {}) => ({
  id: id(n),
  teamId: team,
  title: `Task ${n}`,
  groups: [`team:${team}`],
  ...fields,
});
const part = (n: number, issue: number) => ({ id: id(n), issueId: id(issue), body: `Part ${n}` });
const note = (n: number, issue: number) => ({ id: id(n), issueId: id(issue), body: `Note ${n}` });
const upsert = (model: string, version: number, row: { id: string }): StoredChange => ({
  kind: 'upsert',
  model,
  version,
  row,
});

async function ids(storage: SyncStorage, model: string): Promise<string[]> {
  const page = await storage.readRows(model, undefined, 1000);
  return page.rows.map((r) => r.row.id).sort();
}

afterAll(closePorts);

describe.each(BACKENDS)('$name storage, partial writes', (backend) => {
  /** A replica bootstrapped at 10 with squad A's group, then live changes 11–20 of squad B. */
  async function replica() {
    const storage = await backend.open(uniqueName(), MODELS);
    const generation = await storage.beginBootstrap({
      schemaHash: HASH,
      lastSyncId: 10,
      groups: ['workspace', `team:${SQUAD_A}`],
    });
    await storage.writeBootstrapRows(generation, [
      { model: 'Task', row: task(1, SQUAD_A), archived: false },
    ]);
    await storage.finishBootstrap(generation);
    return { storage, generation };
  }

  it('starts teamThrough at the bootstrap snapshot for its team groups', async () => {
    const { storage } = await replica();
    expect((await storage.readMeta())?.teamThrough).toEqual({ [SQUAD_A]: 10 });
  });

  it('writes the answer at its id but keeps rows and tombstones stored at or above it (E30)', async () => {
    const { storage, generation } = await replica();
    // Live packets 21 and 22, applied while the answer (C = 20) was on its way.
    await storage.applyChanges(
      generation,
      [
        upsert('Task', 21, task(11, SQUAD_B, { title: 'Renamed at 21' })),
        { kind: 'delete', model: 'Task', version: 22, id: id(12) },
      ],
      22,
    );
    await storage.writePartialRows(generation, {
      shape: SHAPE,
      teams: [SQUAD_B],
      version: 20,
      through: 22,
      rows: [
        { model: 'Task', row: task(11, SQUAD_B), archived: false },
        { model: 'Task', row: task(12, SQUAD_B), archived: false },
        { model: 'Task', row: task(13, SQUAD_B), archived: false },
        { model: 'TaskPart', row: part(31, 13), archived: false },
        // Task 12's part goes with it: a purge's children's deletes are not logged (ADR-0022).
        { model: 'TaskPart', row: part(32, 12), archived: false },
      ],
    });
    const page = await storage.readRows('Task', undefined, 1000);
    const byId = Object.fromEntries(page.rows.map((r) => [r.row.id, r.row['title']]));
    expect(byId).toEqual({ [id(1)]: 'Task 1', [id(11)]: 'Renamed at 21', [id(13)]: 'Task 13' });
    expect(await ids(storage, 'TaskPart')).toEqual([id(31)]);
    // No new generation and no move of lastSyncId: only the team's cursor moves.
    expect(await storage.readMeta()).toMatchObject({
      generation,
      lastSyncId: 22,
      teamThrough: { [SQUAD_A]: 10, [SQUAD_B]: 22 },
    });
  });

  it("sweeps the team's stored issues the answer lacks, with their children and content (E35)", async () => {
    const { storage, generation } = await replica();
    await storage.applyChanges(
      generation,
      [
        upsert('Task', 11, task(11, SQUAD_B)),
        upsert('Task', 12, task(12, SQUAD_B)),
        upsert('TaskPart', 13, part(31, 11)),
        upsert('TaskPart', 14, part(32, 12)),
        upsert('TaskNote', 15, note(41, 11)),
        upsert('TaskNote', 16, note(42, 12)),
        upsert('Task', 17, task(2, SQUAD_A)),
        // Newer than the answer: kept although the answer lacks it.
        upsert('Task', 25, task(14, SQUAD_B)),
      ],
      25,
    );
    await storage.writePartialRows(generation, {
      shape: SHAPE,
      teams: [SQUAD_B],
      version: 20,
      through: 25,
      // Task 11 stays without its part 31 (deleted while this tab was behind); task 12 is gone.
      rows: [{ model: 'Task', row: task(11, SQUAD_B), archived: false }],
    });
    expect(await ids(storage, 'Task')).toEqual([id(1), id(2), id(11), id(14)]);
    expect(await ids(storage, 'TaskPart')).toEqual([]);
    // Task 11 is kept, so its content stays; task 12's goes with it.
    expect(await ids(storage, 'TaskNote')).toEqual([id(41)]);
  });

  it('leaves tombstones from the sweep: a delta older than the answer cannot bring a row back', async () => {
    const { storage, generation } = await replica();
    await storage.applyChanges(generation, [upsert('Task', 11, task(11, SQUAD_B))], 11);
    await storage.writePartialRows(generation, {
      shape: SHAPE,
      teams: [SQUAD_B],
      version: 20,
      through: 11,
      rows: [],
    });
    // A second tab's late write of an older answer is fenced by version too.
    await storage.writePartialRows(generation, {
      shape: SHAPE,
      teams: [SQUAD_B],
      version: 15,
      through: 11,
      rows: [{ model: 'Task', row: task(11, SQUAD_B), archived: false }],
    });
    expect(await ids(storage, 'Task')).toEqual([id(1)]);
  });

  it("removes a team's rows on unsubscribe, keeping rows another group holds without their children", async () => {
    const { storage, generation } = await replica();
    const own = task(12, SQUAD_B, { groups: [`team:${SQUAD_B}`, `user:${USER_ID}`] });
    await storage.applyChanges(
      generation,
      [
        upsert('Task', 11, task(11, SQUAD_B)),
        upsert('Task', 12, own),
        upsert('TaskPart', 13, part(31, 11)),
        upsert('TaskPart', 14, part(32, 12)),
        upsert('TaskNote', 15, note(42, 12)),
      ],
      15,
      [SQUAD_B],
    );
    expect((await storage.readMeta())?.teamThrough).toEqual({ [SQUAD_A]: 10, [SQUAD_B]: 15 });
    await storage.removeTeamRows(generation, {
      shape: SHAPE,
      teams: [SQUAD_B],
      keep: ['workspace', `team:${SQUAD_A}`, `user:${USER_ID}`],
    });
    expect(await ids(storage, 'Task')).toEqual([id(1), id(12)]);
    expect(await ids(storage, 'TaskPart')).toEqual([]);
    expect(await ids(storage, 'TaskNote')).toEqual([]);
    expect(await storage.readMeta()).toMatchObject({
      lastSyncId: 15,
      teamThrough: { [SQUAD_A]: 10 },
    });
    // No tombstones: subscribing again at the same id loads the rows again.
    await storage.writePartialRows(generation, {
      shape: SHAPE,
      teams: [SQUAD_B],
      version: 15,
      through: 15,
      rows: [
        { model: 'Task', row: task(11, SQUAD_B), archived: false },
        { model: 'Task', row: own, archived: false },
        { model: 'TaskPart', row: part(31, 11), archived: false },
      ],
    });
    expect(await ids(storage, 'Task')).toEqual([id(1), id(11), id(12)]);
    expect(await ids(storage, 'TaskPart')).toEqual([id(31)]);
  });

  it('keeps a child stored before its task, and sweeps a team child whose task stays absent (SPEC-014 D30)', async () => {
    const { storage, generation } = await replica();
    // Live parts of squad B that came while its load was pending, above the answer's id (20).
    const teamPart = (n: number, issue: number) => ({ ...part(n, issue), teamId: SQUAD_B });
    await storage.applyChanges(
      generation,
      [upsert('TaskPart', 21, teamPart(33, 11)), upsert('TaskPart', 22, teamPart(34, 12))],
      22,
    );
    await storage.writePartialRows(generation, {
      shape: SHAPE,
      teams: [SQUAD_B],
      version: 20,
      through: 22,
      // The answer brings task 11; task 12 was archived before it (a stray `setPreview` part).
      rows: [{ model: 'Task', row: task(11, SQUAD_B), archived: false }],
    });
    expect(await ids(storage, 'Task')).toEqual([id(1), id(11)]);
    expect(await ids(storage, 'TaskPart')).toEqual([id(33)]);
    // The sweep's tombstone is at the swept row's version: the same packet can't bring it back.
    await storage.applyChanges(generation, [upsert('TaskPart', 22, teamPart(34, 12))], 22);
    expect(await ids(storage, 'TaskPart')).toEqual([id(33)]);
  });

  it("removes a team's child whose task isn't stored on unsubscribe (SPEC-014 D30)", async () => {
    const { storage, generation } = await replica();
    const teamPart = { ...part(33, 11), teamId: SQUAD_B };
    await storage.applyChanges(generation, [upsert('TaskPart', 11, teamPart)], 11);
    await storage.removeTeamRows(generation, {
      shape: SHAPE,
      teams: [SQUAD_B],
      keep: ['workspace', `team:${SQUAD_A}`],
    });
    expect(await ids(storage, 'TaskPart')).toEqual([]);
  });

  it('keeps the on-demand teams most recent first, at most `limit`, across a new bootstrap', async () => {
    const { storage } = await replica();
    expect(await storage.readOnDemand()).toEqual([]);
    await storage.touchOnDemand(id(3), 2);
    await storage.touchOnDemand(id(4), 2);
    expect(await storage.touchOnDemand(id(3), 2)).toEqual({ teams: [id(3), id(4)], dropped: [] });
    expect(await storage.touchOnDemand(id(5), 2)).toEqual({
      teams: [id(5), id(3)],
      dropped: [id(4)],
    });
    await storage.beginBootstrap({ schemaHash: HASH, lastSyncId: 30, groups: ['workspace'] });
    expect(await storage.readOnDemand()).toEqual([id(5), id(3)]);
  });
});

describe('store: a partial answer never undoes a live packet above it (E30)', () => {
  const stores: SyncStore[] = [];
  afterEach(async () => {
    for (const store of stores.splice(0)) await store.close();
  });

  it('keeps an archive, a delete and a rename that arrived while the answer was on its way', async () => {
    const hub = new FakeHub().withTeams();
    hub.addSquad(1);
    hub.addSquad(3);
    hub.join(USER_ID, 1);
    for (const n of [130, 131, 132, 133]) hub.putTask(n, 3, { creatorId: OTHER_USER });
    hub.putPart(501, 133);
    const { store } = teamStore(hub);
    stores.push(store);
    await store.start();
    await eventually(() => hub.live.length > 0);
    hub.holdPartial = true;
    store.openTeam(id(3));
    await eventually(() => hub.partialRequests.length === 1);
    // The answer was snapshot at C; these packets are above it and reach the client first.
    hub.archiveTask(130);
    hub.deleteTask(131);
    hub.putTask(132, 3, { title: 'Renamed' });
    hub.putTask(134, 3, { creatorId: OTHER_USER });
    hub.purgeTask(133);
    await until(() => teamView(store).tasks[id(134)] !== undefined);
    hub.releasePartial();
    await until(() => store.teamLoadState(id(3)) === 'ready');
    const view = teamView(store);
    expect(Object.keys(view.tasks).sort()).toEqual([id(132), id(134)]);
    expect(view.tasks[id(132)]).toMatchObject({ title: 'Renamed' });
    expect(view.parts).toEqual({});
  });
});

describe("store: an eager child waits for its team's load (SPEC-014 D30, amended 2026-11-24)", () => {
  const stores: SyncStore[] = [];
  afterEach(async () => {
    for (const store of stores.splice(0)) await store.close();
  });

  /**
   * Squad 3 (public, not a member) with live task 133 and archived task 135, its answer held;
   * squads 1 and 5 public, the user's.
   */
  async function loading() {
    const hub = new FakeHub().withTeams();
    hub.addSquad(1);
    hub.addSquad(3);
    hub.addSquad(5);
    hub.join(USER_ID, 1);
    hub.join(USER_ID, 5);
    hub.putTask(150, 5, { creatorId: OTHER_USER });
    hub.putTask(133, 3, { creatorId: OTHER_USER });
    hub.putTask(135, 3, { creatorId: OTHER_USER });
    hub.archiveTask(135);
    const kept = keptMemoryStorage();
    const { store } = teamStore(hub, { connectStorage: kept.connect });
    stores.push(store);
    await store.start();
    await eventually(() => hub.live.length > 0);
    hub.holdPartial = true;
    store.openTeam(id(3));
    await eventually(() => hub.partialRequests.length === 1);
    /** Every packet sent so far is applied, and stored. */
    const settled = async () => {
      const sent = hub.last.sent;
      await until(() => (store.position?.lastSyncId ?? 0) >= sent);
      await eventually(async () => (await kept.lastSyncId()) >= sent);
    };
    return { hub, store, kept, settled };
  }

  it('keeps a part of a live task that arrives before the answer whose snapshot predates it', async () => {
    const { hub, store, kept, settled } = await loading();
    hub.putPart(501, 133);
    await settled();
    hub.releasePartial();
    await until(() => store.teamLoadState(id(3)) === 'ready');
    expect(teamView(store).parts).toEqual({ [id(501)]: id(133) });
    await settled();
    await eventually(async () => (await kept.stored('TaskPart')).length === 1);
    expect(await kept.stored('TaskPart')).toEqual([id(501)]);
  });

  it('keeps that part through the removal of another team before the answer', async () => {
    const { hub, store, kept, settled } = await loading();
    hub.putPart(501, 133);
    await settled();
    // Leaving squad 5 prunes the pool on its `unsubscribed` ack, while squad 3 still loads.
    hub.leave(USER_ID, 5);
    await until(() => !store.followedTeams.has(id(5)));
    await settled();
    expect(teamView(store).parts).toEqual({ [id(501)]: id(133) });
    hub.releasePartial();
    await until(() => store.teamLoadState(id(3)) === 'ready');
    expect(teamView(store).parts).toEqual({ [id(501)]: id(133) });
    await settled();
    expect(await kept.stored('TaskPart')).toEqual([id(501)]);
  });

  it('sweeps a part of an archived task that arrived while the team loaded, from pool and storage', async () => {
    const { hub, store, kept, settled } = await loading();
    // Like `attachment.setPreview` on an archived issue: logged under the team, never live here.
    hub.putPart(502, 135);
    await settled();
    hub.releasePartial();
    await until(() => store.teamLoadState(id(3)) === 'ready');
    expect(teamView(store).parts).toEqual({});
    await eventually(async () => (await kept.stored('TaskPart')).length === 0);
    // A part arriving once the team is loaded is dropped at once (D30).
    hub.putPart(503, 135);
    await settled();
    expect(teamView(store).parts).toEqual({});
    expect(await kept.stored('TaskPart')).toEqual([]);
  });
});
