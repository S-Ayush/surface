// PLAN-012 S5 (SPEC-012 §4.3, AC-3): the rules of `draft.save` and `draft.discard` on memory
// fakes. Upserting twice makes one row; the 51st comment draft deletes the oldest; discarding a
// missing draft succeeds; the owner is the actor; nothing reads a team or an issue, and neither
// operation names a reference type, so the executor resolves nothing either. The SQL of the access
// and the sync groups are covered by `draft-groups.int.test.ts` (leak test, not held).
import { randomUUID } from 'node:crypto';
import { userActor, systemActor } from '@surface/domain';
import { EMPTY_COMPOSER_DRAFT } from '@surface/domain/model';
import { draftDiscard, draftSave, toJsonSchema, type DraftKey } from '@surface/operations';
import { describe, expect, it } from 'vitest';
import { SurfaceError } from '../src/executor/errors.js';
import {
  discardDraft,
  draftOwner,
  saveDraft,
  type DraftAccess,
  type DraftRepo,
  type DraftRow,
} from '../src/handlers/drafts/core.js';

const ME = randomUUID();
const OTHER = randomUUID();
const ENG = randomUUID();
const ISSUE = randomUUID();

/** The row the fake repo stores for an insert: the repo's values are typed for any model. */
function draftRowOf(values: Readonly<Record<string, unknown>>): DraftRow {
  const { id, userId, kind, teamId, issueId, data, createdAt, updatedAt } = values;
  if (
    typeof id !== 'string' ||
    typeof userId !== 'string' ||
    (kind !== 'composer' && kind !== 'comment') ||
    !(createdAt instanceof Date) ||
    !(updatedAt instanceof Date)
  ) {
    throw new Error('The fake repo was handed something that is not a draft.');
  }
  return {
    id,
    userId,
    kind,
    teamId: typeof teamId === 'string' ? teamId : null,
    issueId: typeof issueId === 'string' ? issueId : null,
    data,
    createdAt,
    updatedAt,
  };
}

/** Drafts in a map, the order `commentDraftsBeyond` uses, and every call made, in order. */
function memoryDrafts(initial: readonly DraftRow[] = []) {
  const rows = new Map(initial.map((row) => [row.id, row]));
  const calls: string[] = [];
  let clock = Date.UTC(2026, 10, 13, 10);
  const matches = (row: DraftRow, userId: string, key: DraftKey) =>
    row.userId === userId &&
    row.kind === key.kind &&
    (key.kind === 'composer' ? row.teamId === key.teamId : row.issueId === key.issueId);
  const access: DraftAccess = {
    lockOwner: (userId) => {
      calls.push(`lock:${userId === ME ? 'me' : userId}`);
      return Promise.resolve();
    },
    find: (userId, key) => {
      calls.push('find');
      return Promise.resolve([...rows.values()].find((row) => matches(row, userId, key)));
    },
    commentDraftsBeyond: (userId, keep) => {
      calls.push('beyond');
      const newestFirst = [...rows.values()]
        .filter((row) => row.userId === userId && row.kind === 'comment')
        .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || (a.id < b.id ? 1 : -1));
      return Promise.resolve(newestFirst.slice(keep).map((row) => row.id));
    },
  };
  const repo: DraftRepo = {
    insert: (model, values) => {
      calls.push(`insert:${model}`);
      const at = new Date((clock += 1000));
      const row = draftRowOf({ ...values, createdAt: at, updatedAt: at });
      rows.set(row.id, row);
      return Promise.resolve(row as never);
    },
    update: (model, id, patch) => {
      calls.push(`update:${model}`);
      const row = rows.get(id);
      if (row === undefined) throw new SurfaceError('NOT_FOUND', 'gone');
      const next = { ...row, ...patch, updatedAt: new Date((clock += 1000)) } as DraftRow;
      rows.set(id, next);
      return Promise.resolve(next as never);
    },
    purge: (model, id) => {
      calls.push(`purge:${model}`);
      rows.delete(id);
      return Promise.resolve();
    },
  };
  return { rows, calls, access, repo };
}

