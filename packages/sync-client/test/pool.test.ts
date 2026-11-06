import { autorun, reaction } from 'mobx';
import { describe, expect, it } from 'vitest';
import { rowOf, trackedFieldCount } from '../src/instance.js';
import { ObjectPool } from '../src/pool.js';
import { Board, Card, DebugItem, TEST_MODELS, debugRow, id } from './support/models.js';

const pool = () => new ObjectPool(TEST_MODELS);
const upsert = (row: ReturnType<typeof debugRow>) => ({
  kind: 'upsert' as const,
  model: 'DebugItem',
  row,
});

/** Count how often a reaction re-runs after its first run. */
function runsOf(view: () => unknown): { readonly count: number; dispose(): void } {
  let count = -1;
  const dispose = autorun(() => {
    view();
    count += 1;
  });
  return {
    get count() {
      return count;
    },
    dispose,
  };
}

describe('object pool', () => {
  it('shows base rows as instances with typed field getters', () => {
    const p = pool();
    p.applyBase([upsert(debugRow(1))]);
    const item = p.get('DebugItem', id(1));
    expect(item).toMatchObject({ id: id(1), title: 'Item 1', counter: 1, $model: 'DebugItem' });
    expect(item?.$archived).toBe(false);
    expect(p.count('DebugItem')).toBe(1);
  });

  it('keeps instance identity across updates, so React keys and memo stay stable', () => {
    const p = pool();
    p.applyBase([upsert(debugRow(1))]);
    const before = p.get('DebugItem', id(1));
    p.applyBase([upsert(debugRow(1, { title: 'Renamed' }))]);
    expect(p.get('DebugItem', id(1))).toBe(before);
    expect(before?.title).toBe('Renamed');
  });

  it('cannot be written except through the pool', () => {
    const p = pool();
    p.applyBase([upsert(debugRow(1))]);
    const item = p.get('DebugItem', id(1));
    expect(() => {
      Object.assign(item ?? {}, { title: 'Hacked' });
    }).toThrow(TypeError);
    expect(item?.title).toBe('Item 1');
  });

  it('re-runs a reaction only for the fields it read', () => {
    const p = pool();
    p.applyBase([upsert(debugRow(1))]);
    const item = p.get('DebugItem', id(1));
    const titleRuns = runsOf(() => item?.title);
    const counterRuns = runsOf(() => item?.counter);

    p.applyBase([upsert(debugRow(1, { title: 'Renamed' }))]);
    expect(titleRuns.count).toBe(1);
    expect(counterRuns.count).toBe(0);

    // A full-row update with the same values notifies nobody.
    p.applyBase([upsert(debugRow(1, { title: 'Renamed' }))]);
    expect(titleRuns.count).toBe(1);

    // Arrays compare by content, not identity.
    p.applyBase([upsert(debugRow(1, { title: 'Renamed', groups: ['workspace'] }))]);
    const groupRuns = runsOf(() => item?.groups);
    p.applyBase([upsert(debugRow(1, { title: 'Renamed', groups: ['workspace'] }))]);
    expect(groupRuns.count).toBe(0);
    titleRuns.dispose();
    counterRuns.dispose();
    groupRuns.dispose();
  });

  it('applies a batch as one transaction', () => {
    const p = pool();
    const runs = runsOf(() => p.all('DebugItem').map((item) => item.title));
    p.applyBase([upsert(debugRow(1)), upsert(debugRow(2)), upsert(debugRow(3))]);
    expect(runs.count).toBe(1);
    expect(p.count('DebugItem')).toBe(3);
    runs.dispose();
  });

  it('archives, unarchives and deletes base rows', () => {
    const p = pool();
    p.applyBase([upsert(debugRow(1))]);
    const item = p.get('DebugItem', id(1));
    const archivedRuns = runsOf(() => item?.$archived);

    p.applyBase([{ kind: 'archive', model: 'DebugItem', id: id(1) }]);
    expect(item?.$archived).toBe(true);
    // An update to an archived row keeps it archived.
    p.applyBase([upsert(debugRow(1, { counter: 9 }))]);
    expect(item?.$archived).toBe(true);
    p.applyBase([{ kind: 'unarchive', model: 'DebugItem', id: id(1) }]);
    expect(item?.$archived).toBe(false);
    expect(archivedRuns.count).toBe(2);

    p.applyBase([{ kind: 'delete', model: 'DebugItem', id: id(1) }]);
    expect(p.get('DebugItem', id(1))).toBeUndefined();
    expect(p.count('DebugItem')).toBe(0);
    archivedRuns.dispose();
  });

  it('ignores archive and delete for rows it does not hold', () => {
    const p = pool();
    p.applyBase([
      { kind: 'archive', model: 'DebugItem', id: id(9) },
      { kind: 'delete', model: 'DebugItem', id: id(9) },
    ]);
    expect(p.count('DebugItem')).toBe(0);
  });

  it('tells a reaction when a row it waits for appears or disappears', () => {
    const p = pool();
    const seen: (string | undefined)[] = [];
    const dispose = autorun(() => {
      seen.push(p.get(DebugItem, id(1))?.title);
    });
    p.applyBase([upsert(debugRow(1))]);
    p.applyBase([{ kind: 'delete', model: 'DebugItem', id: id(1) }]);
    expect(seen).toEqual([undefined, 'Item 1', undefined]);
    dispose();
  });

  it('rejects unknown models', () => {
    expect(() => pool().get('Nope', id(1))).toThrow('Unknown model Nope');
  });
});

