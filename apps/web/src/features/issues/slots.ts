// Plug points on the issue page for later slices (PLAN-012 S4). Append-only, like
// `features/hosts.ts`: each slice replaces its own `null` with its component and touches no other
// line. In the read-only view (an archived or deleted issue, or one not in the replica) the page
// renders the slots inside `ServerContentContext` (PLAN-012 S4b): a slot reads its content with
// `useIssueContentView`, which then answers from the server's in-memory answer with `server: true`,
// and hides every write control (SPEC-012 §3.4 item 8: reactions and the comment box are hidden).
// `teamId` is '' there when the replica doesn't hold the team.
import type { ComponentType } from 'react';
import { CommentsSection } from '../comments/CommentsSection.js';
import { IssueReactions } from '../comments/IssueReactions.js';

/** What every slot component receives. */
export type IssuePageSlotProps = {
  readonly issueId: string;
  readonly teamId: string;
};

export type IssuePageSlot = ComponentType<IssuePageSlotProps>;

export const ISSUE_PAGE_SLOTS: {
  /** PLAN-013 S5: reactions on the issue itself, under the description. */
  readonly reactions: IssuePageSlot | null;
  /** PLAN-014 S5: attachments, under the reactions. */
  readonly attachments: IssuePageSlot | null;
  /** PLAN-013 S5: the comment timeline and the comment box, at the end of the activity stream. */
  readonly comments: IssuePageSlot | null;
} = {
  reactions: IssueReactions,
  attachments: null,
  comments: CommentsSection,
};
