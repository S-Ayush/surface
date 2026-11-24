// PLAN-011 S8 hardening (SPEC-011 §4.8, AC-20, AC-23): every handler that writes an issue or one
// of its children takes the issue row lock through `lockIssueForWrite`, in its lifecycle rule's
// mode, before any write, and takes no lock that comes earlier in the global order (workspace →
// team → status and label rows → issue rows → thread root comment) after it. The list of writers
// is built from the handler registry, not written by hand: a mutation of an issue domain (issue,
// comment with reactions, attachment, relation) or one whose input names an issue or a comment
// joins it as soon as its handler is registered. A mutation of a domain this file doesn't
// classify fails, so a new domain is decided here, once.
import { ISSUE_LIFECYCLE_RULES, issueLockModeOf, type RefType } from '@surface/domain';
import type { OperationDomain } from '@surface/operations';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { refPlan } from '../src/executor/refs/plan.js';
import { HANDLERS } from '../src/handlers/index.js';
import type * as Lifecycle from '../src/issues/lifecycle.js';
import { lockIssueForWrite } from '../src/issues/lifecycle.js';
import { HANDLER_INPUTS, OWN_SQL_TEST, runHandler } from './support/issue-handler-sql.js';

// The real lock, recorded: the SQL below shows what it did, the spy that the handler called it.
vi.mock('../src/issues/lifecycle.js', async (importOriginal) => {
  const real = await importOriginal<typeof Lifecycle>();
  return { ...real, lockIssueForWrite: vi.fn(real.lockIssueForWrite) };
});

/** Domains whose mutations write an issue or a child row of one (domain-model §7). */
const ISSUE_DOMAINS: ReadonlySet<OperationDomain> = new Set([
  'issue',
  'comment',
  'attachment',
  'relation',
]);
/**
 * Domains whose mutations write no issue row and no child row through an issue lock. `label`
 * cascades into issues (`label.delete`) in `cascade` mode through `repo.updateWhere`, which locks
 * them in ascending id after the label row: the lifecycle table test checks that path.
 */
const OTHER_DOMAINS: ReadonlySet<OperationDomain> = new Set([
  'workspace',
  'user',
  'invite',
  'team',
  'status',
  'label',
  'draft',
  'debug',
]);
/** References to an existing issue or child row: naming one in a mutation means writing under it. */
const ISSUE_REFS: ReadonlySet<RefType> = new Set(['IssueRef', 'CommentRef']);
/**
 * Writers that lock no existing issue row, with the reason. `issue.create` takes the team row, its
 * status and labels, then the counter, then inserts (§4.8); `issue-handlers.test.ts` checks it.
 */
const NO_ISSUE_ROW = new Set(['issue.create']);

const mutations = HANDLERS.filter((h) => h.op.kind === 'mutation');
const writers = mutations.filter(
  (h) =>
    !NO_ISSUE_ROW.has(h.op.name) &&
    (ISSUE_DOMAINS.has(h.op.domain) || refPlan(h.op).some((ref) => ISSUE_REFS.has(ref.type))),
);
/** A row lock on a row that comes before the issue rows in the global order (§4.8). */
const EARLIER_ROW_LOCK =
  /from "(workspace|teams|workflow_statuses|labels)".* for (update|no key update|share|key share)$/;

describe('the issue writers, from the handler registry', () => {
  it('classifies the domain of every registered mutation', () => {
    const unclassified = mutations
      .filter(({ op }) => !ISSUE_DOMAINS.has(op.domain) && !OTHER_DOMAINS.has(op.domain))
      .map(({ op }) => `${op.name} (${op.domain})`);
    expect(unclassified, 'Add the domain to ISSUE_DOMAINS or OTHER_DOMAINS').toEqual([]);
  });

  it('finds every operation of the lifecycle rule table that has a handler, and nothing else', () => {
    const names = writers.map((h) => h.op.name).sort();
    const operations = Object.entries(ISSUE_LIFECYCLE_RULES).filter(
      ([name, rule]) => rule.kind === 'operation' && HANDLERS.some((h) => h.op.name === name),
    );
    // Every writer has a rule; every edit or lifecycle rule is a writer. A cascade rule is one when
    // its handler locks the issue row itself (`attachment.setPreview`), not through the repo's
    // bulk path (`label.delete`, checked by the lifecycle table test).
    expect(names.filter((name) => ISSUE_LIFECYCLE_RULES[name] === undefined)).toEqual([]);
    const required = operations
      .filter(([, rule]) => rule.mode !== 'cascade')
      .map(([name]) => name)
      .sort();
    expect(names).toEqual(expect.arrayContaining(required));
    expect(names.filter((name) => !required.includes(name))).toEqual(['attachment.setPreview']);
    // What M1 has registered so far.
    expect(names).toEqual(
      expect.arrayContaining([
        'attachment.createFile',
        'attachment.createLink',
        'attachment.update',
        'attachment.delete',
        'attachment.setPreview',
        'issue.update',
        'issue.updateDescription',
        'issue.delete',
        'issue.restore',
        'issue.purge',
        'issue.autoArchive',
        'issue.autoClose',
        'comment.create',
        'comment.update',
        'comment.delete',
        'comment.resolve',
        'comment.reopen',
        'reaction.set',
      ]),
    );
  });

  it('has an input to run each writer with, or a test of its own on SQL', () => {
    for (const { op } of writers) {
      if (OWN_SQL_TEST.has(op.name)) continue;
      expect(HANDLER_INPUTS[op.name], `Add ${op.name} to HANDLER_INPUTS`).toBeDefined();
    }
  });
});

describe.each(writers.filter((h) => !OWN_SQL_TEST.has(h.op.name)).map((h) => h.op.name))(
  '%s',
  (name) => {
    beforeEach(() => {
      vi.mocked(lockIssueForWrite).mockClear();
    });

    it('calls lockIssueForWrite in its rule’s mode before any write, and locks no earlier row after it (§4.8)', async () => {
      const texts = (await runHandler(name, 'live')).map((s) => s.text);
      expect(vi.mocked(lockIssueForWrite).mock.calls.map((call) => call[3])).toEqual([
        issueLockModeOf(name),
      ]);
      const lock = texts.findIndex((text) => /from "issues" .* for update$/.test(text));
      expect(lock, texts.join('\n')).toBeGreaterThanOrEqual(0);
      const firstWrite = texts.findIndex((text) => text.startsWith('repo.'));
      if (firstWrite >= 0) expect(lock).toBeLessThan(firstWrite);
      const after = texts.slice(lock + 1).filter((text) => EARLIER_ROW_LOCK.test(text));
      expect(after, 'a team, status or label lock after the issue lock').toEqual([]);
    });
  },
);