describe('overlay', () => {
  it('shows the overlay over base, and base again once it is cleared', () => {
    const p = pool();
    p.applyBase([upsert(debugRow(1))]);
    const item = p.get('DebugItem', id(1));
    p.setOverlay('DebugItem', id(1), {
      row: debugRow(1, { title: 'Optimistic' }),
      archived: false,
    });
    expect(item?.title).toBe('Optimistic');
    expect(p.baseOf('DebugItem', id(1))?.row.title).toBe('Item 1');

    // Base keeps moving underneath an overlay without showing through.
    p.applyBase([upsert(debugRow(1, { title: 'Server' }))]);
    expect(item?.title).toBe('Optimistic');

    p.setOverlay('DebugItem', id(1), undefined);
    expect(item?.title).toBe('Server');
  });

  it('hides a row deleted optimistically, and shows a row inserted optimistically', () => {
    const p = pool();
    p.applyBase([upsert(debugRow(1))]);
    p.setOverlay('DebugItem', id(1), null);
    expect(p.get('DebugItem', id(1))).toBeUndefined();
    p.setOverlay('DebugItem', id(2), { row: debugRow(2), archived: false });
    expect(p.all('DebugItem').map((item) => item.id)).toEqual([id(2)]);
    p.setOverlay('DebugItem', id(1), undefined);
    p.setOverlay('DebugItem', id(2), undefined);
    expect(p.all('DebugItem').map((item) => item.id)).toEqual([id(1)]);
  });
});

