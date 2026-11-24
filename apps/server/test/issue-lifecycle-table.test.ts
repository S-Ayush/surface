// PLAN-015 S1, SPEC-015 §4.3–§4.4: AC-1 (every row of the lifecycle rule table holds: the
// operation's handler locks the issue in the row's mode, before any write, and gets the listed
// result for a live, an archived and a deleted issue), AC-2 (direct edits of archived and deleted
// issues are CONFLICT with the §4.2 wording and no repo write; cascades write archived and deleted
// issues and leave their lifecycle and `updatedAt` alone: E11), E15's refusal wording. Each built
// row's registered handler also runs on SQL, which shows its first `issues` statement is the
// `FOR UPDATE` lock and that no write comes before it. A row whose
// handler doesn't exist yet is listed as pending, by the slice that adds it; a built row with no
// case here fails, and so does an issue mutation with no row.
import { randomUUID } from 'node:crypto';
import {
  ISSUE_LIFECYCLE_RULES,
  ISSUE_LIFECYCLES,
  purgeAfter,
  systemActor,
  type IssueLifecycle,
  type LifecycleOutcome,
} from '@surface/domain';
import { ALL_OPERATIONS } from '@surface/operations';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { SurfaceError } from '../src/executor/errors.js';
import { HANDLERS } from '../src/handlers/index.js';
import {
  createComment,
  deleteComment,
  setThreadResolved,
  updateComment,
  type CommentTarget,
  type CommentWriteContext,
} from '../src/handlers/comments/core.js';
import { updateDescription, updateIssue, type IssueRow } from '../src/handlers/issues/core.js';
import { setReaction } from '../src/handlers/reactions/core.js';
import { deleteLabel, type LabelAccess } from '../src/handlers/labels/core.js';
import type { Repo } from '../src/sync/repo.js';
import { deleteIssue, restoreIssue } from '../src/handlers/issues/lifecycle-core.js';
import { autoArchiveIssue, autoCloseIssue } from '../src/handlers/issues/auto-core.js';
import { memoryAuto } from './support/memory-auto.js';
import { purgeIssue } from '../src/issues/purge.js';
import {
  createFileAttachment,
  createLinkAttachment,
  deleteAttachment,
  renameAttachment,
  setAttachmentPreview,
  type AttachmentTarget,
  type AttachmentWriteContext,
} from '../src/handlers/attachment/core.js';
import { cleanupFiles } from '../src/jobs/files.js';
import { insertUpload } from '../src/files/bytes.js';
import { body, MODEL_HOUR, ModelDb, modelBlobStore } from './files-bytes-model.js';
import { attachmentId, memoryAttachments } from './support/memory-attachments.js';
import { memoryComments } from './support/memory-comments.js';
import { ADA_ID, NOW, type MemoryIssues } from './support/memory-issues.js';
import { scriptedDb } from './support/scripted-db.js';
import {
  DELETED_AT,
  EARLIER,
  HANDLER_INPUTS,
  OWN_SQL_TEST,
  issueIn,
  runHandler,
} from './support/issue-handler-sql.js';

/** Runs one operation's handler rules on `issue` at `now`. */
type Case = (m: MemoryIssues, issue: IssueRow, now: Date) => Promise<unknown>;

/**
 * A comment rule run on a thread of `issue` (a root by Ada with one reply, resolved when
 * `resolved`): the issue lock goes through `m`'s access, so `m` records its mode, and each comment
 * write is recorded in `m.writes` and `m.calls` like an issue write (PLAN-013 S3).
 */
