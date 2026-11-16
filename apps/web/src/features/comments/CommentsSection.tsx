// The issue page's activity and comments (SPEC-012 §3.4 item 4, SPEC-013 §3, §7; PLAN-013 S5,
// PLAN-012 S4b), in the issue page's `comments` slot: the activity stream (history lines and
// comment threads interleaved by time, `ActivityStream`) and the comment box at its end.
//
// In the read-only view of an archived or deleted issue (or one that left the replica while open)
// the page provides the server-backed content (`ServerContentContext`): the same stream, read
// from one `content.peek` answer, with every write control hidden (D10).
import type { DocNodeJSON } from '@surface/domain';
import { Skeleton, toast } from '@surface/ui';
import { useLocation } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState, type FocusEvent } from 'react';
import { copyText } from '../members/reset-link.js';
import { docToMarkdown } from '@surface/editor/schema';
import { useCommandRegistry } from '../../shortcuts/ShortcutProvider.js';
import { activityItems, historyRows, type HistoryRow } from '../issues/activity-model.js';
import { ActivityStream } from '../issues/ActivityStream.js';
import { useIssueContentView } from '../issues/server-issue.js';
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
import { newIssueFromComment } from './new-issue.js';
import { ThreadView } from './ThreadView.js';
import { useCommentCommands } from './useCommentCommands.js';
import { commentActionsFor, useCommentWorld, useNow } from './useComments.js';
import styles from './comments.module.css';

/** What the issue page passes a slot (`issues/slots.ts`; not imported, which would be circular). */
type SlotProps = { readonly issueId: string };

export const COMMENTS_OFFLINE_MESSAGE = "Comments are available when you're back online.";
/** The server-backed read failed while online (the read-only view asks again on focus). */
export const ACTIVITY_FAILED_MESSAGE = "Couldn't load the activity. Try again in a moment.";
/** SPEC-013 §7: a comment link highlights its comment for this long. */
export const HIGHLIGHT_MS = 2000;

export function CommentsSection({ issueId }: SlotProps) {
  const world = useCommentWorld(issueId);
  const content = useIssueContentView(issueId);
  const now = useNow();

  const comments = useMemo(() => commentRows(content.rows['Comment']), [content.rows]);
  const reactions = useMemo(() => reactionRows(content.rows['Reaction']), [content.rows]);
  const threads = useMemo(() => buildThreads(comments), [comments]);
  const history = useMemo(() => historyRows(content.rows['IssueHistory']), [content.rows]);
  const items = useMemo(() => activityItems(history, threads), [history, threads]);

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
  // SPEC-011 §4.4: the actor's name from the replica; the system's own lines don't use it.
  const actorName = useCallback(
    (entry: HistoryRow) => (entry.actorId === null ? 'Surface' : userName(entry.actorId)),
    [userName],
  );
  // Server-backed content is an issue the replica doesn't hold live: read-only (SPEC-012 §3.4 item 8).
  const readOnly = content.server || (issue !== undefined && issue.lifecycle !== 'live');
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
  const commands = useCommandRegistry();
  const newIssue = useCallback(
    (doc: DocNodeJSON) => {
      newIssueFromComment(doc, (id) => commands.run(id));
    },
    [commands],
  );

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
    newIssue,
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
    newIssue,
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
      {content.state === 'failed' && <p className={styles.notice}>{ACTIVITY_FAILED_MESSAGE}</p>}
      {content.state === 'ready' && (
        <CommentsEnvContext value={env}>
          <ActivityStream
            items={items}
            actorName={actorName}
            now={now}
            renderThread={(thread) => (
              <ThreadView
                key={thread.root.id}
                thread={thread}
                reactionsOf={(commentId) => reactionsOf(reactions, commentId)}
              />
            )}
          />
          {!readOnly && <CommentBox issueId={issueId} store={store} actions={actions} />}
        </CommentsEnvContext>
      )}
    </section>
  );
}
