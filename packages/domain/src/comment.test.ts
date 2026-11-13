// PLAN-013 S3, SPEC-013 §4.5: the comment and reaction invariants (INV-19, resolved fields set
// together, issueId and teamId equalities), the reply-parent rule of §4.3 and the delete plan.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  COMMENT_MESSAGES,
  commentBodyBytes,
  commentDeletePlan,
  commentInvariantProblems,
  reactionInvariantProblems,
  replyParentProblem,
  threadRootId,
  type CommentFacts,
} from './comment.js';
import { EMPTY_DOC } from './doc.js';

const TEAM = 'team-eng';
const ISSUE = 'issue-1';

const comment = (fields: Partial<CommentFacts> = {}): CommentFacts => ({
  id: 'c1',
  issueId: ISSUE,
  teamId: TEAM,
  parentCommentId: null,
  deletedAt: null,
  resolvedAt: null,
  resolvedById: null,
  ...fields,
});

describe('comment invariants (§4.5)', () => {
  it('hold for a top-level comment, a resolved one and a reply', () => {
    expect(commentInvariantProblems(comment(), { issueTeamId: TEAM })).toEqual([]);
    expect(
      commentInvariantProblems(
        comment({ resolvedAt: '2026-11-13T10:00:00Z', resolvedById: 'u1' }),
        {
          issueTeamId: TEAM,
        },
      ),
    ).toEqual([]);
    const root = comment();
    expect(
      commentInvariantProblems(comment({ id: 'c2', parentCommentId: 'c1' }), {
        parent: root,
        issueTeamId: TEAM,
      }),
    ).toEqual([]);
  });

  it("flag a teamId that isn't the issue's, and resolved fields set apart", () => {
    expect(
      commentInvariantProblems(comment({ teamId: 'team-des' }), { issueTeamId: TEAM }),
    ).toEqual(["A comment's teamId must equal its issue's teamId."]);
    expect(
      commentInvariantProblems(comment({ resolvedAt: new Date() }), { issueTeamId: TEAM }),
    ).toEqual(['resolvedAt and resolvedById are set together.']);
    expect(
      commentInvariantProblems(comment({ resolvedById: 'u1' }), { issueTeamId: TEAM }),
    ).toEqual(['resolvedAt and resolvedById are set together.']);
  });

  it('flag a reply to a reply (INV-19), across issues, resolved, or without its parent', () => {
    const reply = comment({ id: 'c2', parentCommentId: 'c1' });
    expect(
      commentInvariantProblems(comment({ id: 'c3', parentCommentId: 'c2' }), {
        parent: reply,
        issueTeamId: TEAM,
      }),
    ).toEqual(['Replies are one level deep (INV-19).']);
    expect(
      commentInvariantProblems(reply, {
        parent: comment({ issueId: 'issue-2' }),
        issueTeamId: TEAM,
      }),
    ).toEqual(["A reply's issueId must equal its parent's issueId."]);
    expect(
      commentInvariantProblems(comment({ ...reply, resolvedAt: new Date(), resolvedById: 'u1' }), {
        parent: comment(),
        issueTeamId: TEAM,
      }),
    ).toEqual(['Only a top-level comment is resolved.']);
    expect(commentInvariantProblems(reply, { issueTeamId: TEAM })).toEqual([
      "A reply's parent must exist.",
    ]);
  });
});

describe('reaction invariants (§4.5)', () => {
  const reaction = { issueId: ISSUE, teamId: TEAM, commentId: 'c1' };

  it('hold on a comment of the same issue, and on the issue itself', () => {
    expect(reactionInvariantProblems(reaction, { comment: comment(), issueTeamId: TEAM })).toEqual(
      [],
    );
    expect(
      reactionInvariantProblems({ ...reaction, commentId: null }, { issueTeamId: TEAM }),
    ).toEqual([]);
  });

  it('flag another team, another issue, or a missing comment', () => {
    expect(
      reactionInvariantProblems(
        { ...reaction, teamId: 'team-des' },
        { comment: comment(), issueTeamId: TEAM },
      ),
    ).toEqual(["A reaction's teamId must equal its issue's teamId."]);
    expect(
      reactionInvariantProblems(reaction, {
        comment: comment({ issueId: 'issue-2' }),
        issueTeamId: TEAM,
      }),
    ).toEqual(["A reaction's issueId must equal its comment's issueId."]);
    expect(reactionInvariantProblems(reaction, { issueTeamId: TEAM })).toEqual([
      "A reaction's comment must exist.",
    ]);
  });
});

describe('replyParentProblem (§4.3, §6.3)', () => {
  it('accepts a live top-level comment of the same issue', () => {
    expect(replyParentProblem(comment(), ISSUE)).toBeUndefined();
  });

  it('refuses another issue, a reply and a placeholder, with the §6.3 sentences', () => {
    expect(replyParentProblem(comment(), 'issue-2')).toBe(COMMENT_MESSAGES.replyOtherIssue);
    expect(replyParentProblem(comment({ parentCommentId: 'c0' }), ISSUE)).toBe(
      COMMENT_MESSAGES.replyToReply,
    );
    expect(replyParentProblem(comment({ deletedAt: '2026-11-13T10:00:00Z' }), ISSUE)).toBe(
      COMMENT_MESSAGES.replyToDeleted,
    );
  });

  it('never accepts a parent that would break INV-19 (property)', () => {
    fc.assert(
      fc.property(
        fc.option(fc.constantFrom('c0', 'c9'), { nil: null }),
        fc.option(fc.constant('2026-11-13T10:00:00Z'), { nil: null }),
        fc.constantFrom(ISSUE, 'issue-2'),
        (parentCommentId, deletedAt, issueId) => {
          const ok =
            replyParentProblem(comment({ parentCommentId, deletedAt }), issueId) === undefined;
          expect(ok).toBe(parentCommentId === null && deletedAt === null && issueId === ISSUE);
        },
      ),
      { seed: 13, numRuns: 100 },
    );
  });
});

describe('commentDeletePlan (§4.3)', () => {
  it('is hard without replies and soft with replies', () => {
    expect(commentDeletePlan(comment(), [])).toEqual({ mode: 'hard', alsoParent: undefined });
    expect(commentDeletePlan(comment(), ['c2'])).toEqual({ mode: 'soft', alsoParent: undefined });
  });

  it('takes a placeholder parent with its last reply, and keeps a live parent', () => {
    const reply = comment({ id: 'c2', parentCommentId: 'c1' });
    const placeholder = { id: 'c1', deletedAt: '2026-11-13T10:00:00Z', replyIds: ['c2'] };
    expect(commentDeletePlan(reply, [], placeholder)).toEqual({ mode: 'hard', alsoParent: 'c1' });
    expect(commentDeletePlan(reply, [], { ...placeholder, replyIds: ['c2', 'c3'] })).toEqual({
      mode: 'hard',
      alsoParent: undefined,
    });
    expect(commentDeletePlan(reply, [], { ...placeholder, deletedAt: null })).toEqual({
      mode: 'hard',
      alsoParent: undefined,
    });
  });
});

describe('helpers', () => {
  it('threadRootId is the parent for a reply and the comment itself otherwise', () => {
    expect(threadRootId(comment())).toBe('c1');
    expect(threadRootId(comment({ id: 'c2', parentCommentId: 'c1' }))).toBe('c1');
  });

  it('commentBodyBytes measures Markdown as UTF-8 and a document as its JSON', () => {
    expect(commentBodyBytes('é👍')).toBe(6);
    expect(commentBodyBytes(EMPTY_DOC)).toBe(JSON.stringify(EMPTY_DOC).length);
  });
});