function commentCase(
  rule: (ctx: CommentWriteContext, target: CommentTarget) => Promise<unknown>,
  options: { readonly resolved?: boolean } = {},
): Case {
  return (m, issue) => {
    const c = memoryComments();
    const root = c.addComment({
      issueId: issue.id,
      teamId: issue.teamId,
      userId: ADA_ID,
      ...(options.resolved === true ? { resolvedAt: EARLIER, resolvedById: ADA_ID } : {}),
    });
    c.addComment({ issueId: issue.id, teamId: issue.teamId, parentCommentId: root.id });
    const recorded = (method: 'insert' | 'update' | 'purge', model: string, id: string) => {
      m.calls.push(`write:${method}`);
      m.writes.push({
        action: method === 'insert' ? 'insert' : 'update',
        model,
        ids: [id],
        fields: [],
      });
    };
    const repo: Repo = {
      ...c.repo,
      insert: (model, row) => {
        recorded('insert', model, row.id ?? '');
        return c.repo.insert(model, row);
      },
      update: (model, id, patch) => {
        recorded('update', model, id);
        return c.repo.update(model, id, patch);
      },
      purge: (model, id) => {
        recorded('purge', model, id);
        return c.repo.purge(model, id);
      },
    };
    const base = c.ctx({ userId: ADA_ID });
    const ctx: CommentWriteContext = {
      ...base,
      repo,
      emit: (event) => void m.events.push(event),
      access: { ...base.access, lockIssue: (id, mode) => m.ctx.access.lockIssue(id, mode) },
    };
    return rule(ctx, { commentId: root.id, issueId: issue.id, rootId: root.id });
  };
}

/**
 * `label.delete` of a label ENG-1 carries (PLAN-010 S5): the rules run over a `LabelAccess` on
 * `m`'s labels and issues. Its cascade stands in for `removeLabelFromIssues`: the repo's bulk path
 * locks each issue in `cascade` mode (no lifecycle check), then writes through `m.repo.updateWhere`
 * with `touchUpdatedAt: false`, so `m` records the mode, the write and the label removal.
 */
const labelDeleteCase: Case = async (m, issue) => {
  const label = m.addLabel({ name: 'Flaky', teamId: issue.teamId });
  m.issues.set(issue.id, { ...issue, labelIds: [label.id] });
  const access: LabelAccess = {
    lockWorkspace: () => Promise.resolve(),
    lockTeam: (id) => Promise.resolve(id === m.eng.id ? { id, key: 'ENG' } : undefined),
    scopeLabels: (teamId) =>
      Promise.resolve([...m.labels.values()].filter((l) => l.teamId === teamId)),
    lockLabel: (id) => Promise.resolve(m.labels.get(id)),
    shareLabel: (id) => Promise.resolve(m.labels.get(id)),
    async removeFromIssues(labelId) {
      const ids = [...m.issues.values()]
        .filter((row) => row.labelIds.includes(labelId))
        .map((row) => row.id)
        .sort();
      for (let n = 0; n < ids.length; n++) {
        m.calls.push('lockIssue');
        m.lockModes.push('cascade');
      }
      if (ids.length === 0) return [];
      await m.repo.updateWhere('Issue', ids, { labelIds: [] }, { touchUpdatedAt: false });
      for (const id of ids) {
        const row = m.issues.get(id);
        if (row) m.issues.set(id, { ...row, labelIds: row.labelIds.filter((l) => l !== labelId) });
      }
      return ids;
    },
    visibleIssueCount: (ids) => Promise.resolve(ids.length),
  };
  const repo: Repo = {
    ...m.repo,
    purge: (model, id) => {
      m.labels.delete(id);
      return Promise.resolve();
    },
  };
  return deleteLabel(access, repo, { label: { id: label.id, teamId: label.teamId } });
};

/**
 * An attachment rule run on `issue` (PLAN-014 S4a): Ada's unclaimed upload, and a file attachment
 * of the issue whose file has a preview. The issue lock goes through `m`'s access, so `m` records
 * its mode; each Attachment write lands in `m.writes` and `m.calls`.
 */
function attachmentCase(
  rule: (
    ctx: AttachmentWriteContext,
    t: AttachmentTarget & { readonly upload: string; readonly preview: string },
  ) => Promise<unknown>,
): Case {
  return (m, issue) => {
    const a = memoryAttachments(m);
    const upload = a.addFile({ id: attachmentId() });
    const attached = a.addFile({ id: attachmentId(), issueId: issue.id });
    const preview = a.addFile({ id: attachmentId(), purpose: 'preview', previewOf: attached.id });
    const row = a.addAttachment({
      issueId: issue.id,
      kind: 'file',
      url: null,
      fileId: attached.id,
    });
    return rule(a.ctx(), {
      attachmentId: row.id,
      issueId: issue.id,
      ref: row.id,
      upload: upload.id,
      preview: preview.id,
    });
  };
}

