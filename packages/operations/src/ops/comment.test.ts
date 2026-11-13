// PLAN-013 S3, SPEC-013 §6.2: AC-11 (optimistic part: the rows each comment mutation predicts, no
// prediction for a Markdown body or where the server would refuse), E22 (queued edits chain the
// version), AC-13 (registry lint; the examples run against the seed in the server's
// registry-contract test). Every row is parsed with the shared client model, as the client store
// does. That the predictions equal what the handlers commit is checked in
// apps/server/test/comment-ops.test.ts ("optimistic equals the server").
import { EMPTY_DOC, isUuid } from '@surface/domain';
import { PRODUCTION_MODELS } from '@surface/domain/model';
import { describe, expect, it } from 'vitest';
import { lintOperations } from '../lint.js';
import type { OptimisticStore, StoreRow } from '../optimistic.js';
import {
  commentCreate,
  commentDelete,
  commentList,
  commentReopen,
  commentResolve,
  commentUpdate,
} from './comment.js';

const TEAM = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';
const ME = '0192f0c1-7e5a-7b3c-9d4e-0000000000c1';
const IRIS = '0192f0c1-7e5a-7b3c-9d4e-0000000000c2';
const ISSUE = '0192f0c1-7e5a-7b3c-9d4e-0000000000b1';
const ROOT = '0192f0c1-7e5a-7b3c-9d4e-000000000101';
const REPLY = '0192f0c1-7e5a-7b3c-9d4e-000000000102';
const NEW_ID = '0192f0c1-7e5a-7b3c-9d4e-0000000000f1';
const NOW = new Date('2026-11-13T10:00:00.000Z');
const AT = NOW.toISOString();
const EARLIER = '2026-11-12T10:00:00.000Z';

const MODELS = new Map<string, (typeof PRODUCTION_MODELS)[number]>(
  PRODUCTION_MODELS.map((m) => [m.name, m]),
);

type Store = OptimisticStore & { rows: Map<string, Map<string, StoreRow>> };

function fakeStore(): Store {
  const rows = new Map<string, Map<string, StoreRow>>();
  const table = (model: string) => {
    let t = rows.get(model);
    if (!t) rows.set(model, (t = new Map<string, StoreRow>()));
    return t;
  };
  const get = (model: string, ref: string): StoreRow | undefined => {
    if (model === 'User' && ref === 'me') return table(model).get(ME);
    return isUuid(ref) ? table(model).get(ref) : undefined;
  };
  const put = (model: string, row: StoreRow) => {
    const def = MODELS.get(model);
    if (!def) throw new Error(`unknown model ${model}`);
    const parsed: StoreRow = def.rowSchema.parse(row);
    const id = parsed['id'];
    if (typeof id !== 'string') throw new Error('row without id');
    table(model).set(id, parsed);
  };
  return {
    rows,
    now: NOW,
    get,
    insert: put,
    patch: (model, ref, changes) => {
      const row = get(model, ref);
      if (row) put(model, { ...row, ...changes });
    },
    find: (model, fields) =>
      [...table(model).values()]
        .filter((row) => Object.entries(fields).every(([field, value]) => row[field] === value))
        .sort((a, b) => String(a['id']).localeCompare(String(b['id']))),
    archive: () => undefined,
    unarchive: () => undefined,
    remove: (model, ref) => {
      const id = get(model, ref)?.['id'];
      if (typeof id === 'string') table(model).delete(id);
    },
  };
}

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

function comment(
  fields: Partial<Record<string, unknown>> & { id: string },
): StoreRow & { readonly id: string } {
  return {
    issueId: ISSUE,
    teamId: TEAM,
    parentCommentId: null,
    userId: ME,
    actorKind: 'user',
    body: doc('Hello'),
    version: 1,
    editedAt: null,
    deletedAt: null,
    resolvedAt: null,
    resolvedById: null,
    createdAt: EARLIER,
    updatedAt: EARLIER,
    ...fields,
  };
}

/** A store with me, Iris, a live issue and a thread (root by me, reply by Iris). */
function seeded(issue: Partial<Record<string, unknown>> = {}): Store {
  const store = fakeStore();
  for (const [id, name] of [
    [ME, 'Ada'],
    [IRIS, 'Iris'],
  ] as const) {
    store.insert('User', {
      id,
      email: `${name.toLowerCase()}@example.com`,
      name,
      displayName: name.toLowerCase(),
      avatarFileId: null,
      timezone: 'UTC',
      role: 'member',
      active: true,
      createdAt: EARLIER,
      updatedAt: EARLIER,
    });
  }
  store.rows.set(
    'Issue',
    new Map([[ISSUE, { id: ISSUE, teamId: TEAM, archivedAt: null, deletedAt: null, ...issue }]]),
  );
  store.insert('Comment', comment({ id: ROOT }));
  store.insert('Comment', comment({ id: REPLY, parentCommentId: ROOT, userId: IRIS }));
  return store;
}

const row = (store: Store, id: string) => store.rows.get('Comment')?.get(id);

