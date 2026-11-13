// PLAN-013 S3, SPEC-013: AC-1 (create, replies, body checks), AC-2 (author-only edit, baseVersion,
// every update bumps the version, delete by the author or an Admin), AC-3 (hard, soft, last reply,
// no cascade), AC-6 (archived and deleted issues), AC-21 (resolve and reopen), E2, E3, E13, E15,
// E17, E8 and E12 (comment.list), the §6.3 error table and the lock order of §4.3. The rules run on an in-memory thread store
// (`support/memory-comments.ts`); the SQL is covered by the registry contract and the leak test.
import { randomUUID } from 'node:crypto';
import type { Actor } from '@surface/domain';
import { COMMENT_MESSAGES, EMPTY_DOC } from '@surface/domain';
import { DOC_MESSAGES } from '@surface/editor/schema';
import {
  commentCreate,
  commentDelete,
  commentList,
  commentReopen,
  commentResolve,
  commentUpdate,
  type OptimisticStore,
  type StoreRow,
} from '@surface/operations';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../src/executor/context.js';
import { SurfaceError } from '../src/executor/errors.js';
import { claimInlineFiles } from '../src/files/claim.js';
import {
  commentDoc,
  createComment,
  deleteComment,
  setThreadResolved,
  updateComment,
  type CommentRow,
  type CommentTarget,
} from '../src/handlers/comments/core.js';
import listComments from '../src/handlers/comments/list.js';
import {
  ADA,
  IRIS,
  memoryComments,
  NOW,
  TEAM,
  type MemoryComments,
} from './support/memory-comments.js';
import { recordingDb } from './support/scripted-db.js';

async function failure(run: Promise<unknown>): Promise<SurfaceError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof SurfaceError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const doc = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

/** The `CommentTarget` the executor builds from a resolved `CommentRef`. */
const target = (row: CommentRow): CommentTarget => ({
  commentId: row.id,
  issueId: row.issueId,
  rootId: row.parentCommentId ?? row.id,
});

function create(
  m: MemoryComments,
  extra: { parentId?: string; body?: string | Record<string, unknown>; issueId?: string } = {},
  author: Parameters<MemoryComments['ctx']>[0] = {},
): Promise<CommentRow> {
  return createComment(m.ctx(author), {
    id: randomUUID(),
    issueId: extra.issueId ?? m.issue.id,
    parentId: extra.parentId,
    body: extra.body ?? doc('Looks good'),
  });
}

describe('comment.create (AC-1)', () => {
  it('stores the validated document as version 1 with its search text and team', async () => {
    const m = memoryComments();
    const row = await create(m, { body: 'Repro on **Safari** too' });
    expect(row).toMatchObject({
      issueId: m.issue.id,
      teamId: TEAM,
      parentCommentId: null,
      userId: ADA,
      actorKind: 'user',
      version: 1,
      editedAt: null,
      deletedAt: null,
      resolvedAt: null,
    });
    // Markdown arrives converted (§6.1): bold is a mark, not asterisks.
    expect(JSON.stringify(row.body)).toContain('"bold"');
    expect(m.searchText.get(row.id)).toBe('Repro on Safari too');
    expect(m.writes).toEqual([
      { action: 'I', model: 'Comment', id: row.id, groups: [`team:${TEAM}`] },
    ]);
  });

  it('records how the author wrote it: via API or MCP (D16)', async () => {
    const m = memoryComments();
    expect((await create(m, {}, { actorKind: 'api' })).actorKind).toBe('api');
    expect((await create(m, {}, { actorKind: 'mcp' })).actorKind).toBe('mcp');
  });

  it('attaches a reply to a live top-level comment of the same issue', async () => {
    const m = memoryComments();
    const root = await create(m);
    const reply = await create(m, { parentId: root.id }, { userId: IRIS });
    expect(reply.parentCommentId).toBe(root.id);
  });

  it('refuses a reply to a reply (INV-19)', async () => {
    const m = memoryComments();
    const root = await create(m);
    const reply = await create(m, { parentId: root.id });
    const error = await failure(create(m, { parentId: reply.id }));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe(COMMENT_MESSAGES.replyToReply);
    expect(error.details.issues?.[0]?.path).toEqual(['parent']);
  });

  it('refuses a reply to a placeholder, and to a comment of another issue', async () => {
    const m = memoryComments();
    const placeholder = m.addComment({ deletedAt: NOW, body: EMPTY_DOC });
    expect((await failure(create(m, { parentId: placeholder.id }))).message).toBe(
      COMMENT_MESSAGES.replyToDeleted,
    );
    const other = m.addIssue(43);
    const elsewhere = m.addComment({ issueId: other.id });
    expect((await failure(create(m, { parentId: elsewhere.id }))).message).toBe(
      COMMENT_MESSAGES.replyOtherIssue,
    );
    expect(m.writes).toEqual([]);
  });

  it('emits comment.created with ids and no body', async () => {
    const m = memoryComments();
    const row = await create(m, { body: 'secret words' });
    expect(m.events).toEqual([
      {
        type: 'comment.created',
        subject: { type: 'comment', id: row.id },
        data: { issueId: m.issue.id, parentId: null },
      },
    ]);
    expect(JSON.stringify(m.events)).not.toContain('secret');
  });
});

