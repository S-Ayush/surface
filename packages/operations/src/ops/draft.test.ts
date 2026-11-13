// PLAN-012 S5 (SPEC-012 §4.3, AC-3, E13, E19): the `draft.save` and `draft.discard` inputs and
// their optimistic updates. The store is a fake with `find`, holding rows that parse with the
// client model, so a row the update writes is one the client keeps. The server's handlers make the
// same choices (`apps/server/test/draft-handlers.test.ts`).
import { Draft, EMPTY_COMPOSER_DRAFT } from '@surface/domain/model';
import { describe, expect, it } from 'vitest';
import type { OptimisticStore, StoreRow } from '../optimistic.js';
import { draftsOverLimit, draftDiscard, draftKeyProblem, draftSave } from './draft.js';

const ME = '0192f0c1-7e5a-7b3c-9d4e-000000000001';
const OTHER = '0192f0c1-7e5a-7b3c-9d4e-000000000002';
const ENG = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
const DES = '0192f0c1-7e5a-7b3c-9d4e-0000000000e2';
const ISSUE = '0192f0c1-7e5a-7b3c-9d4e-0000000000a1';
const NEW_ID = '0192f0c1-7e5a-7b3c-9d4e-0000000000d1';
const NOW = new Date('2026-11-13T10:00:00.000Z');

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

function fakeStore(initial: readonly StoreRow[] = []) {
  const rows = new Map<string, StoreRow>();
  for (const row of initial) rows.set(String(row['id']), Draft.rowSchema.parse(row));
  const store: OptimisticStore = {
    now: NOW,
    get: (model, ref) => {
      if (model === 'User') return ref === 'me' ? { id: ME } : undefined;
      return model === 'Draft' ? rows.get(ref) : undefined;
    },
    find: (model, fields) =>
      model !== 'Draft'
        ? []
        : [...rows.values()]
            .filter((row) => Object.entries(fields).every(([k, v]) => row[k] === v))
            .sort((a, b) => String(a['id']).localeCompare(String(b['id']))),
    patch: (model, ref, changes) => {
      const row = rows.get(ref);
      if (model === 'Draft' && row !== undefined) {
        rows.set(ref, Draft.rowSchema.parse({ ...row, ...changes }));
      }
    },
    insert: (model, row) => {
      if (model === 'Draft') rows.set(row.id, Draft.rowSchema.parse(row));
    },
    remove: (model, ref) => {
      if (model === 'Draft') rows.delete(ref);
    },
    archive: () => undefined,
    unarchive: () => undefined,
  };
  return { store, rows };
}

const draft = (extra: Partial<Record<string, unknown>>): StoreRow => ({
  id: NEW_ID,
  userId: ME,
  kind: 'composer',
  teamId: ENG,
  issueId: null,
  data: EMPTY_COMPOSER_DRAFT,
  createdAt: '2026-11-01T09:00:00.000Z',
  updatedAt: '2026-11-01T09:00:00.000Z',
  ...extra,
});

const save = (store: OptimisticStore, input: unknown) =>
  draftSave.optimistic?.(store, draftSave.input.parse(input));
const discard = (store: OptimisticStore, input: unknown) =>
  draftDiscard.optimistic?.(store, draftDiscard.input.parse(input));

const composerData = { ...EMPTY_COMPOSER_DRAFT, title: 'Fix the login loop', priority: 2 };

describe('the draft.save input', () => {
  it('needs the key its kind names, and only that one', () => {
    expect(draftKeyProblem({ kind: 'composer' })?.path).toBe('teamId');
    expect(draftKeyProblem({ kind: 'composer', teamId: ENG, issueId: ISSUE })?.path).toBe(
      'issueId',
    );
    expect(draftKeyProblem({ kind: 'comment' })?.path).toBe('issueId');
    expect(draftKeyProblem({ kind: 'comment', issueId: ISSUE, teamId: ENG })?.path).toBe('teamId');
    expect(draftKeyProblem({ kind: 'comment', issueId: ISSUE })).toBeUndefined();
  });

  it('refuses data of the other kind, with the path', () => {
    const wrong = draftSave.input.safeParse({
      kind: 'comment',
      issueId: ISSUE,
      data: composerData,
    });
    expect(wrong.success).toBe(false);
    expect(wrong.error?.issues.map((i) => i.path.join('.'))).toEqual(['data']);
    const other = draftSave.input.safeParse({
      kind: 'composer',
      teamId: ENG,
      data: { text: doc('x') },
    });
    expect(other.error?.issues.map((i) => i.path.join('.'))).toEqual(['data']);
  });

  it('bounds the description by SPEC-011 Q9 (200 KB) and a comment by SPEC-013 D14 (50 KB)', () => {
    const big = (bytes: number) => doc('x'.repeat(bytes));
    const description = (d: unknown) =>
      draftSave.input.safeParse({
        kind: 'composer',
        teamId: ENG,
        data: { ...composerData, description: d },
      }).success;
    expect(description(big(200 * 1024 - 100))).toBe(true);
    expect(description(big(200 * 1024))).toBe(false);
    const comment = (d: unknown) =>
      draftSave.input.safeParse({ kind: 'comment', issueId: ISSUE, data: { text: d } }).success;
    expect(comment(big(50 * 1024 - 100))).toBe(true);
    expect(comment(big(50 * 1024))).toBe(false);
    expect(comment({ type: 'paragraph' })).toBe(false);
  });
});