/**
 * `files-cleanup` on an attachment file of `issue` detached a day ago: the job deletes it whatever
 * the issue's state, takes no issue lock and writes no issue row (SPEC-014 §4.6). Its delete is
 * recorded in `m.writes` so the table reads it as the cascade's "applies, keeps state".
 */
const filesCleanupCase: Case = async (m, issue) => {
  const db = new ModelDb();
  const blobs = modelBlobStore(db);
  const id = attachmentId();
  const temp = await blobs.putStream(body('bytes'));
  await db.transaction((tx) =>
    insertUpload(tx, blobs, temp, {
      id,
      purpose: 'attachment',
      name: 'notes.txt',
      mimeType: 'text/plain',
      size: temp.size,
      uploaderId: ADA_ID,
      issueId: issue.id,
    }),
  );
  await db.modelTransaction((tx) => tx.detach(id));
  db.clock += 25 * MODEL_HOUR;
  const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const counts = await cleanupFiles({ db, blobs, log: quiet, now: () => new Date(db.clock) });
  if (counts.detached === 1 && !db.rows.has(id)) {
    m.writes.push({ action: 'purge', model: 'table:files', ids: [id], fields: [] });
  }
};

const commentBody = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Looks good' }] }],
};

/** One case per built row: the handler's own rules, as its handler calls them. */
const CASES: Readonly<Record<string, Case>> = {
  'issue.update': (m, issue) =>
    updateIssue(m.ctx, {
      issueId: issue.id,
      teamId: issue.teamId,
      title: 'Fix the login',
      addLabelIds: [],
      removeLabelIds: [],
    }),
  // PLAN-011 S6: a save from the version the issue was created with.
  'issue.updateDescription': (m, issue) =>
    updateDescription(m.ctx, { issueId: issue.id, baseVersion: 1, description: commentBody }),
  'issue.delete': (m, issue, now) => deleteIssue(m.lifecycle({ now }), issue.id),
  'issue.restore': (m, issue, now) => restoreIssue(m.lifecycle({ now }), issue.id),
  // PLAN-015 S2. The purge steps are `purge-steps.test.ts`'s; here, the issue's own rule.
  'issue.purge': (m, issue, now) => purgeIssue(m.purge({ now }), issue.id),
  // The job runs `issue.purge` for each issue it selects, as the system actor (§6.3); it selects
  // a deleted issue only once it is due, so it runs then (D20).
  'trash-purge': (m, issue, now) => {
    const due = issue.deletedAt === null ? now : purgeAfter(issue.deletedAt);
    const at = due.getTime() > now.getTime() ? due : now;
    return purgeIssue(m.purge({ actor: systemActor(), now: at }), issue.id);
  },
  // PLAN-015 S3: the jobs' operations, as the system actor, on an issue due under a 1-month period
  // (closed 2026-10-01 for the archive; open and last updated then for the close). A job counts the
  // CONFLICT of a row listed `skipped` as skipped.
  'issue.autoArchive': (m, issue, now) => {
    m.issues.set(issue.id, {
      ...issue,
      statusId: m.status(m.eng, 'Done').id,
      completedAt: EARLIER,
    });
    const auto = memoryAuto(m, { now, settings: { autoArchiveMonths: 1 } });
    return autoArchiveIssue(auto.ctx, { issueId: issue.id, teamId: issue.teamId });
  },
  'issue.autoClose': (m, issue, now) => {
    const auto = memoryAuto(m, { now, settings: { autoCloseMonths: 1 } });
    return autoCloseIssue(auto.ctx, { issueId: issue.id, teamId: issue.teamId });
  },
  'comment.create': commentCase((ctx, t) =>
    createComment(ctx, { id: randomUUID(), issueId: t.issueId, body: commentBody }),
  ),
  'comment.update': commentCase((ctx, t) =>
    updateComment(ctx, { ...t, baseVersion: 1, body: commentBody }),
  ),
  // The root has a reply, so this is a soft delete: an update.
  'comment.delete': commentCase((ctx, t) => deleteComment(ctx, t)),
  'comment.resolve': commentCase((ctx, t) => setThreadResolved(ctx, t, true)),
  'comment.reopen': commentCase((ctx, t) => setThreadResolved(ctx, t, false), { resolved: true }),
  // PLAN-013 S4: a reaction on the thread's root; the issue's own reaction is in reaction-set.test.ts.
  'reaction.set': commentCase((ctx, t) =>
    setReaction(ctx, { subject: { kind: 'comment', target: t }, emoji: '👍', reacted: true }),
  ),
  'label.delete': labelDeleteCase,
  // PLAN-014 S4a.
  'attachment.createFile': attachmentCase((ctx, t) =>
    createFileAttachment(ctx, {
      id: attachmentId(),
      issueId: t.issueId,
      fileRef: t.upload,
      fileId: t.upload,
      title: undefined,
      creatorId: ADA_ID,
    }),
  ),
  'attachment.createLink': attachmentCase((ctx, t) =>
    createLinkAttachment(ctx, {
      id: attachmentId(),
      issueId: t.issueId,
      url: 'https://example.com/spec',
      title: undefined,
      creatorId: ADA_ID,
    }),
  ),
  'attachment.update': attachmentCase((ctx, t) => renameAttachment(ctx, t, 'Login spec')),
  'attachment.delete': attachmentCase((ctx, t) => deleteAttachment(ctx, t)),
  'attachment.setPreview': attachmentCase((ctx, t) => setAttachmentPreview(ctx, t, t.preview)),
  'files-cleanup': filesCleanupCase,
};