describe('secondary indexes', () => {
  const card = (n: number, fields: Record<string, unknown> = {}) => ({
    kind: 'upsert' as const,
    model: 'Card',
    row: { id: id(n), boardId: id(100), title: `Card ${n}`, rank: n, assignee: null, ...fields },
  });
  const ids = (instances: { id: string }[]) => instances.map((i) => i.id).sort();

  it('finds rows by an indexed value, including null', () => {
    const p = pool();
    p.applyBase([card(1, { assignee: 'ada' }), card(2), card(3, { assignee: 'ada' })]);
    expect(ids(p.findBy('Card', 'assignee', 'ada'))).toEqual([id(1), id(3)]);
    expect(ids(p.findBy('Card', 'assignee', null))).toEqual([id(2)]);
    expect(p.findBy('Card', 'assignee', 'bob')).toEqual([]);
  });

  it('moves a row between buckets when the field changes, in base or overlay', () => {
    const p = pool();
    p.applyBase([card(1, { assignee: 'ada' })]);
    p.applyBase([card(1, { assignee: 'bob' })]);
    expect(p.findBy('Card', 'assignee', 'ada')).toEqual([]);
    expect(ids(p.findBy('Card', 'assignee', 'bob'))).toEqual([id(1)]);

    p.setOverlay('Card', id(1), { row: { ...card(1).row, assignee: 'cy' }, archived: false });
    expect(p.findBy('Card', 'assignee', 'bob')).toEqual([]);
    expect(ids(p.findBy('Card', 'assignee', 'cy'))).toEqual([id(1)]);

    p.setOverlay('Card', id(1), undefined);
    expect(ids(p.findBy('Card', 'assignee', 'bob'))).toEqual([id(1)]);
  });

  it('re-runs a lookup only when its own bucket changes', () => {
    const p = pool();
    p.applyBase([card(1, { assignee: 'ada' }), card(2, { assignee: 'bob' })]);
    const adaRuns = runsOf(() => p.findBy('Card', 'assignee', 'ada'));
    p.applyBase([card(2, { assignee: 'cy' })]);
    p.applyBase([card(2, { title: 'Renamed' })]);
    expect(adaRuns.count).toBe(0);
    p.applyBase([card(4, { assignee: 'ada' })]);
    expect(adaRuns.count).toBe(1);
    adaRuns.dispose();
  });

  it('drops removed rows from every index', () => {
    const p = pool();
    p.applyBase([card(1, { assignee: 'ada' })]);
    p.applyBase([{ kind: 'delete', model: 'Card', id: id(1) }]);
    expect(p.findBy('Card', 'assignee', 'ada')).toEqual([]);
    expect(p.findBy('Card', 'boardId', id(100))).toEqual([]);
  });

  it('refuses a lookup on a field without an index', () => {
    expect(() => pool().findBy('Card', 'title', 'x')).toThrow(/has no index/);
  });

  it('follows refs and back-refs, which index the target field automatically', () => {
    const p = pool();
    p.applyBase([
      { kind: 'upsert', model: 'Board', row: { id: id(100), name: 'Roadmap' } },
      card(1),
      card(2),
    ]);
    const first = p.get('Card', id(1));
    const board = p.get('Board', id(100));
    expect(first && p.ref(first, 'board')).toBe(board);
    expect(board && ids(p.backRef(board, 'cards'))).toEqual([id(1), id(2)]);
    expect(() => first && p.backRef(first, 'board')).toThrow(/is not a backRef/);
  });

  it('rejects refs to models that are not registered', () => {
    expect(() => new ObjectPool([Card])).toThrow(/refers to unknown model Board/);
    expect(() => new ObjectPool([DebugItem, Board, Card, DebugItem])).toThrow(/registered twice/);
  });

  it('keeps reactions consistent across a batch that moves many rows', () => {
    const p = pool();
    p.applyBase([card(1, { assignee: 'ada' }), card(2, { assignee: 'ada' })]);
    const sizes: number[] = [];
    const dispose = reaction(
      () => p.findBy('Card', 'assignee', 'ada').length + p.findBy('Card', 'assignee', 'bob').length,
      (total) => sizes.push(total),
    );
    p.applyBase([card(1, { assignee: 'bob' }), card(2, { assignee: 'bob' })]);
    // Both rows moved in one batch: the total never dips while rows are between buckets.
    expect(sizes).toEqual([]);
    dispose();
  });
});

describe('model registry', () => {
  it('exposes the registered definitions', () => {
    expect(pool().models.map((m) => m.name)).toEqual(['DebugItem', 'Board', 'Card']);
    expect(pool().model('Card')).toBe(Card);
    expect(pool().model('Board')).toBe(Board);
  });
});