describe('body checks (§6.3)', () => {
  const refused = (body: string | Record<string, unknown>) => {
    try {
      commentDoc(body);
    } catch (error) {
      if (error instanceof SurfaceError) return error;
      throw error;
    }
    throw new Error('expected a refusal');
  };

  it('refuses an empty comment, as Markdown or as JSON', () => {
    for (const body of ['', '   \n\n ', { ...EMPTY_DOC }, doc('  ')]) {
      const error = refused(body);
      expect(error.code).toBe('INVALID_INPUT');
      expect(error.message).toBe(COMMENT_MESSAGES.empty);
      expect(error.details.issues?.[0]?.path).toEqual(['body']);
    }
  });

  it('refuses a body over 50 KB at the input, and a document that grows past it', () => {
    const input = commentCreate.input.safeParse({ issue: 'ENG-1', body: 'x'.repeat(51_201) });
    expect(input.error?.issues.map((i) => i.message)).toEqual([COMMENT_MESSAGES.tooLong]);
    expect(
      commentCreate.input.safeParse({ issue: 'ENG-1', body: 'x'.repeat(51_200) }).success,
    ).toBe(true);
    // 40 KB of Markdown whose document JSON is over 50 KB: the handler measures what it stores.
    const markdown = '*a* '.repeat(10_000);
    expect(new TextEncoder().encode(markdown).length).toBeLessThan(51_200);
    expect(refused(markdown).message).toBe(COMMENT_MESSAGES.tooLong);
  });

  it('refuses bad links, linked images and NUL with the path of the bad part', () => {
    const link = refused({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'javascript:x' } }] },
          ],
        },
      ],
    });
    expect(link.message).toBe(DOC_MESSAGES.badLink);
    expect(link.details.issues?.[0]?.path[0]).toBe('body');
    expect(link.details.issues?.[0]?.path.length).toBeGreaterThan(1);

    const image = refused({
      type: 'doc',
      content: [{ type: 'image', attrs: { src: 'https://example.com/a.png', alt: null } }],
    });
    expect(image.message).toBe(DOC_MESSAGES.badImage);

    expect(refused(doc('a\u0000b')).message).toBe(DOC_MESSAGES.brokenText);
  });

  it('refuses a file reference: the claim stub accepts none until PLAN-014 S4b', async () => {
    const m = memoryComments();
    const body = {
      type: 'doc',
      content: [{ type: 'image', attrs: { src: `/files/${randomUUID()}`, alt: null } }],
    };
    const error = await failure(create(m, { body }));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toBe(DOC_MESSAGES.badFile);
    expect(m.writes).toEqual([]);
  });

  it('the real claimInlineFiles stub accepts a document without files and refuses one with', async () => {
    // The stub reads no row; PLAN-014 S4b replaces this test with the real claim's.
    const tx = {} as NodePgDatabase;
    const actor = { kind: 'user', userId: ADA, groups: [], publicTeams: [], memberOf: [] } as Actor;
    const issue = { id: randomUUID(), teamId: TEAM };
    const plain = commentDoc('No files here');
    await expect(claimInlineFiles(tx, plain, issue, actor)).resolves.toBe(plain);
    const withFile = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'file', attrs: { src: `/files/${randomUUID()}`, name: 'a.pdf' } }],
        },
      ],
    };
    await expect(claimInlineFiles(tx, withFile, issue, actor)).rejects.toThrow(
      DOC_MESSAGES.badFile,
    );
  });
});

