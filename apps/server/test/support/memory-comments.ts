/**
 * An in-memory issue thread store for the comment rules (`handlers/comments/core.ts`): the access
 * they read and lock through, a repo that records each write as the `sync_log` row it would log,
 * the server-only search text, and the events. Every read and lock is logged in order, so a test
 * can read the lock order (SPEC-013 §4.3). One issue, ENG-42, on a public team; issues can be
 * added, archived or deleted per test.
 */
import { randomUUID } from 'node:crypto';
import {
  issueIdentifier,
  lifecycleOf,
  reactionId,
  lifecycleRefusal,
  lockRefusal,
  type IssueLockMode,
  teamGroup,
  type CommentActorKind,
  type Actor,
  type DocNodeJSON,
} from '@surface/domain';
import type { DomainEvent } from '../../src/executor/context.js';
import { SurfaceError } from '../../src/executor/errors.js';
import { refNotFound } from '../../src/executor/refs/sources.js';
import type {
  CommentAccess,
  CommentAuthor,
  CommentRow,
  CommentWriteContext,
  ReactionRow,
} from '../../src/handlers/comments/core.js';
import { claimInlineFiles } from '../../src/files/claim.js';
import type { LockedIssue } from '../../src/issues/lifecycle.js';
import type { Repo, RowChange } from '../../src/sync/repo.js';
import { recordingDb } from './scripted-db.js';

export const NOW = new Date('2026-11-13T10:00:00.000Z');
export const ADA = '0192f0c1-7e5a-7b3c-9d4e-0000000000ad';
export const IRIS = '0192f0c1-7e5a-7b3c-9d4e-00000000001e';
export const TEAM = '0192f0c1-7e5a-7b3c-9d4e-0000000000e1';

export interface MemoryIssue {
  readonly id: string;
  readonly teamId: string;
  readonly number: number;
  archivedAt: Date | null;
  deletedAt: Date | null;
}

/** A stored reaction (PLAN-013 S4: `reaction.set` writes them, `addReaction` seeds them). */
export type MemoryReaction = ReactionRow;

/** A write as the repo would log it: `I`/`U`/`D` per row, in order. */
export interface LoggedWrite {
  readonly action: RowChange['action'];
  readonly model: string;
  readonly id: string;
  readonly groups: readonly string[];
}

export interface MemoryComments {
  readonly issue: MemoryIssue;
  readonly issues: Map<string, MemoryIssue>;
  readonly comments: Map<string, CommentRow>;
  readonly reactions: Map<string, MemoryReaction>;
  readonly searchText: Map<string, string>;
  /** `lockIssue`, `lockComment:<id>`, `readComment:<id>`, `replyIds:<id>`, … in order. */
  readonly calls: string[];
  /** The mode of each `lockIssue`, in order. */
  readonly lockModes: IssueLockMode[];
  readonly writes: LoggedWrite[];
  readonly events: DomainEvent[];
  readonly repo: Repo;
  /** The write context, as `author` (default: Ada, a Member, through the web app). */
  ctx(author?: Partial<CommentAuthor>): CommentWriteContext;
  addIssue(number: number): MemoryIssue;
  /** Seeds a comment row as stored, without logging a write. */
  addComment(fields: Partial<CommentRow> & { readonly issueId?: string }): CommentRow;
  /** Seeds a reaction as stored, with its derived id (SPEC-013 §4.2), without logging a write. */
  addReaction(
    commentId: string | null,
    userId: string,
    emoji: string,
    issueId?: string,
  ): MemoryReaction;
  /** Forgets the calls, writes and events so far. */
  reset(): void;
}

const claimDb = recordingDb().db;
const claimActor: Actor = {
  kind: 'user',
  userId: ADA,
  role: 'member',
  groups: [],
  publicTeams: [TEAM],
  memberOf: [TEAM],
};