describe('comment.create optimistic (AC-11)', () => {
  it('inserts the comment as the server stores it: version 1, the issue team, me as author', () => {
    const store = seeded();
    commentCreate.optimistic?.(store, { id: NEW_ID, issue: ISSUE, body: doc('New') });
    expect(row(store, NEW_ID)).toEqual(
      comment({
        id: NEW_ID,
        body: doc('New'),
        createdAt: AT,
        updatedAt: AT,
      }),
    );
  });

  it('inserts a reply under a live top-level comment', () => {
    const store = seeded();
    commentCreate.optimistic?.(store, {
      id: NEW_ID,
      issue: ISSUE,
      parent: ROOT,
      body: doc('Reply'),
    });
    expect(row(store, NEW_ID)?.['parentCommentId']).toBe(ROOT);
  });

  it('predicts nothing for a Markdown body, an archived issue or a refused parent', () => {
    const cases: [Store, Record<string, unknown>][] = [
      [seeded(), { body: 'Markdown' }],
      [seeded({ archivedAt: EARLIER }), {}],
      [seeded({ deletedAt: EARLIER }), {}],
      [seeded(), { parent: REPLY }],
      [seeded(), { parent: '0192f0c1-7e5a-7b3c-9d4e-0000000000ff' }],
    ];
    for (const [store, extra] of cases) {
      commentCreate.optimistic?.(store, { id: NEW_ID, issue: ISSUE, body: doc('x'), ...extra });
      expect(row(store, NEW_ID)).toBeUndefined();
    }
    const deleted = seeded();
    deleted.patch('Comment', ROOT, { deletedAt: EARLIER });
    commentCreate.optimistic?.(deleted, {
      id: NEW_ID,
      issue: ISSUE,
      parent: ROOT,
      body: doc('x'),
    });
    expect(row(deleted, NEW_ID)).toBeUndefined();
  });
});

describe('comment.update optimistic (AC-11, E22)', () => {
  it('patches body, editedAt and version + 1', () => {
    const store = seeded();
    commentUpdate.optimistic?.(store, { comment: ROOT, baseVersion: 1, body: doc('Edited') });
    expect(row(store, ROOT)).toEqual(
      comment({ id: ROOT, body: doc('Edited'), version: 2, editedAt: AT, updatedAt: AT }),
    );
  });

  it('chains two queued edits, even when the first body is the stored one (E22)', () => {
    const store = seeded();
    commentUpdate.optimistic?.(store, { comment: ROOT, baseVersion: 1, body: doc('Hello') });
    commentUpdate.optimistic?.(store, { comment: ROOT, baseVersion: 2, body: doc('Second') });
    expect(row(store, ROOT)).toMatchObject({ body: doc('Second'), version: 3 });
  });

  it("predicts nothing for someone else's comment, a stale base or a Markdown body", () => {
    for (const input of [
      { comment: REPLY, baseVersion: 1, body: doc('x') },
      { comment: ROOT, baseVersion: 2, body: doc('x') },
      { comment: ROOT, baseVersion: 1, body: 'x' },
    ]) {
      const store = seeded();
      const before = row(store, input.comment);
      commentUpdate.optimistic?.(store, input);
      expect(row(store, input.comment)).toEqual(before);
    }
  });
});

describe('comment.delete optimistic (AC-11)', () => {
  it('removes a comment without replies and its reactions', () => {
    const store = seeded();
    store.insert('Reaction', {
      id: NEW_ID,
      issueId: ISSUE,
      teamId: TEAM,
      commentId: REPLY,
      userId: ME,
      emoji: '👍',
      createdAt: EARLIER,
    });
    commentDelete.optimistic?.(store, { comment: REPLY });
    expect(row(store, REPLY)).toBeUndefined();
    expect(store.find('Reaction', {})).toEqual([]);
    expect(row(store, ROOT)?.['deletedAt']).toBeNull();
  });

  it('soft-deletes a comment with replies: EMPTY_DOC, deletedAt, version + 1', () => {
    const store = seeded();
    commentDelete.optimistic?.(store, { comment: ROOT });
    expect(row(store, ROOT)).toEqual(
      comment({ id: ROOT, body: EMPTY_DOC, deletedAt: AT, version: 2, updatedAt: AT }),
    );
    expect(row(store, REPLY)).toBeDefined();
  });

  it('removes a placeholder with its last reply', () => {
    const store = seeded();
    commentDelete.optimistic?.(store, { comment: ROOT });
    commentDelete.optimistic?.(store, { comment: REPLY });
    expect(store.find('Comment', {})).toEqual([]);
  });
});

describe('comment.resolve and comment.reopen optimistic (AC-11)', () => {
  it('resolve patches the root from a reply ref, leaving the version', () => {
    const store = seeded();
    commentResolve.optimistic?.(store, { comment: REPLY });
    expect(row(store, ROOT)).toEqual(
      comment({ id: ROOT, resolvedAt: AT, resolvedById: ME, updatedAt: AT }),
    );
    expect(row(store, REPLY)?.['resolvedAt']).toBeNull();
  });

  it('reopen clears both fields; neither writes when the state already holds', () => {
    const store = seeded();
    commentReopen.optimistic?.(store, { comment: ROOT });
    expect(row(store, ROOT)?.['updatedAt']).toBe(EARLIER);
    commentResolve.optimistic?.(store, { comment: ROOT });
    commentReopen.optimistic?.(store, { comment: ROOT });
    expect(row(store, ROOT)).toMatchObject({ resolvedAt: null, resolvedById: null, version: 1 });
  });
});

describe('registry rules (AC-13)', () => {
  const ops = [
    commentList,
    commentCreate,
    commentUpdate,
    commentResolve,
    commentReopen,
    commentDelete,
  ];

  it('pass the SPEC-003 §11 lint', () => {
    expect(lintOperations(ops)).toEqual([]);
  });

  it('declare contentParent on every mutation, and destructive on delete only', () => {
    for (const op of ops.filter((o) => o.kind === 'mutation')) {
      expect(typeof op.contentParent).toBe('function');
      expect(op.destructive).toBe(op.name === 'comment.delete');
    }
    expect(commentCreate.contentParent?.({ issue: 'ENG-1', body: 'x' })).toEqual({
      model: 'Issue',
      id: 'ENG-1',
    });
    expect(commentResolve.contentParent?.({ comment: ROOT })).toEqual({
      model: 'Comment',
      id: ROOT,
    });
  });
});