describe('comment.update (AC-2, E3, E22)', () => {
  it('lets only the author edit, Admins included (permissions §3.3)', async () => {
    const m = memoryComments();
    const row = m.addComment({ userId: IRIS });
    for (const author of [{}, { admin: true }]) {
      const error = await failure(
        updateComment(m.ctx(author), { ...target(row), baseVersion: 1, body: doc('Edited') }),
      );
      expect(error.code).toBe('FORBIDDEN');
      expect(error.message).toBe(COMMENT_MESSAGES.notAuthor);
    }
    expect(m.writes).toEqual([]);
  });

  it('refuses a stale baseVersion: the second of two tabs gets CONFLICT (E3)', async () => {
    const m = memoryComments();
    const row = m.addComment({});
    await updateComment(m.ctx(), { ...target(row), baseVersion: 1, body: doc('Tab one') });
    const error = await failure(
      updateComment(m.ctx(), { ...target(row), baseVersion: 1, body: doc('Tab two') }),
    );
    expect(error.code).toBe('CONFLICT');
    expect(error.message).toBe(COMMENT_MESSAGES.staleVersion);
    expect(m.comments.get(row.id)?.version).toBe(2);
  });

  it('raises the version and sets editedAt on every update, with an event only on a change', async () => {
    const m = memoryComments();
    const row = m.addComment({ body: doc('Same') });
    const same = await updateComment(m.ctx(), {
      ...target(row),
      baseVersion: 1,
      body: doc('Same'),
    });
    expect(same).toMatchObject({ version: 2, editedAt: NOW });
    expect(m.events).toEqual([]);
    // E22: the follow-up edit carries baseVersion 2 and is accepted.
    const changed = await updateComment(m.ctx(), {
      ...target(row),
      baseVersion: 2,
      body: 'Different',
    });
    expect(changed.version).toBe(3);
    expect(m.searchText.get(row.id)).toBe('Different');
    expect(m.events).toEqual([
      {
        type: 'comment.updated',
        subject: { type: 'comment', id: row.id },
        data: { issueId: m.issue.id, version: 3 },
      },
    ]);
  });

  it('answers NOT_FOUND for a placeholder, worded as for a missing comment', async () => {
    const m = memoryComments();
    const placeholder = m.addComment({ deletedAt: NOW, body: EMPTY_DOC, version: 2 });
    const error = await failure(
      updateComment(m.ctx(), { ...target(placeholder), baseVersion: 2, body: doc('Back') }),
    );
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe(
      `Comment "${placeholder.id}" not found. Use a comment id from comment.list.`,
    );
  });

  it('checks baseVersion as a whole number of at least 1 at the input', () => {
    const parse = (baseVersion: unknown) =>
      commentUpdate.input.safeParse({ comment: randomUUID(), baseVersion, body: 'x' }).success;
    expect(parse(1)).toBe(true);
    for (const bad of [0, 1.5, '1', -1]) expect(parse(bad)).toBe(false);
  });
});