const composer: DraftKey = { kind: 'composer', teamId: ENG };
const data = { ...EMPTY_COMPOSER_DRAFT, title: 'Fix the login loop' };
const doc = (text: string) => ({
  type: 'doc' as const,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('draft.save', () => {
  it('upserts by key: saving twice, even with two ids, keeps one row with the latest data', async () => {
    const m = memoryDrafts();
    const first = await saveDraft(m.access, m.repo, ME, {
      key: composer,
      data,
      newId: randomUUID(),
    });
    const again = { ...data, title: 'Fix the login redirect loop' };
    const second = await saveDraft(m.access, m.repo, ME, {
      key: composer,
      data: again,
      newId: randomUUID(),
    });
    expect(second.id).toBe(first.id);
    expect([...m.rows.values()]).toHaveLength(1);
    expect(m.rows.get(first.id)).toMatchObject({
      userId: ME,
      teamId: ENG,
      issueId: null,
      data: again,
    });
    expect(m.calls).toEqual(['lock:me', 'find', 'insert:Draft', 'lock:me', 'find', 'update:Draft']);
  });

  it('stores a comment draft under its issue, with no team', async () => {
    const m = memoryDrafts();
    const row = await saveDraft(m.access, m.repo, ME, {
      key: { kind: 'comment', issueId: ISSUE },
      data: { text: doc('Looks good') },
      newId: randomUUID(),
    });
    expect(row).toMatchObject({ kind: 'comment', issueId: ISSUE, teamId: null });
  });

  it('keeps 50 comment drafts: the 51st deletes the oldest, composer drafts never count', async () => {
    const m = memoryDrafts();
    await saveDraft(m.access, m.repo, ME, { key: composer, data, newId: randomUUID() });
    const ids: string[] = [];
    for (let n = 0; n < 50; n += 1) {
      const row = await saveDraft(m.access, m.repo, ME, {
        key: { kind: 'comment', issueId: randomUUID() },
        data: { text: doc(String(n)) },
        newId: randomUUID(),
      });
      ids.push(row.id);
    }
    expect([...m.rows.values()].filter((r) => r.kind === 'comment')).toHaveLength(50);
    await saveDraft(m.access, m.repo, ME, {
      key: { kind: 'comment', issueId: ISSUE },
      data: { text: doc('51st') },
      newId: randomUUID(),
    });
    const comments = [...m.rows.values()].filter((r) => r.kind === 'comment');
    expect(comments).toHaveLength(50);
    expect(m.rows.has(ids[0] ?? '')).toBe(false);
    expect(m.rows.has(ids[1] ?? '')).toBe(true);
    expect([...m.rows.values()].some((r) => r.kind === 'composer')).toBe(true);
  });

  it('never counts another user’s comment drafts', async () => {
    const theirs: DraftRow[] = Array.from({ length: 50 }, (_, n) => ({
      id: randomUUID(),
      userId: OTHER,
      kind: 'comment',
      teamId: null,
      issueId: randomUUID(),
      data: { text: doc(String(n)) },
      createdAt: new Date(0),
      updatedAt: new Date(0),
    }));
    const m = memoryDrafts(theirs);
    await saveDraft(m.access, m.repo, ME, {
      key: { kind: 'comment', issueId: ISSUE },
      data: { text: doc('mine') },
      newId: randomUUID(),
    });
    expect(m.rows.size).toBe(51);
  });
});

describe('draft.discard', () => {
  it('deletes the draft with the key', async () => {
    const m = memoryDrafts();
    await saveDraft(m.access, m.repo, ME, { key: composer, data, newId: randomUUID() });
    expect(await discardDraft(m.access, m.repo, ME, composer)).toBe(true);
    expect(m.rows.size).toBe(0);
  });

  it('succeeds for a missing draft and writes nothing', async () => {
    const m = memoryDrafts();
    expect(await discardDraft(m.access, m.repo, ME, composer)).toBe(false);
    expect(m.calls).toEqual(['lock:me', 'find']);
  });

  it('never deletes another user’s draft with the same key', async () => {
    const m = memoryDrafts();
    await saveDraft(m.access, m.repo, OTHER, { key: composer, data, newId: randomUUID() });
    expect(await discardDraft(m.access, m.repo, ME, composer)).toBe(false);
    expect(m.rows.size).toBe(1);
  });
});

describe('the owner and the references', () => {
  it('is the actor; an actor with no user (the system) is refused', () => {
    expect(draftOwner(userActor({ userId: ME, role: 'member', memberships: [] }))).toBe(ME);
    expect(() => draftOwner(systemActor())).toThrow(SurfaceError);
  });

  it('takes no reference types, so the executor resolves no team or issue (permissions.md §2)', () => {
    for (const op of [draftSave, draftDiscard]) {
      expect(JSON.stringify(toJsonSchema(op.input, 'input'))).not.toContain('x-surface-ref');
    }
  });

  it('reads no team or issue: the access offers no such read, and saving calls only its own', async () => {
    const m = memoryDrafts();
    await saveDraft(m.access, m.repo, ME, {
      key: { kind: 'comment', issueId: ISSUE },
      data: { text: doc('x') },
      newId: randomUUID(),
    });
    expect(m.calls).toEqual(['lock:me', 'find', 'insert:Draft', 'beyond']);
  });
});
