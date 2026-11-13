// Command-menu entries for the comment operations (SPEC-013 §6.1, SPEC-005 §4.1). Each opens the
// app command the comment UI registers (PLAN-013 S5): "Comment…" focuses the comment box of the
// open issue (`issue-page:comment`, the `Ctrl+M` command), and the comment-context entries act on
// the focused comment. Until S5 registers those handlers the commands are unavailable, so the
// menu doesn't offer the entries (`commands.isAvailable`).
import type { CommandContext } from '../../command-menu/model.js';
import type { OperationCommand } from '../../command-menu/sources/operations.js';

/** The focused issue, for the permission pre-check (anyone who sees it may comment). */
function targetIssueRefs({ target }: CommandContext) {
  const id = target.kind === 'issue' ? target.ids[0] : undefined;
  return id === undefined ? {} : { issue: { id } };
}

/** The focused comment. The author and Admin rules are the server's (SPEC-013 §5.2). */
function targetCommentRefs({ target }: CommandContext) {
  const id = target.kind === 'comment' ? target.ids[0] : undefined;
  return id === undefined ? {} : { comment: { id } };
}

export const COMMENT_COMMANDS: Readonly<Record<string, OperationCommand>> = {
  'comment.create': { opens: 'issue-page:comment', refs: targetIssueRefs },
  'comment.update': { opens: 'comment:edit', refs: targetCommentRefs },
  'comment.delete': { opens: 'comment:delete', refs: targetCommentRefs },
  'comment.resolve': { opens: 'comment:resolve', refs: targetCommentRefs },
  'comment.reopen': { opens: 'comment:reopen', refs: targetCommentRefs },
};