describe('comment.delete (AC-2, AC-3, E13)', () => {
  it('lets the author or an Admin delete, and no one else', async () => {
    const m = memoryComments();
    const row = m.addComment({ userId: IRIS });
    const error = await failure(deleteComment(m.ctx(), target(row)));
    expect(error.code).toBe('FORBIDDEN');
    expect(error.message).toBe(COMMENT_MESSAGES.notAuthorDelete);
    expect(await deleteComment(m.ctx({ admin: true }), target(row))).toEqual({
      comment: row.id,
      mode: 'hard',
    });
  });

  it('hard-deletes a comment without replies, its reactions first, each with a D (no cascade)', async () => {
    const m = memoryComments();
    const row = m.addComment({});
    const r1 = m.addReaction(row.id, ADA, '👍');
    const r2 = m.addReaction(row.id, IRIS, '🎉');
    const other = m.addReaction(null, IRIS, '👀');
    await deleteComment(m.ctx(), target(row));
    expect(m.comments.has(row.id)).toBe(false);
    expect(m.searchText.has(row.id)).toBe(false);
    expect(m.writes.map((w) => `${w.action} ${w.model} ${w.id}`)).toEqual([
      ...[r1.id, r2.id].sort().map((id) => `D Reaction ${id}`),
      `D Comment ${row.id}`,
    ]);
    // The issue's own reaction is not the comment's.
    expect(m.reactions.has(other.id)).toBe(true);
    expect(m.events).toEqual([
      {
        type: 'comment.deleted',
        subject: { type: 'comment', id: row.id },
        data: { issueId: m.issue.id, mode: 'hard' },
      },
    ]);
  });

  it('soft-deletes a comment with replies: EMPTY_DOC, deletedAt, version + 1, no text, no reactions', async () => {
    const m = memoryComments();
    const root = m.addComment({});
    const reply = m.addComment({ parentCommentId: root.id, userId: IRIS });
    m.addReaction(root.id, IRIS, '👍');
    expect(await deleteComment(m.ctx(), target(root))).toEqual({ comment: root.id, mode: 'soft' });
    expect(m.comments.get(root.id)).toMatchObject({
      body: EMPTY_DOC,
      deletedAt: NOW,
      version: 2,
    });
    expect(m.searchText.has(root.id)).toBe(false);
    expect(m.reactions.size).toBe(0);
    expect(m.comments.has(reply.id)).toBe(true);
    // A placeholder can't be deleted again.
    expect((await failure(deleteComment(m.ctx(), target(root)))).code).toBe('NOT_FOUND');
  });

  it('removes the placeholder with its last reply, and two last replies in turn (E13)', async () => {
    const m = memoryComments();
    const root = m.addComment({ deletedAt: NOW, body: EMPTY_DOC, version: 2 });
    const a = m.addComment({ parentCommentId: root.id, userId: IRIS });
    const b = m.addComment({ parentCommentId: root.id });
    // The thread lock orders the two deletes; the first leaves a reply, the second none.
    await deleteComment(m.ctx({ userId: IRIS }), target(a));
    expect(m.comments.has(root.id)).toBe(true);
    await deleteComment(m.ctx(), target(b));
    expect(m.comments.size).toBe(0);
    expect(m.writes.filter((w) => w.model === 'Comment').map((w) => w.id)).toEqual([
      a.id,
      b.id,
      root.id,
    ]);
  });

  it('keeps a live parent when its last reply is deleted', async () => {
    const m = memoryComments();
    const root = m.addComment({});
    const reply = m.addComment({ parentCommentId: root.id });
    await deleteComment(m.ctx(), target(reply));
    expect(m.comments.get(root.id)?.deletedAt).toBeNull();
  });
});

describe('E2: a reply racing a delete, ordered by the thread lock', () => {
  it('delete first: the reply is refused', async () => {
    const m = memoryComments();
    const root = m.addComment({});
    await deleteComment(m.ctx(), target(root));
    const error = await failure(create(m, { parentId: root.id }, { userId: IRIS }));
    expect(error.code).toBe('NOT_FOUND');
    expect(error.details.issues?.[0]?.path).toEqual(['parent']);
  });

  it('reply first: the delete becomes a soft delete', async () => {
    const m = memoryComments();
    const root = m.addComment({});
    await create(m, { parentId: root.id }, { userId: IRIS });
    expect((await deleteComment(m.ctx(), target(root))).mode).toBe('soft');
  });
});