describe('draft.save optimistic (AC-3)', () => {
  it('inserts a new draft with the input id, owned by the signed-in user', () => {
    const { store, rows } = fakeStore();
    save(store, { id: NEW_ID, kind: 'composer', teamId: ENG, data: composerData });
    expect(rows.get(NEW_ID)).toMatchObject({
      userId: ME,
      kind: 'composer',
      teamId: ENG,
      issueId: null,
      data: composerData,
      updatedAt: NOW.toISOString(),
    });
  });

  it('replaces the draft with the same key and keeps its id: an upsert, so a retry makes no duplicate', () => {
    const { store, rows } = fakeStore([draft({})]);
    const other = '0192f0c1-7e5a-7b3c-9d4e-0000000000d9';
    save(store, { id: other, kind: 'composer', teamId: ENG, data: composerData });
    save(store, { id: other, kind: 'composer', teamId: ENG, data: composerData });
    expect([...rows.keys()]).toEqual([NEW_ID]);
    expect(rows.get(NEW_ID)?.['data']).toEqual(composerData);
  });

  it('keeps one draft per team: another team gets its own', () => {
    const { store, rows } = fakeStore([draft({})]);
    const des = '0192f0c1-7e5a-7b3c-9d4e-0000000000d2';
    save(store, { id: des, kind: 'composer', teamId: DES, data: composerData });
    expect(rows.size).toBe(2);
    expect(rows.get(NEW_ID)?.['data']).toEqual(EMPTY_COMPOSER_DRAFT);
  });

  it('does not touch another user’s draft for the same team', () => {
    const theirs = draft({ userId: OTHER });
    const { store, rows } = fakeStore([theirs]);
    const mine = '0192f0c1-7e5a-7b3c-9d4e-0000000000d3';
    save(store, { id: mine, kind: 'composer', teamId: ENG, data: composerData });
    expect(rows.get(NEW_ID)?.['data']).toEqual(EMPTY_COMPOSER_DRAFT);
    expect(rows.get(mine)?.['userId']).toBe(ME);
  });

  it('predicts nothing without an id for a new draft (the server makes one)', () => {
    const { store, rows } = fakeStore();
    save(store, { kind: 'composer', teamId: ENG, data: composerData });
    expect(rows.size).toBe(0);
  });

  it('deletes the oldest comment draft when a 51st is saved', () => {
    const comments = Array.from({ length: 50 }, (_, n) =>
      draft({
        id: `0192f0c1-7e5a-7b3c-9d4e-${String(1000 + n).padStart(12, '0')}`,
        kind: 'comment',
        teamId: null,
        issueId: `0192f0c1-7e5a-7b3c-9d4e-${String(5000 + n).padStart(12, '0')}`,
        data: { text: doc(`c${String(n)}`) },
        // The first one is the oldest.
        updatedAt: new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString(),
      }),
    );
    const { store, rows } = fakeStore([...comments, draft({})]);
    save(store, {
      id: NEW_ID.replace('d1', 'f1'),
      kind: 'comment',
      issueId: ISSUE,
      data: { text: doc('new') },
    });
    const left = [...rows.values()].filter((r) => r['kind'] === 'comment');
    expect(left).toHaveLength(50);
    expect(rows.has(String(comments[0]?.['id']))).toBe(false);
    // Composer drafts don't count.
    expect(rows.has(NEW_ID)).toBe(true);
  });

  it('deletes the oldest composer draft when a 51st is saved; comment drafts don’t count', () => {
    const composers = Array.from({ length: 50 }, (_, n) =>
      draft({
        id: `0192f0c1-7e5a-7b3c-9d4e-${String(2000 + n).padStart(12, '0')}`,
        teamId: `0192f0c1-7e5a-7b3c-9d4e-${String(6000 + n).padStart(12, '0')}`,
        updatedAt: new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString(),
      }),
    );
    const comment = draft({
      id: '0192f0c1-7e5a-7b3c-9d4e-0000000000d5',
      kind: 'comment',
      teamId: null,
      issueId: ISSUE,
      data: { text: doc('kept') },
      updatedAt: new Date(Date.UTC(2026, 9, 1)).toISOString(),
    });
    const { store, rows } = fakeStore([...composers, comment]);
    save(store, { id: NEW_ID, kind: 'composer', teamId: ENG, data: composerData });
    expect([...rows.values()].filter((r) => r['kind'] === 'composer')).toHaveLength(50);
    expect(rows.has(String(composers[0]?.['id']))).toBe(false);
    expect(rows.has(NEW_ID)).toBe(true);
    expect(rows.has(String(comment['id']))).toBe(true);
  });
});

describe('draft.discard optimistic', () => {
  it('removes the draft with the key, and only it', () => {
    const comment = draft({
      id: '0192f0c1-7e5a-7b3c-9d4e-0000000000d4',
      kind: 'comment',
      teamId: null,
      issueId: ISSUE,
      data: { text: doc('hi') },
    });
    const { store, rows } = fakeStore([draft({}), comment]);
    discard(store, { kind: 'comment', issueId: ISSUE });
    expect([...rows.keys()]).toEqual([NEW_ID]);
  });

  it('changes nothing when there is no such draft', () => {
    const { store, rows } = fakeStore([draft({})]);
    discard(store, { kind: 'composer', teamId: DES });
    expect(rows.size).toBe(1);
  });
});

describe('draftsOverLimit', () => {
  it('orders by time, not by how the offset is written, then by id', () => {
    const rows = [
      { id: 'b', updatedAt: '2026-11-13T10:00:00.000+00:00' },
      { id: 'a', updatedAt: '2026-11-13T10:00:00.000Z' },
      { id: 'c', updatedAt: '2026-11-13T09:00:00.000Z' },
    ];
    expect(draftsOverLimit(rows, 1).map((r) => r.id)).toEqual(['a', 'c']);
  });
});
