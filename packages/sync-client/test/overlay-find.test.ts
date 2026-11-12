/**
 * `store.find(model, fields)` inside `optimistic()` (PLAN-001 S8 handoff): rows named by their
 * fields rather than an id or a reference, e.g. a membership by team and user. Like references,
 * it sees base plus the mutations before this one (and this one's own writes), never rows a
 * pending mutation removed, and a delta to any row of the model it searched rebuilds the overlay.
 */
import { defineModel, uuid } from '@surface/domain/model';
import { defineOperation, type StoreRow } from '@surface/operations';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { OverlayMutation } from '../src/overlay.js';
import { OverlayEngine } from '../src/overlay.js';
import { ObjectPool } from '../src/pool.js';
import { id } from './support/models.js';

const Member = defineModel('Member', {
  load: 'eager',
  fields: { teamId: uuid(), userId: uuid() },
});

const fixture = {
  domain: 'team' as const,
  permission: () => true,
  destructive: false,
  internal: true,
  output: z.object({}),
  kind: 'mutation' as const,
};

const TEAM = id(100);
const OTHER_TEAM = id(101);
const ME = id(200);
const IRIS = id(201);

/** What each run of `optimistic()` found, for the assertions. */
let seen: (readonly StoreRow[])[] = [];

const leave = defineOperation({
  ...fixture,
  name: 'team.leaveFixture',
  summary: 'Leave a team (fixture)',
  description: 'Removes the memberships of a user in a team, found by fields. For overlay tests.',
  keywords: ['leave team', 'membership by fields'],
  input: z.object({ teamId: z.uuid(), userId: z.uuid() }),
  examples: [{ teamId: TEAM, userId: ME }],
  optimistic(store, input) {
    const found = store.find('Member', { teamId: input.teamId, userId: input.userId });
    seen.push(found);
    for (const row of found) {
      const rowId = row['id'];
      if (typeof rowId === 'string') store.remove('Member', rowId);
    }
  },
});

const join = defineOperation({
  ...fixture,
  name: 'team.joinFixture',
  summary: 'Join a team (fixture)',
  description: 'Inserts a membership, then finds it in the same mutation. For overlay tests.',
  keywords: ['join team', 'membership insert'],
  input: z.object({ id: z.uuid(), teamId: z.uuid(), userId: z.uuid() }),
  examples: [{ id: id(300), teamId: TEAM, userId: ME }],
  optimistic(store, input) {
    store.insert('Member', { ...input, groups: ['workspace'] });
    seen.push(store.find('Member', { teamId: input.teamId, userId: input.userId }));
  },
});

const unknownModel = defineOperation({
  ...fixture,
  name: 'team.findNothing',
  summary: 'Find in a model the client lacks (fixture)',
  description: 'Searches a model the pool does not hold. For overlay tests.',
  keywords: ['unknown model', 'find nothing'],
  input: z.object({}),
  examples: [{}],
  optimistic(store) {
    seen.push(store.find('Nope', {}));
  },
});

const now = new Date('2026-11-12T10:00:00.000Z');
const mutation = (key: string, op: OverlayMutation['op'], input: unknown): OverlayMutation => ({
  key,
  op,
  input,
  now,
});

function setup() {
  seen = [];
  const pool = new ObjectPool([Member]);
  pool.loadBase('Member', [
    { row: { id: id(1), teamId: TEAM, userId: ME, groups: ['workspace'] }, archived: false },
    { row: { id: id(2), teamId: TEAM, userId: IRIS, groups: ['workspace'] }, archived: false },
    { row: { id: id(3), teamId: OTHER_TEAM, userId: ME, groups: ['workspace'] }, archived: false },
  ]);
  return { pool, engine: new OverlayEngine(pool, () => ME) };
}

const ids = (rows: readonly StoreRow[] | undefined) => (rows ?? []).map((row) => row['id']);

describe('store.find in optimistic()', () => {
  it('finds base rows by every given field, and the removal shows', () => {
    const { pool, engine } = setup();
    engine.push(mutation('c:1', leave, { teamId: TEAM, userId: ME }));
    expect(ids(seen[0])).toEqual([id(1)]);
    expect(pool.get(Member, id(1))).toBeUndefined();
    expect(pool.get(Member, id(2))).toBeDefined();
    expect(pool.get(Member, id(3))).toBeDefined();
  });

  it('sees rows earlier mutations inserted, and not rows they removed', () => {
    const { engine } = setup();
    engine.rebuild([
      mutation('c:1', leave, { teamId: TEAM, userId: ME }),
      mutation('c:2', leave, { teamId: TEAM, userId: ME }),
      mutation('c:3', join, { id: id(9), teamId: TEAM, userId: ME }),
      mutation('c:4', leave, { teamId: TEAM, userId: ME }),
    ]);
    expect(seen.map(ids)).toEqual([[id(1)], [], [id(9)], [id(9)]]);
  });

  it('is the same on a rebuild, and finds nothing in a model the client does not hold', () => {
    const { engine } = setup();
    const list = [
      mutation('c:1', join, { id: id(9), teamId: OTHER_TEAM, userId: IRIS }),
      mutation('c:2', unknownModel, {}),
    ];
    engine.rebuild(list);
    const first = seen;
    seen = [];
    engine.rebuild(list);
    expect(seen).toEqual(first);
    expect(seen[1]).toEqual([]);
  });

  it('returns rows ordered by id across base, earlier mutations and its own writes (AC-7)', () => {
    seen = [];
    const pool = new ObjectPool([Member]);
    // Base rows loaded out of id order, so iteration order is not id order.
    pool.loadBase('Member', [
      { row: { id: id(40), teamId: TEAM, userId: ME, groups: ['workspace'] }, archived: false },
      { row: { id: id(10), teamId: TEAM, userId: IRIS, groups: ['workspace'] }, archived: false },
      { row: { id: id(30), teamId: TEAM, userId: ME, groups: ['workspace'] }, archived: true },
    ]);
    const engine = new OverlayEngine(pool, () => ME);
    const all = defineOperation({
      ...fixture,
      name: 'team.joinAndListFixture',
      summary: 'Join a team and list its members (fixture)',
      description:
        'Inserts a membership, then finds every membership of the team. For overlay tests.',
      keywords: ['list members', 'ordered find'],
      input: z.object({ id: z.uuid(), teamId: z.uuid(), userId: z.uuid() }),
      examples: [{ id: id(300), teamId: TEAM, userId: ME }],
      optimistic(store, input) {
        store.insert('Member', { ...input, groups: ['workspace'] });
        seen.push(store.find('Member', { teamId: input.teamId }));
      },
    });
    const list = [
      mutation('c:1', join, { id: id(50), teamId: TEAM, userId: IRIS }),
      mutation('c:2', join, { id: id(5), teamId: TEAM, userId: IRIS }),
      mutation('c:3', all, { id: id(20), teamId: TEAM, userId: IRIS }),
    ];
    engine.rebuild(list);
    const ordered = [id(5), id(10), id(20), id(30), id(40), id(50)];
    expect(ids(seen[2])).toEqual(ordered);
    const first = seen;
    seen = [];
    engine.rebuild(list);
    expect(ids(seen[2])).toEqual(ordered);
    expect(seen).toEqual(first);
  });

  it('makes a change to any row of the searched model rebuild the overlay', () => {
    const { engine } = setup();
    engine.rebuild([mutation('c:1', leave, { teamId: TEAM, userId: IRIS })]);
    // A delta adding another membership could change what it finds.
    expect(engine.dependsOn('Member', id(50))).toBe(true);
  });
});