describe('comment.resolve and comment.reopen (AC-21)', () => {
  it('resolves the thread root, from a reply ref too, without touching version or editedAt', async () => {
    const m = memoryComments();
    const root = m.addComment({ userId: IRIS, version: 3 });
    const reply = m.addComment({ parentCommentId: root.id, userId: IRIS });
    // Any member who sees the issue may resolve: Ada wrote neither comment.
    const row = await setThreadResolved(m.ctx(), target(reply), true);
    expect(row).toMatchObject({
      id: root.id,
      resolvedAt: NOW,
      resolvedById: ADA,
      version: 3,
      editedAt: null,
    });
    expect(m.comments.get(reply.id)?.resolvedAt).toBeNull();
    expect(m.events).toEqual([
      {
        type: 'comment.resolved',
        subject: { type: 'comment', id: root.id },
        data: { issueId: m.issue.id },
      },
    ]);
  });

  it('is idempotent: resolving a resolved thread or reopening an open one writes nothing', async () => {
    const m = memoryComments();
    const open = m.addComment({});
    const resolved = m.addComment({ resolvedAt: NOW, resolvedById: IRIS });
    expect(await setThreadResolved(m.ctx(), target(open), false)).toEqual(open);
    expect(await setThreadResolved(m.ctx(), target(resolved), true)).toEqual(resolved);
    expect(m.writes).toEqual([]);
    expect(m.events).toEqual([]);
  });

  it('reopens: clears both fields and writes comment.reopened', async () => {
    const m = memoryComments();
    const root = m.addComment({ resolvedAt: NOW, resolvedById: IRIS });
    const row = await setThreadResolved(m.ctx(), target(root), false);
    expect(row).toMatchObject({ resolvedAt: null, resolvedById: null, version: 1 });
    expect(m.events.map((e) => e.type)).toEqual(['comment.reopened']);
  });

  it('works on a placeholder root', async () => {
    const m = memoryComments();
    const root = m.addComment({ deletedAt: NOW, body: EMPTY_DOC, version: 2 });
    m.addComment({ parentCommentId: root.id });
    expect((await setThreadResolved(m.ctx(), target(root), true)).resolvedAt).toEqual(NOW);
  });
});

describe('AC-6, E15, E17: archived and deleted issues are read-only', () => {
  const operations = (m: MemoryComments, row: CommentRow) => ({
    create: () => create(m),
    reply: () => create(m, { parentId: row.id }),
    update: () => updateComment(m.ctx(), { ...target(row), baseVersion: 1, body: doc('x') }),
    delete: () => deleteComment(m.ctx(), target(row)),
    resolve: () => setThreadResolved(m.ctx(), target(row), true),
    reopen: () => setThreadResolved(m.ctx(), target(row), false),
  });

  for (const [state, message] of [
    ['archived', 'ENG-42 is archived. Restore it to edit it.'],
    ['deleted', 'ENG-42 was deleted. Restore it to edit it.'],
  ] as const) {
    it(`answers CONFLICT on a ${state} issue for every comment operation`, async () => {
      const m = memoryComments();
      const row = m.addComment({});
      if (state === 'archived') m.issue.archivedAt = NOW;
      else m.issue.deletedAt = NOW;
      for (const [name, run] of Object.entries(operations(m, row))) {
        const error = await failure(run());
        expect({ name, code: error.code, message: error.message }).toEqual({
          name,
          code: 'CONFLICT',
          message,
        });
      }
      expect(m.writes).toEqual([]);
      // Nothing unarchives or restores the issue.
      expect(state === 'archived' ? m.issue.archivedAt : m.issue.deletedAt).toEqual(NOW);
    });
  }
});

describe('lock order (§4.3)', () => {
  it('locks the issue, then the thread root, then re-reads the comment and its thread', async () => {
    const m = memoryComments();
    const root = m.addComment({});
    const reply = m.addComment({ parentCommentId: root.id });
    m.reset();
    await deleteComment(m.ctx(), target(reply));
    expect(m.calls).toEqual([
      'lockIssue',
      `lockComment:${root.id}`,
      `readComment:${reply.id}`,
      `replyIds:${root.id}`,
    ]);
    m.reset();
    await create(m, { parentId: root.id });
    expect(m.calls).toEqual(['lockIssue', `lockComment:${root.id}`, 'claimFiles']);
    expect(m.lockModes).toEqual(['edit']);
  });
});

/** A row as the client replica holds it: ISO timestamps, no groups (content rows carry none). */
function clientRow(row: object): StoreRow {
  return Object.fromEntries(
    Object.entries(row)
      .filter(([key]) => key !== 'syncGroups')
      .map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]),
  );
}

const byId = (rows: Iterable<StoreRow>) =>
  [...rows].sort((a, b) => String(a['id']).localeCompare(String(b['id'])));

