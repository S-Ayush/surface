// SPEC-011 §5.7, AC-29, E28, E29; PLAN-011 S4c: an archived or deleted issue is never kept by
// the client. Whatever packet carries it (`I`, `U`, `A`, `V`) removes it with its children and
// content; a restore inserts it again and its re-logged children follow. Group changes (D+U)
// keep an issue the user still sees.
import { afterEach, describe, expect, it } from 'vitest';
import type { SyncStore } from '../src/store.js';
import { FakeHub } from './support/hub.js';
import { eventually, keptMemoryStorage, teamStore, teamView, until } from './support/live.js';
import { OTHER_USER, USER_ID, id } from './support/models.js';

const stores: SyncStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
});

/** Squad 1 (member) with task 110, its part 501 and note 601; squad 3 public, not a member. */
async function started() {
  const hub = new FakeHub().withTeams();
  hub.addSquad(1);
  hub.addSquad(3);
  hub.join(USER_ID, 1);
  hub.putTask(110, 1, { creatorId: OTHER_USER });
  hub.putTask(130, 3, { creatorId: OTHER_USER });
  hub.putPart(501, 110);
  hub.putTaskNote(601, 110);
  const kept = keptMemoryStorage();
  const { store } = teamStore(hub, { connectStorage: kept.connect });
  stores.push(store);
  await store.start();
  await eventually(() => hub.live.length > 0);
  await until(() => teamView(store).parts[id(501)] !== undefined);
  // Content is held only once the issue is opened (§5.3, §5.4): open it, then note 602 arrives live.
  expect(await store.content.open(id(110)).ready).toBe('ready');
  expect(teamView(store).notes).toEqual({ [id(601)]: id(110) });
  hub.putTaskNote(602, 110);
  await until(() => teamView(store).notes[id(602)] !== undefined);
  /** Every packet sent so far is applied, and stored. */
  const settled = async () => {
    const sent = hub.last.sent;
    await until(() => (store.position?.lastSyncId ?? 0) >= sent);
    await eventually(async () => (await kept.lastSyncId()) >= sent);
  };
  return { hub, store, kept, settled };
}

describe('archived and deleted issues leave the replica (AC-29)', () => {
  it.each([
    ['an archive (A)', (hub: FakeHub) => hub.archiveTask(110)],
    ['a delete (U with deletedAt)', (hub: FakeHub) => hub.deleteTask(110)],
  ])('removes the issue with its part and notes on %s, in the pool and storage', async (_, act) => {
    const { hub, store, kept, settled } = await started();
    act(hub);
    await settled();
    expect(teamView(store)).toEqual({ tasks: {}, parts: {}, notes: {} });
    expect(await kept.stored('Task')).toEqual([]);
    expect(await kept.stored('TaskPart')).toEqual([]);
    expect(await kept.stored('TaskNote')).toEqual([]);
  });

  it('removes it on a label-cascade U that carries the archived row, without bringing it back', async () => {
    const { hub, store, settled } = await started();
    hub.archiveTask(110);
    hub.putTask(110, 1, { title: 'Cascade' });
    await settled();
    expect(teamView(store).tasks).toEqual({});
  });

  it.each(['V', 'U'] as const)(
    'inserts it again on a restore %s, with its re-logged part (content comes by hydration)',
    async (as) => {
      const { hub, store, kept, settled } = await started();
      hub.deleteTask(110);
      await settled();
      hub.restoreTask(110, as);
      await settled();
      const view = teamView(store);
      expect(Object.keys(view.tasks)).toEqual([id(110)]);
      expect(view.parts).toEqual({ [id(501)]: id(110) });
      expect(view.notes).toEqual({});
      expect(await kept.stored('Task')).toEqual([id(110)]);
      expect(await kept.stored('TaskPart')).toEqual([id(501)]);
    },
  );

  it('removes it in the same batch it was inserted in, with a child the batch carried too', async () => {
    const { hub, store, settled } = await started();
    hub.last.paused = true;
    hub.putTask(111, 1, { creatorId: OTHER_USER });
    hub.putPart(502, 111);
    hub.archiveTask(111);
    hub.last.paused = false;
    hub.last.deliver();
    await settled();
    expect(Object.keys(teamView(store).tasks)).toEqual([id(110)]);
    expect(teamView(store).parts).toEqual({ [id(501)]: id(110) });
  });
});

describe('group changes', () => {
  it('keeps the issue and its children through a reassignment that changes its groups (D+U)', async () => {
    const { hub, store, settled } = await started();
    hub.putTask(110, 1, { assigneeId: USER_ID });
    await settled();
    const view = teamView(store);
    expect(view.tasks[id(110)]).toMatchObject({ groups: [`team:${id(1)}`, `user:${USER_ID}`] });
    expect(view.parts).toEqual({ [id(501)]: id(110) });
    expect(Object.keys(view.notes)).toEqual([id(601), id(602)]);
  });

  it('removes the issue with its children on a lone D (purge)', async () => {
    const { hub, store, settled } = await started();
    hub.purgeTask(110);
    await settled();
    expect(teamView(store)).toEqual({ tasks: {}, parts: {}, notes: {} });
  });

  it('gains an issue of an unfollowed team assigned to the user, as user: only (E28)', async () => {
    const { hub, store, settled } = await started();
    hub.putTask(130, 3, { assigneeId: USER_ID });
    await settled();
    expect(teamView(store).tasks[id(130)]).toEqual({
      title: 'Task 130',
      groups: [`user:${USER_ID}`],
    });
  });

  it('loses an issue of an unfollowed team reassigned away from the user (E29)', async () => {
    const { hub, store, kept, settled } = await started();
    hub.putTask(130, 3, { assigneeId: USER_ID });
    await settled();
    hub.putTask(130, 3, { assigneeId: OTHER_USER });
    await settled();
    expect(teamView(store).tasks[id(130)]).toBeUndefined();
    expect(await kept.stored('Task')).toEqual([id(110)]);
  });
});
