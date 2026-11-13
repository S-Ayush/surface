// PLAN-013 S3, SPEC-013 §4.3 and SPEC-015 §4.5 (AC-4 for comments): the comment purge steps delete
// one issue's reactions, then its comments' search text, then its comments, replies before roots,
// unlogged (ADR-0022). The registry runs on a recording repo and a recording connection, and the
// comment step on the real repo over scripted tables that enforce the reply's RESTRICT key, with
// chunks small enough to split a thread. PLAN-015 S2's purge runs them on Postgres.
import { describe, expect, it } from 'vitest';
import {
  COMMENT_PURGE_STEPS,
  LOG_CONTENT_DELETES,
  PURGE_STEPS,
} from '../src/issues/purge-steps.js';
import type { Repo } from '../src/sync/repo.js';
import { recordingDb, scriptedDb, type Row } from './support/scripted-db.js';

const ISSUE = '0190f0c0-0000-7000-8000-000000000042';
const NOW = new Date('2026-11-13T10:00:00.000Z');

function recordingRepo(log: string[]): Repo {
  const refuse = () => Promise.reject(new Error('a purge step only deletes'));
  return {
    insert: refuse,
    update: refuse,
    archive: refuse,
    unarchive: refuse,
    purge: refuse,
    updateWhere: refuse,
    deleteWhere(model, field, ids, options) {
      const first = options?.childrenFirst === undefined ? '' : ` first=${options.childrenFirst}`;
      log.push(
        `${model}.${field} in [${ids.join(',')}] log=${String(options?.log ?? true)}${first}`,
      );
      return Promise.resolve([]);
    },
    changes: () => [],
  };
}

describe('comment purge steps', () => {
  it('delete reactions, then search text, then comments replies first, for one issue, unlogged', async () => {
    const log: string[] = [];
    const { db, statements } = recordingDb();
    const repo = recordingRepo(log);
    for (const step of COMMENT_PURGE_STEPS) {
      await step.step(db, repo, ISSUE);
      for (const s of statements.splice(0)) log.push(`sql: ${s.text} ${JSON.stringify(s.params)}`);
    }
    expect(COMMENT_PURGE_STEPS.map((s) => s.model)).toEqual([
      'Reaction',
      'table:comment_search_text',
      'Comment',
    ]);
    expect(log).toEqual([
      `Reaction.issueId in [${ISSUE}] log=false`,
      expect.stringMatching(
        new RegExp(
          `^sql: DELETE FROM comment_search_text .*c\\.issue_id = \\$1.*\\["${ISSUE}"\\]$`,
          's',
        ),
      ),
      `Comment.issueId in [${ISSUE}] log=false first=parentCommentId`,
    ]);
  });

  it('are registered, and content deletes are never logged (ADR-0022)', () => {
    expect(LOG_CONTENT_DELETES).toBe(false);
    for (const step of COMMENT_PURGE_STEPS) expect(PURGE_STEPS).toContain(step);
  });
});

describe('the comment step across a chunk boundary', () => {
  const id = (n: number) => `0190f0c0-0000-7000-8000-${String(n).padStart(12, '0')}`;
  // In ascending id, chunks of two put root 1 with root 2 and its reply 3 in the next chunk.
  const comment = (n: number, parent: number | null): Row => ({
    id: id(n),
    issue_id: ISSUE,
    parent_comment_id: parent === null ? null : id(parent),
    sync_groups: ['team:x'],
  });
  const thread = () => ({ comments: [comment(1, null), comment(2, null), comment(3, 1)] });
  const db = () =>
    scriptedDb(thread(), {
      now: NOW,
      deleteChunkSize: 2,
      restrict: [{ table: 'comments', column: 'parent_comment_id' }],
    });
  const commentStep = COMMENT_PURGE_STEPS.find((s) => s.model === 'Comment');

  it('deletes a reply in a chunk before its root’s, so the RESTRICT key holds', async () => {
    const { db: tx, repo, rowsOf, statements } = db();
    await commentStep?.step(tx, repo, ISSUE);
    expect(rowsOf('comments').size).toBe(0);
    const deletes = statements.filter((s) => s.text.startsWith('delete from "comments"'));
    expect(deletes.map((s) => s.params[0])).toEqual([[id(3), id(1)], [id(2)]]);
  });

  it('would fail in ascending id: the root goes in the first chunk, its reply in the second', async () => {
    const { repo } = db();
    const failed: unknown = await repo
      .deleteWhere('Comment', 'issueId', [ISSUE], { log: LOG_CONTENT_DELETES })
      .catch((error: unknown) => error);
    // Drizzle wraps the connection's error as the cause of its "Failed query".
    expect(failed).toMatchObject({
      cause: {
        message: expect.stringContaining(
          `violates a RESTRICT key from "parent_comment_id" of ${id(3)}`,
        ) as unknown,
      },
    });
  });
});
