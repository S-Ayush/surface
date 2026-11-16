// Plug points on the issue page for later slices (PLAN-012 S4). Append-only, like
// `features/hosts.ts`: each slice replaces its own `null` with its component and touches no other
// line. The page renders a slot only for a live issue, never in the read-only view (SPEC-012 §3.4
// item 8: reactions and the comment box are hidden there).
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