/** The client store over a copy of `m`'s rows, with its live issue and Ada as `me` (§6.2). */
function storeOver(m: MemoryComments): OptimisticStore & { rows(model: string): StoreRow[] } {
  const tables = new Map<string, Map<string, StoreRow>>([
    ['Comment', new Map([...m.comments].map(([id, row]) => [id, clientRow(row)]))],
    ['Reaction', new Map([...m.reactions].map(([id, row]) => [id, clientRow(row)]))],
    ['Issue', new Map([[m.issue.id, clientRow(m.issue)]])],
    ['User', new Map([[ADA, { id: ADA }]])],
  ]);
  const table = (model: string) => {
    const found = tables.get(model);
    if (found === undefined) throw new Error(`no ${model} in this store`);
    return found;
  };
  const get = (model: string, ref: string) =>
    table(model).get(model === 'User' && ref === 'me' ? ADA : ref);
  return {
    now: NOW,
    get,
    find: (model, fields) =>
      byId(table(model).values()).filter((row) =>
        Object.entries(fields).every(([key, value]) => row[key] === value),
      ),
    insert: (model, row) => void table(model).set(row.id, row),
    patch: (model, ref, changes) => {
      const row = get(model, ref);
      if (row !== undefined) table(model).set(ref, { ...row, ...changes });
    },
    remove: (model, ref) => void table(model).delete(ref),
    archive: () => undefined,
    unarchive: () => undefined,
    rows: (model) => byId(table(model).values()),
  };
}

describe('AC-11: optimistic equals the server', () => {
  /** A thread by Ada with a reply by Iris, and Iris's reaction on the root. */
  function thread() {
    const m = memoryComments();
    const root = m.addComment({ body: doc('Root') });
    const reply = m.addComment({ parentCommentId: root.id, userId: IRIS, body: doc('Reply') });
    m.addReaction(root.id, IRIS, '👍');
    return { m, root, reply };
  }
  type Thread = ReturnType<typeof thread>;
  const id = randomUUID();

  /** Each case runs the optimistic on the store, then returns the server rule's run. */
  const cases: [string, (t: Thread, store: OptimisticStore) => Promise<unknown>][] = [
    [
      'comment.create',
      ({ m }, store) => {
        commentCreate.optimistic?.(store, { id, issue: m.issue.id, body: doc('New') });
        return createComment(m.ctx(), { id, issueId: m.issue.id, body: doc('New') });
      },
    ],
    [
      'comment.create, a reply',
      ({ m, root }, store) => {
        const input = { id, issue: m.issue.id, parent: root.id, body: doc('Re') };
        commentCreate.optimistic?.(store, input);
        return createComment(m.ctx(), { ...input, issueId: m.issue.id, parentId: root.id });
      },
    ],
    [
      'comment.update',
      ({ m, root }, store) => {
        commentUpdate.optimistic?.(store, { comment: root.id, baseVersion: 1, body: doc('E') });
        return updateComment(m.ctx(), { ...target(root), baseVersion: 1, body: doc('E') });
      },
    ],
    [
      'comment.delete, soft',
      ({ m, root }, store) => {
        commentDelete.optimistic?.(store, { comment: root.id });
        return deleteComment(m.ctx(), target(root));
      },
    ],
    [
      'comment.delete, the last reply of a placeholder',
      async ({ m, root, reply }) => {
        await deleteComment(m.ctx(), target(root));
        const store = storeOver(m);
        commentDelete.optimistic?.(store, { comment: reply.id });
        await deleteComment(m.ctx({ userId: IRIS }), target(reply));
        return store;
      },
    ],
    [
      'comment.resolve, from a reply',
      ({ m, reply }, store) => {
        commentResolve.optimistic?.(store, { comment: reply.id });
        return setThreadResolved(m.ctx(), target(reply), true);
      },
    ],
    [
      'comment.reopen',
      async ({ m, root }) => {
        await setThreadResolved(m.ctx({ userId: IRIS }), target(root), true);
        const store = storeOver(m);
        commentReopen.optimistic?.(store, { comment: root.id });
        await setThreadResolved(m.ctx(), target(root), false);
        return store;
      },
    ],
  ];

  it.each(cases)('%s predicts the rows the server commits', async (_name, run) => {
    const t = thread();
    const initial = storeOver(t.m);
    const result = await run(t, initial);
    // A case that set up more state first returns the store it predicted on.
    const store =
      result !== null && typeof result === 'object' && 'rows' in result ? result : initial;
    if (!('rows' in store) || typeof store.rows !== 'function') throw new Error('no store');
    const rows = store.rows as (model: string) => StoreRow[];
    expect(rows('Comment')).toEqual(byId([...t.m.comments.values()].map(clientRow)));
    expect(rows('Reaction')).toEqual(byId([...t.m.reactions.values()].map(clientRow)));
  });
});