/**
 * Rows that take no issue lock at all: `files-cleanup` locks only `files` rows (SPEC-014 §4.5),
 * so the issue's state can't refuse it. Its case checks that it ran and the issue stayed as it was.
 */
const NO_ISSUE_LOCK = new Set(['files-cleanup']);

/** What happened, in the table's words. */
function outcome(
  before: IssueRow,
  after: IssueRow | undefined,
  error: unknown,
  wrote: boolean,
): LifecycleOutcome | 'error' {
  if (error instanceof SurfaceError && error.code === 'CONFLICT') return 'conflict';
  if (error !== undefined) return 'error';
  if (after === undefined) return 'toPurged';
  if (!wrote) return 'noop';
  const state = (row: IssueRow): IssueLifecycle =>
    row.deletedAt !== null ? 'deleted' : row.archivedAt !== null ? 'archived' : 'live';
  // A write that leaves an archived or deleted issue as it was is a cascade's (§4.3 keepsState).
  if (state(after) === state(before)) return state(before) === 'live' ? 'applies' : 'keepsState';
  return state(after) === 'live'
    ? 'toLive'
    : state(after) === 'deleted'
      ? 'toDeleted'
      : 'toArchived';
}

async function run(name: string, state: IssueLifecycle, now = NOW) {
  const { m, issue } = await issueIn(state);
  const cases = CASES[name];
  if (cases === undefined) throw new Error(`no case for ${name}`);
  let error: unknown;
  await cases(m, issue, now).catch((e: unknown) => {
    error = e;
  });
  const wrote = m.writes.length > 0;
  return { m, issue, error, result: outcome(issue, m.issues.get(issue.id), error, wrote) };
}

const rows = Object.entries(ISSUE_LIFECYCLE_RULES);
const built = rows.filter(([, rule]) => rule.pending === undefined);