describe('tracked and untracked reads of the same row (review #1, #2)', () => {
  it('keeps a reaction waiting on a row live after an untracked read of it', () => {
    const p = pool();
    const seen: (string | undefined)[] = [];
    const dispose = autorun(() => {
      seen.push(p.get(DebugItem, id(1))?.title);
    });
    p.get(DebugItem, id(1)); // e.g. an event handler
    p.applyBase([upsert(debugRow(1))]);
    p.get(DebugItem, id(1));
    p.applyBase([{ kind: 'delete', model: 'DebugItem', id: id(1) }]);
    expect(seen).toEqual([undefined, 'Item 1', undefined]);
    dispose();
  });

  it('keeps a reactive index lookup live after an untracked lookup of the same value', () => {
    const p = pool();
    const sizes: number[] = [];
    const dispose = autorun(() => {
      sizes.push(p.findBy(DebugItem, 'title', 'A').length);
    });
    p.findBy(DebugItem, 'title', 'A');
    p.applyBase([upsert(debugRow(1, { title: 'A' }))]);
    expect(sizes).toEqual([0, 1]);
    dispose();
  });

  it('never loses a loaded row when a reaction stops watching it', () => {
    const p = pool();
    const dispose = autorun(() => {
      p.get(DebugItem, id(1));
      p.findBy(DebugItem, 'title', 'A');
    });
    p.get(DebugItem, id(1));
    p.findBy(DebugItem, 'title', 'A');
    p.applyBase([upsert(debugRow(1, { title: 'A' }))]);
    dispose();
    expect(p.count(DebugItem)).toBe(1);
    expect(p.get(DebugItem, id(1))?.title).toBe('A');
    expect(p.findBy(DebugItem, 'title', 'A').map((item) => item.id)).toEqual([id(1)]);
  });

  it('allocates no field trackers for reads outside a reaction', () => {
    const p = pool();
    p.applyBase([upsert(debugRow(1))]);
    const item = p.get(DebugItem, id(1));
    if (!item) throw new Error('missing');
    void item.title;
    void item.counter;
    void item.$archived;
    expect(trackedFieldCount(item)).toBe(0);
    const dispose = autorun(() => item.title);
    void item.title;
    expect(trackedFieldCount(item)).toBe(1);
    dispose();
    expect(trackedFieldCount(item)).toBe(0);
  });
});

describe('immutability (ADR-0015)', () => {
  it('freezes rows deeply as they enter base or overlay, so nothing can edit them in place', () => {
    const p = pool();
    const base = debugRow(1, { groups: ['a'] });
    const overlay = debugRow(2, { groups: ['b'] });
    p.applyBase([upsert(base)]);
    p.loadBase('DebugItem', [{ row: debugRow(3, { groups: ['c'] }), archived: false }]);
    p.setOverlay('DebugItem', id(2), { row: overlay, archived: false });
    for (const n of [1, 2, 3]) {
      const row = rowOf(p.get(DebugItem, id(n)) ?? expect.fail(`row ${n}`));
      expect(Object.isFrozen(row), `row ${n}`).toBe(true);
      expect(Object.isFrozen(row.groups), `row ${n} groups`).toBe(true);
    }
    expect(() => (base.groups as string[]).push('x')).toThrow(TypeError);
  });

  it('refuses writes to instances: fields have no setters and nothing can be added', () => {
    const p = pool();
    p.applyBase([upsert(debugRow(1))]);
    const item: object = p.get(DebugItem, id(1)) ?? expect.fail('missing');
    expect(() => Reflect.set(item, 'title', 'Changed') || expect.fail('set')).toThrow();
    expect(Reflect.defineProperty(item, 'extra', { value: 1 })).toBe(false);
    expect(Object.isFrozen(item)).toBe(true);
  });
});