export function memoryComments(): MemoryComments {
  const issues = new Map<string, MemoryIssue>();
  const comments = new Map<string, CommentRow>();
  const reactions = new Map<string, MemoryReaction>();
  const searchText = new Map<string, string>();
  const calls: string[] = [];
  const lockModes: IssueLockMode[] = [];
  const writes: LoggedWrite[] = [];
  const events: DomainEvent[] = [];
  const groups = [teamGroup(TEAM)];

  function addIssue(number: number): MemoryIssue {
    const issue: MemoryIssue = {
      id: randomUUID(),
      teamId: TEAM,
      number,
      archivedAt: null,
      deletedAt: null,
    };
    issues.set(issue.id, issue);
    return issue;
  }
  const issue = addIssue(42);

  const access: CommentAccess = {
    lockIssue(issueId, mode) {
      calls.push('lockIssue');
      lockModes.push(mode);
      const found = issues.get(issueId);
      if (!found) return Promise.reject(refNotFound('IssueRef', issueId, ['issue']));
      const state = lifecycleOf(found);
      const refused = lockRefusal(mode, state);
      if (refused !== undefined) {
        const message = lifecycleRefusal(issueIdentifier('ENG', found.number), refused);
        return Promise.reject(new SurfaceError('CONFLICT', message));
      }
      // Only the fields the comment rules read; the rest of an Issue row is never touched here.
      return Promise.resolve({ ...found, state } as unknown as LockedIssue);
    },
    lockComment(commentId) {
      calls.push(`lockComment:${commentId}`);
      return Promise.resolve(comments.get(commentId));
    },
    readComment(commentId) {
      calls.push(`readComment:${commentId}`);
      return Promise.resolve(comments.get(commentId));
    },
    replyIds(rootId) {
      calls.push(`replyIds:${rootId}`);
      return Promise.resolve(
        [...comments.values()]
          .filter((c) => c.parentCommentId === rootId)
          .map((c) => c.id)
          .sort(),
      );
    },
    setSearchText(commentId, text) {
      if (text === null) searchText.delete(commentId);
      else searchText.set(commentId, text);
      return Promise.resolve();
    },
    // The real seam (`files/claim.ts`), over a connection that answers nothing: the stub reads no
    // row. When PLAN-014 S4b gives it a body, this fake needs the claim's tables.
    claimFiles(doc: DocNodeJSON, issue: LockedIssue) {
      calls.push('claimFiles');
      return claimInlineFiles(claimDb, doc, issue, claimActor);
    },
    reactionsOn(issueId, commentId) {
      calls.push(`reactionsOn:${commentId ?? issueId}`);
      return Promise.resolve(
        [...reactions.values()]
          .filter((r) => r.issueId === issueId && r.commentId === commentId)
          .sort((a, b) => a.id.localeCompare(b.id)),
      );
    },
  };

  const log = (action: RowChange['action'], model: string, id: string) =>
    writes.push({ action, model, id, groups });

  const repo: Repo = {
    insert(model, values) {
      if (model === 'Reaction') {
        const parent = issues.get(String(Reflect.get(values, 'issueId')));
        // The generic insert type does not narrow on `model`; the rule under test passes a full row.
        const row = {
          ...values,
          teamId: parent?.teamId ?? TEAM,
          syncGroups: groups,
          createdAt: NOW,
        } as unknown as ReactionRow;
        // The primary key: the derived id is unique per (subject, user, emoji).
        if (reactions.has(row.id)) throw new Error(`reactions ${row.id} already exists`);
        reactions.set(row.id, row);
        log('I', model, row.id);
        return Promise.resolve(row as never);
      }
      if (model !== 'Comment') throw new Error(`unexpected insert into ${model}`);
      const parent = issues.get(String(Reflect.get(values, 'issueId')));
      const row = {
        ...values,
        teamId: parent?.teamId ?? TEAM,
        syncGroups: groups,
        createdAt: NOW,
        updatedAt: NOW,
        // The generic insert type does not narrow on `model`; the rule under test passes a full row.
      } as unknown as CommentRow;
      if (comments.has(row.id)) throw new SurfaceError('CONFLICT', 'Comment id already exists.');
      comments.set(row.id, row);
      log('I', model, row.id);
      return Promise.resolve(row as never);
    },
    update(model, id, patch) {
      const row = comments.get(id);
      if (model !== 'Comment' || !row) throw new SurfaceError('NOT_FOUND', 'not found');
      const next = { ...row, ...patch, updatedAt: NOW } as CommentRow;
      comments.set(id, next);
      log('U', model, id);
      return Promise.resolve(next as never);
    },
    purge(model, id) {
      if (model === 'Reaction') {
        if (!reactions.delete(id)) throw new SurfaceError('NOT_FOUND', `${model} ${id} not found.`);
        log('D', model, id);
        return Promise.resolve();
      }
      if (model !== 'Comment' || !comments.has(id)) {
        throw new SurfaceError('NOT_FOUND', `${model} ${id} not found.`);
      }
      // ON DELETE RESTRICT (SPEC-013 §4.3): a reply or a reaction still pointing here fails.
      const referenced =
        [...comments.values()].some((c) => c.parentCommentId === id) ||
        [...reactions.values()].some((r) => r.commentId === id);
      if (referenced) throw new Error(`comments ${id} is still referenced (RESTRICT)`);
      comments.delete(id);
      log('D', model, id);
      return Promise.resolve();
    },
    deleteWhere(model, field, ids, options = {}) {
      if (model !== 'Reaction' || field !== 'commentId') {
        throw new Error(`unexpected deleteWhere(${model}, ${field})`);
      }
      if (options.log === false) throw new Error('comment handlers log every delete');
      const deleted = [...reactions.values()]
        .filter((r) => r.commentId !== null && ids.includes(r.commentId))
        .map((r) => r.id)
        .sort();
      for (const id of deleted) {
        reactions.delete(id);
        log('D', model, id);
      }
      return Promise.resolve(deleted);
    },
    updateWhere: () => Promise.reject(new Error('comment rules never bulk-update')),
    archive: () => Promise.reject(new Error('comments are never archived')),
    unarchive: () => Promise.reject(new Error('comments are never archived')),
    changes: (): readonly RowChange[] => [],
  };

  return {
    issue,
    issues,
    comments,
    reactions,
    searchText,
    calls,
    lockModes,
    writes,
    events,
    repo,
    ctx(author = {}) {
      const who: CommentAuthor = {
        userId: ADA,
        actorKind: 'user' satisfies CommentActorKind,
        admin: false,
        ...author,
      };
      return { access, repo, emit: (event) => void events.push(event), now: NOW, author: who };
    },
    addIssue,
    addComment(fields) {
      const row: CommentRow = {
        id: randomUUID(),
        issueId: issue.id,
        teamId: TEAM,
        parentCommentId: null,
        userId: ADA,
        actorKind: 'user',
        body: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi' }] }],
        },
        version: 1,
        editedAt: null,
        deletedAt: null,
        resolvedAt: null,
        resolvedById: null,
        syncGroups: groups,
        createdAt: NOW,
        updatedAt: NOW,
        ...fields,
      };
      comments.set(row.id, row);
      searchText.set(row.id, 'Hi');
      return row;
    },
    addReaction(commentId, userId, emoji, issueId = issue.id) {
      const row: MemoryReaction = {
        id: reactionId(commentId ?? issueId, userId, emoji),
        issueId,
        teamId: TEAM,
        commentId,
        userId,
        emoji,
        syncGroups: groups,
        createdAt: NOW,
      };
      reactions.set(row.id, row);
      return row;
    },
    reset() {
      calls.length = 0;
      lockModes.length = 0;
      writes.length = 0;
      events.length = 0;
    },
  };
}