describe('the lifecycle rule table, row by row (AC-1, AC-2)', () => {
  it('lists every row whose handler is not built yet as pending, with the slice that adds it', () => {
    const pending = Object.fromEntries(
      rows.flatMap(([name, rule]) => (rule.pending === undefined ? [] : [[name, rule.pending]])),
    );
    expect(pending).toEqual({});
  });

  it('has a case for every built row, and each names a registered operation with a handler', () => {
    const handled = new Set(HANDLERS.map((h) => h.op.name));
    for (const [name, rule] of built) {
      expect(CASES[name], `${name} is built but has no case here`).toBeDefined();
      if (rule.kind === 'operation') expect(handled.has(name), name).toBe(true);
    }
  });

  it('has a row for every mutation that names an issue', () => {
    const named = ALL_OPERATIONS.filter((op) => {
      if (op.kind !== 'mutation' || !(op.input instanceof z.ZodObject)) return false;
      return Object.keys(op.input.shape).includes('issue');
    }).map((op) => op.name);
    expect(named.length).toBeGreaterThan(0);
    for (const name of named) expect(ISSUE_LIFECYCLE_RULES[name], name).toBeDefined();
  });

  describe.each(built)('%s', (name, rule) => {
    it.each(ISSUE_LIFECYCLES)(
      'locks in its mode before any write and gives the listed result on a %s issue',
      async (state) => {
        const { m, result } = await run(name, state);
        if (NO_ISSUE_LOCK.has(name)) expect(m.lockModes).toEqual([]);
        else expect(m.lockModes[0]).toBe(rule.mode);
        const firstWrite = m.calls.findIndex((c) => c.startsWith('write:'));
        if (firstWrite >= 0) expect(m.calls.indexOf('lockIssue')).toBeLessThan(firstWrite);
        const listed = rule[state];
        // Before purgeAfter (now) a deleted issue is restored; the boundary case follows.
        // A job counts a CONFLICT as `skipped` (§4.3); a purge's date check reads the same.
        const expected =
          listed === 'toLiveBeforePurgeAfter'
            ? 'toLive'
            : listed === 'skipped'
              ? 'conflict'
              : // The table's "applies (live issues only)" for the archive is the move to Archived.
                name === 'issue.autoArchive' && listed === 'applies'
                ? 'toArchived'
                : listed;
        expect(result).toBe(expected);
        if (result === 'conflict' || result === 'noop') {
          expect(m.writes).toEqual([]);
          expect(m.events).toEqual([]);
          expect(m.history).toEqual([]);
          expect(m.audits).toEqual([]);
        }
      },
    );
  });

  it('restores a deleted issue only before purgeAfter', async () => {
    const at = await run('issue.restore', 'deleted', purgeAfter(DELETED_AT));
    expect(at.result).toBe('conflict');
  });

  it.each([
    ['archived', 'ENG-1 is archived. Restore it to edit it.'],
    ['deleted', 'ENG-1 was deleted. Restore it to edit it.'],
  ] as const)(
    'refuses a direct edit of a %s issue with the §4.2 wording (AC-2)',
    async (state, message) => {
      const { error } = await run('issue.update', state);
      expect(error).toBeInstanceOf(SurfaceError);
      expect(error instanceof SurfaceError && error.message).toBe(message);
    },
  );

  // PLAN-015 S5 edge sweep: E2's comment typed while the job archives the issue, and E17's
  // reaction on an archived issue's comment, get the same wording and write nothing.
  it.each([
    ['comment.create', 'a comment on an archived issue (E2)'],
    ['reaction.set', 'a reaction to a comment on an archived issue (E17)'],
  ] as const)('refuses %s: %s, with the §4.2 wording', async (name, _what) => {
    const { m, error } = await run(name, 'archived');
    expect(error).toBeInstanceOf(SurfaceError);
    expect(error instanceof SurfaceError && error.code).toBe('CONFLICT');
    expect(error instanceof SurfaceError && error.message).toBe(
      'ENG-1 is archived. Restore it to edit it.',
    );
    expect(m.writes).toEqual([]);
  });
});

/**
 * Cascade rows whose handler locks one issue row itself (`lockIssueForWrite` in `cascade` mode)
 * rather than through the repo's bulk path: they get the lock-first check of the edit rows.
 */
const ROW_LOCK_CASCADES = new Set(['attachment.setPreview']);

