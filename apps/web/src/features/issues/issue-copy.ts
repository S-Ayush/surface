// What the header's copy buttons and the ⋯ menu's Copy submenu put on the clipboard (SPEC-012
// §3.4 item 1, §3.7). The link is on the page's own origin (SPEC-011 D11).
import { gitBranchName, issueSlug, issueUrl } from '@surface/domain';
import type { IssueView } from './issue-view.js';

export type IssueCopyValues = {
  /** Null while the issue is pending: there is no identifier to copy yet. */
  readonly id: string | null;
  readonly link: string | null;
  readonly branch: string | null;
};

export function issueCopyValues(
  view: Pick<IssueView, 'identifier' | 'title'>,
  origin: string,
  userDisplayName: string,
): IssueCopyValues {
  const { identifier, title } = view;
  if (identifier === null) return { id: null, link: null, branch: null };
  return {
    id: identifier,
    link: issueUrl(origin, identifier, title),
    branch: gitBranchName(userDisplayName, identifier, issueSlug(title)),
  };
}
