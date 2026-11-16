// The comments of the issue page (SPEC-013 §3, §7; PLAN-013 S5): the timeline of threads and the
// comment box, in the issue page's `comments` slot.
//
// Seam for PLAN-012 S4b: the timeline here holds only comments. S4b's activity stream interleaves
// history lines with the top-level comments "by time" and adds "N earlier": it takes `buildThreads`
// (model.ts) and renders `ThreadView` for each comment entry, or mounts this section after its own
// stream and drops the empty `Activity` section. The read-only view of an archived or deleted
// issue (comments from the server) is S4b's too; this section hides every write control when the
// replica holds the issue not live (D10) but only ever shows comments the replica holds.
import type { DocNodeJSON } from '@surface/domain';
import { useIssueContent } from '@surface/sync-react';
import { Skeleton, toast } from '@surface/ui';
import { useLocation } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent } from 'react';
import { copyText } from '../members/reset-link.js';
import { docToMarkdown } from '@surface/editor/schema';
import { CommentBox } from './CommentBox.js';
import { CommentTarget } from './CommentTarget.js';
import { CommentsEnvContext, type CommentRequest, type CommentsEnv } from './env.js';
import {
  buildThreads,
  commentDomId,
  commentIdOfHash,
  commentLink,
  commentRows,
  reactionRows,
  reactionsOf,
} from './model.js';
import { ThreadView } from './ThreadView.js';
import { useCommentCommands } from './useCommentCommands.js';
import { commentActionsFor, useCommentWorld, useNow } from './useComments.js';
import styles from './comments.module.css';

/** What the issue page passes a slot (`issues/slots.ts`; not imported, which would be circular). */
type SlotProps = { readonly issueId: string };

export const COMMENTS_OFFLINE_MESSAGE = "Comments are available when you're back online.";
/** SPEC-013 §7: a comment link highlights its comment for this long. */
export const HIGHLIGHT_MS = 2000;

export function CommentsSection({ issueId }: SlotProps) {
  const world = useCommentWorld(issueId);
  const content = useIssueContent(issueId);
  const now = useNow();

  const comments = useMemo(() => commentRows(content.rows['Comment']), [content.rows]);
  const reactions = useMemo(() => reactionRows(content.rows['Reaction']), [content.rows]);
  const threads = useMemo(() => buildThreads(comments), [comments]);

  const [request, setRequest] = useState<CommentRequest | undefined>(undefined);
  const counter = useRef(0);
  const ask = useCallback((kind: CommentRequest['kind'], id: string) => {
    counter.current += 1;
    setRequest({ kind, id, n: counter.current });
  }, []);

  // The focused comment is the command target (the `comment` context, SPEC-013 §7).
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const onFocus = (event: FocusEvent<HTMLElement>) => {
    const card = event.target.closest('article[id^="comment-"]');
    if (card !== null) setFocusedId(card.id.slice('comment-'.length));
  };
  const onBlur = (event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Element) {
      // Inside the list, or into the command menu, a menu or a picker the comment opened: the
      // comment stays the target.
      if (event.currentTarget.contains(next)) return;
      if (
        next.closest(
          '[role="dialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]',
        )
      )
        return;
    }
    setFocusedId(null);
  };

  // A comment link scrolls to its comment and highlights it for 2 s (§7). A link to a comment the
  // replica doesn't hold (hard-deleted) just opens the issue.
  const hash = useLocation({ select: (location) => location.hash });
  const linked = commentIdOfHash(hash);
  const [doneId, setDoneId] = useState<string | undefined>(undefined);
  const ready = content.state === 'ready';
  const exists = linked !== undefined && comments.some((comment) => comment.id === linked);
  const highlightId = ready && exists && linked !== doneId ? linked : undefined;
  useEffect(() => {
    if (highlightId === undefined) return;
    const timer = setTimeout(() => {
      setDoneId(highlightId);
    }, HIGHLIGHT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [highlightId]);
  useEffect(() => {
    if (highlightId === undefined) return;
    // After the thread has expanded, if it was resolved.
    document.getElementById(commentDomId(highlightId))?.scrollIntoView?.({ block: 'center' });
  }, [highlightId]);

  const { store, me, isAdmin, userName, issue } = world;
  const readOnly = issue !== undefined && issue.lifecycle !== 'live';
  const identifier = issue?.identifier ?? null;
  const actions = useMemo(() => (store === null ? null : commentActionsFor(store)), [store]);

  const copyLink = useCallback(
    (commentId: string) => {
      if (identifier === null) return;
      void copyText(
        commentLink(window.location.origin, identifier, commentId),
        navigator.clipboard,
      ).then((ok) => {
        toast(
          ok
            ? { message: 'Comment link copied' }
            : { tone: 'danger', message: "Couldn't copy the link. Copy it from the address bar." },
        );
      });
    },
    [identifier],
  );
  const copyMarkdown = useCallback((doc: DocNodeJSON) => {
    void copyText(docToMarkdown(doc), navigator.clipboard).then((ok) => {
      toast(
        ok
          ? { message: 'Comment copied as Markdown' }
          : { tone: 'danger', message: "Couldn't copy the comment. Try again." },
      );
    });
  }, []);

  useCommentCommands({
    comments,
    focusedId,
    me,
    isAdmin,
    readOnly,
    actions,
    ask,
    copyLink,
    copyMarkdown,
  });

  if (store === null || actions === null) return null;
  const focused = comments.find((comment) => comment.id === focusedId);

  const env: CommentsEnv = {
    issueId,
    identifier,
    me,
    isAdmin,
    readOnly,
    now,
    actions,
    userName,
    highlightId,
    request,
    requestReply: (rootId) => {
      ask('reply', rootId);
    },
    copyLink,
    copyMarkdown,
  };

  return (
    <section
      aria-label="Comments"
      className={styles.section}
      data-slot="comments"
      onFocus={onFocus}
      onBlur={onBlur}
    >
      {focused !== undefined && (
        <CommentTarget id={focused.id} label={`Comment by ${userName(focused.userId)}`} />
      )}
      {content.state === 'loading' && (
        <div aria-busy="true" aria-label="Loading comments">
          <Skeleton />
        </div>
      )}
      {content.state === 'offline' && <p className={styles.notice}>{COMMENTS_OFFLINE_MESSAGE}</p>}
      {content.state === 'ready' && (
        <CommentsEnvContext value={env}>
          {threads.length > 0 && (
            <ol className={styles.timeline} aria-label="Comment threads">
              {threads.map((thread) => (
                <ThreadView
                  key={thread.root.id}
                  thread={thread}
                  reactionsOf={(commentId) => reactionsOf(reactions, commentId)}
                />
              ))}
            </ol>
          )}
          {!readOnly && <CommentBox issueId={issueId} store={store} actions={actions} />}
        </CommentsEnvContext>
      )}
    </section>
  );
}
