// PLAN-013 S3, SPEC-013 §4.3 and SPEC-015 §4.5 (AC-4 for comments): the comment purge steps delete
// one issue's reactions, then its comments, then their search text, unlogged (ADR-0022). The
// registry runs on a recording repo and a recording connection; PLAN-015 S2's purge runs them on
// Postgres.
import { describe, expect, it } from 'vitest';
import {
  COMMENT_PURGE_STEPS,
  LOG_CONTENT_DELETES,
  PURGE_STEPS,
} from '../src/issues/purge-steps.js';
import type { Repo } from '../src/sync/repo.js';
import { recordingDb } from './support/scripted-db.js';

const ISSUE = '0190f0c0-0000-7000-8000-000000000042';

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
      log.push(`${model}.${field} in [${ids.join(',')}] log=${String(options?.log ?? true)}`);
      return Promise.resolve([]);
    },
    changes: () => [],
  };
}

describe('comment purge steps', () => {
  it('delete reactions, then comments, then search text, for one issue, unlogged', async () => {
    const log: string[] = [];
    const { db, statements } = recordingDb();
    const repo = recordingRepo(log);
    for (const step of COMMENT_PURGE_STEPS) {
      await step.step(db, repo, ISSUE);
      for (const s of statements.splice(0)) log.push(`sql: ${s.text} ${JSON.stringify(s.params)}`);
    }
    expect(COMMENT_PURGE_STEPS.map((s) => s.model)).toEqual([
      'Reaction',
      'Comment',
      'table:comment_search_text',
    ]);
    expect(log).toEqual([
      `Reaction.issueId in [${ISSUE}] log=false`,
      `Comment.issueId in [${ISSUE}] log=false`,
      expect.stringMatching(
        new RegExp(
          `^sql: DELETE FROM comment_search_text .*c\\.issue_id = \\$1.*\\["${ISSUE}"\\]$`,
          's',
        ),
      ),
    ]);
  });

  it('are registered, and content deletes are never logged (ADR-0022)', () => {
    expect(LOG_CONTENT_DELETES).toBe(false);
    for (const step of COMMENT_PURGE_STEPS) expect(PURGE_STEPS).toContain(step);
  });
});