describe('each built row’s registered handler locks the issue first (AC-1, SPEC-011 §4.8)', () => {
  it('has a handler input for every built operation row', () => {
    for (const [name, rule] of built) {
      if (rule.kind === 'operation' && !OWN_SQL_TEST.has(name)) {
        expect(HANDLER_INPUTS[name], name).toBeDefined();
      }
    }
  });

  describe.each(
    built.filter(
      ([name, rule]) =>
        rule.kind === 'operation' &&
        (rule.mode !== 'cascade' || ROW_LOCK_CASCADES.has(name)) &&
        !OWN_SQL_TEST.has(name),
    ),
  )('%s', (name) => {
    it.each(ISSUE_LIFECYCLES)(
      'takes the issue row lock before reading the issue otherwise or writing (%s issue)',
      async (state) => {
        const statements = await runHandler(name, state);
        const texts = statements.map((statement) => statement.text);
        const lock = texts.findIndex((text) => text.includes('from "issues"'));
        expect(lock, texts.join('\n')).toBeGreaterThanOrEqual(0);
        expect(texts[lock]).toMatch(/^select .* from "issues" where .* for update$/);
        const firstWrite = texts.findIndex((text) => text.startsWith('repo.'));
        if (firstWrite >= 0) expect(lock).toBeLessThan(firstWrite);
      },
    );
  });

  // A cascade row's handler locks the issues in the repo's bulk path (`updateWhere` locks them in
  // ascending id, SPEC-011 §5.1), after the scope and label rows; its plain read of the ids comes
  // first, under the label lock, which makes that set final (SPEC-010 §4.4).
  describe.each(
    built.filter(
      ([name, rule]) =>
        rule.kind === 'operation' && rule.mode === 'cascade' && !ROW_LOCK_CASCADES.has(name),
    ),
  )('%s', (name) => {
    it.each(ISSUE_LIFECYCLES)(
      'writes issues only through updateWhere, after its row locks (%s issue)',
      async (state) => {
        const statements = await runHandler(name, state);
        const texts = statements.map((statement) => statement.text);
        const read = texts.findIndex((text) => text.includes('from "issues"'));
        const lastLock = texts.reduce(
          (at, text, i) => (text.endsWith(' for update') && !text.includes('"issues"') ? i : at),
          -1,
        );
        expect(lastLock, texts.join('\n')).toBeGreaterThanOrEqual(0);
        expect(read).toBeGreaterThan(lastLock);
        expect(texts[read]).not.toMatch(/archived_at|deleted_at/);
        const writes = texts.filter((text) => text.startsWith('repo.'));
        expect(writes).toContain('repo.updateWhere');
        expect(writes).not.toContain('repo.update');
        expect(texts.indexOf('repo.updateWhere')).toBeGreaterThan(read);
      },
    );
  });
});

describe('cascades write archived and deleted issues and keep their state (AC-2, E11)', () => {
  it('a label removal through updateWhere leaves lifecycle and updatedAt alone', async () => {
    const LABEL = '0190f0c0-0000-7000-8000-0000000000b1';
    const OTHER = '0190f0c0-0000-7000-8000-0000000000b2';
    const row = (id: string, archivedAt: Date | null, deletedAt: Date | null) => ({
      id,
      label_ids: [LABEL, OTHER],
      archived_at: archivedAt,
      deleted_at: deletedAt,
      updated_at: EARLIER,
      sync_groups: ['team:eng'],
    });
    const ARCHIVED = '0190f0c0-0000-7000-8000-000000000001';
    const DELETED = '0190f0c0-0000-7000-8000-000000000002';
    const { repo, rowsOf } = scriptedDb(
      { issues: [row(ARCHIVED, EARLIER, null), row(DELETED, null, DELETED_AT)] },
      { now: NOW },
    );
    // `label.delete`'s cascade (`removeLabelFromIssues`) computes the array in SQL; the stand-in
    // database here takes a plain value, which is all the lifecycle rule is about.
    await repo.updateWhere(
      'Issue',
      [ARCHIVED, DELETED],
      { labelIds: [OTHER] },
      {
        touchUpdatedAt: false,
      },
    );
    expect(rowsOf('issues').get(ARCHIVED)).toMatchObject({
      // Drizzle sends the array as a Postgres array literal.
      label_ids: `{"${OTHER}"}`,
      archived_at: EARLIER,
      deleted_at: null,
      updated_at: EARLIER,
    });
    expect(rowsOf('issues').get(DELETED)).toMatchObject({
      label_ids: `{"${OTHER}"}`,
      archived_at: null,
      deleted_at: DELETED_AT,
      updated_at: EARLIER,
    });
    expect(repo.changes().map((c) => [c.action, c.id])).toEqual([
      ['U', ARCHIVED],
      ['U', DELETED],
    ]);
  });
});
