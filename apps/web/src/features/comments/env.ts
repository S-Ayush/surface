// What every comment in the timeline reads of the page around it (SPEC-013 §3). One context, so a
// thread, a card and a box take only their own data as props.
import type { DocNodeJSON } from '@surface/domain';
import { createContext, use } from 'react';
import type { CommentActions } from './actions.js';

/**
 * A command that acts on one comment's own state (its editor, its delete dialog, its picker, its
 * reply box). The card with that id takes it; `n` makes a repeat of the same request new.
 */
export interface CommentRequest {
  readonly kind: 'edit' | 'delete' | 'reply' | 'react';
  readonly id: string;
  readonly n: number;
}

export interface CommentsEnv {
  readonly issueId: string;
  /** `ENG-42`; null while the number is pending. */
  readonly identifier: string | null;
  readonly me: string | null;
  readonly isAdmin: boolean;
  /** Archived and deleted issues hide every control that writes (D10). */
  readonly readOnly: boolean;
  readonly now: Date;
  readonly actions: CommentActions;
  readonly userName: (id: string) => string;
  /** The comment a link scrolled to, highlighted for 2 s (§7). */
  readonly highlightId: string | undefined;
  readonly request: CommentRequest | undefined;
  /** Opens the reply box of the thread whose first comment is `rootId` (`Reply`, `R`). */
  readonly requestReply: (rootId: string) => void;
  readonly copyLink: (commentId: string) => void;
  readonly copyMarkdown: (doc: DocNodeJSON) => void;
}

export const CommentsEnvContext = createContext<CommentsEnv | null>(null);

export function useCommentsEnv(): CommentsEnv {
  const env = use(CommentsEnvContext);
  if (env === null) throw new Error('Render comments inside <CommentsSection>');
  return env;
}