describe('comment.list (E8, E12)', () => {
  const ISSUE = '0190f0c0-0000-7000-8000-000000000001';
  const row = (id: string, userId: string, minutes: number): CommentRow => ({
    id,
    issueId: ISSUE,
    teamId: TEAM,
    parentCommentId: null,
    userId,
    actorKind: 'user',
    body: doc(`Comment ${id}`),
    version: 1,
    editedAt: null,
    deletedAt: null,
    resolvedAt: null,
    resolvedById: null,
    syncGroups: [`team:${TEAM}`],
    createdAt: new Date(NOW.getTime() + minutes * 60_000),
    updatedAt: NOW,
  });

  /** The handler over a recorded `ctx.query.list` and a database that knows Ada and Iris. */
  function run(input: unknown, page: readonly CommentRow[]) {
    const lists: { model: unknown; options: unknown }[] = [];
    const { db, statements } = recordingDb((text, params) => {
      if (text.includes('from "issues"')) return [[ISSUE, 7, 'ENG']];
      if (text.includes('from "users"')) {
        const names: Record<string, string> = { [ADA]: 'Ada', [IRIS]: 'Iris' };
        return params.flatMap((id) =>
          typeof id === 'string' && names[id] !== undefined ? [[id, names[id]]] : [],
        );
      }
      return [];
    });
    const ctx = {
      actor: { kind: 'user', userId: ADA },
      refs: { issue: { id: ISSUE, teamId: TEAM } },
      tx: db,
      query: {
        list: (model: unknown, options: unknown) => {
          lists.push({ model, options });
          return Promise.resolve({
            nodes: page,
            pageInfo: { hasNextPage: true, endCursor: 'next' },
          });
        },
      },
    } as unknown as HandlerContext;
    const parsed = commentList.input.parse(input);
    return { result: listComments.run(ctx, parsed), lists, statements };
  }

  it('pages: at most 100 a page, 25 by default, the cursor passed on and the list kept to the issue (E12)', async () => {
    expect(commentList.input.safeParse({ issue: 'ENG-7', limit: 101 }).success).toBe(false);
    expect(commentList.input.parse({ issue: 'ENG-7' })).toMatchObject({ limit: 25 });
    const author = { field: 'author', op: 'eq', value: ADA };
    const { result, lists } = run({ issue: 'ENG-7', limit: 2, cursor: 'c1', filter: author }, []);
    await expect(result).resolves.toMatchObject({
      nodes: [],
      pageInfo: { hasNextPage: true, endCursor: 'next' },
    });
    expect(lists).toHaveLength(1);
    expect(lists[0]?.options).toMatchObject({
      limit: 2,
      cursor: 'c1',
      filter: { and: [{ field: 'issue', op: 'eq', value: ISSUE }, author] },
    });
  });

  it('keeps a deactivated author’s name on their comments: users are never purged (E8)', async () => {
    // Iris is deactivated: the name lookup reads users by id alone, whatever their state.
    const { result, statements } = run({ issue: 'ENG-7' }, [
      row('0190f0c0-0000-7000-8000-000000000701', IRIS, 0),
      row('0190f0c0-0000-7000-8000-000000000702', ADA, 1),
    ]);
    const { nodes } = await result;
    expect(nodes.map((n) => [n.author, n.issue.identifier])).toEqual([
      [{ id: IRIS, name: 'Iris' }, 'ENG-7'],
      [{ id: ADA, name: 'Ada' }, 'ENG-7'],
    ]);
    const userRead = statements.find((st) => st.text.includes('from "users"'));
    expect(userRead?.text).not.toContain('active');
  });
});
