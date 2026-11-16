// "New issue from comment…" (SPEC-013 §3.3): the composer opens with the comment's body as the
// description and the title focused; `issue.create` creates the issue when the user submits.
// Inline files in the body are claimed (copied, once PLAN-014 brings uploads) by the server.
import type { DocNodeJSON } from '@surface/domain';
import { openComposerWith } from '../issues/composer-request.js';

/** Opens the composer with `body` as the description. Returns whether it opened (E6). */
export function newIssueFromComment(
  body: DocNodeJSON,
  run: (id: 'issue:create') => boolean,
): boolean {
  return openComposerWith({ kind: 'comment', description: body }, run);
}
