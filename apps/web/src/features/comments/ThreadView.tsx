// A thread (SPEC-013 §3.2, §3.3, §3.3a): the root comment, its replies oldest first, the reply box,
// or one line when the thread is resolved. Connected: it reads the page's `CommentsEnv`.
import { EMPTY_DOC, type DocNodeJSON } from '@surface/domain';
import { Button, Dialog, DialogClose } from '@surface/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useObserved } from '../../app/context.js';
import { CommentCard } from './CommentCard.js';
import { commentMenu } from './CommentMenu.js';
import { ComposerBox } from './ComposerBox.js';
import { loadEmojiLazy, useEmojiNames } from './editor-host.js';
import { useCommentsEnv } from './env.js';
import { firstLineOf, hasContent, reactionChips, sameDoc, withChecked } from './model.js';
import type { CommentRow, ReactionRow, Thread } from './model.js';
import { composerAvailable } from './new-issue.js';
import { ResolvedThreadLine } from './ResolvedThreadLine.js';
import styles from './comments.module.css';

export const DELETE_COMMENT_MESSAGE = "Delete this comment? This can't be undone.";

function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <DialogClose>
            <Button variant="secondary">{cancelLabel}</Button>
          </DialogClose>
          <Button variant={danger === true ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}

interface EditState {
  readonly doc: DocNodeJSON;
  /** What the editor opened with: "unchanged" and the dirty-close guard compare against it. */
  readonly initial: DocNodeJSON;
  /** The version the edit started from, sent as `baseVersion` (E3, E22). */
  readonly base: number;
  readonly error?: string;
}

function CommentItem({
  comment,
  thread,
  reactions,
}: {
  comment: CommentRow;
  thread: Thread;
  reactions: readonly ReactionRow[];
}) {
  const env = useCommentsEnv();
  const { actions } = env;
  const mine = env.me !== null && env.me === comment.userId;
  const deleted = comment.deletedAt !== null;
  const [editing, setEditing] = useState<EditState | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pending = useObserved(
    useCallback(() => actions.isPending(comment.id), [actions, comment.id]),
  );
  const names = useEmojiNames(reactions.length > 0);

  const startEdit = useCallback(() => {
    if (!mine || deleted || env.readOnly) return;
    setEditing({ doc: comment.body, initial: comment.body, base: comment.version });
  }, [mine, deleted, env.readOnly, comment.body, comment.version]);

  // A command acts on this card's own state (SPEC-013 §7: the `comment` context). `n` counts
  // requests, so each is taken once. State adjusted while rendering, not in an effect.
  const request = env.request;
  const [takenN, setTakenN] = useState(0);
  if (request?.id === comment.id && request.n > takenN) {
    setTakenN(request.n);
    if (request.kind === 'edit') startEdit();
    else if (request.kind === 'delete') setConfirmDelete(true);
    else if (request.kind === 'react') setPickerOpen(true);
  }

  const save = () => {
    if (editing === null) return;
    const { doc, initial, base } = editing;
    setEditing(null);
    void actions.update({
      commentId: comment.id,
      baseVersion: base,
      doc,
      // E3: the text stays in the editor, with the message.
      onRejected: (error) => {
        setEditing({ doc, initial, base, error });
      },
    });
  };

  const cancel = () => {
    if (editing === null) return;
    if (sameDoc(editing.doc, editing.initial)) setEditing(null);
    else setConfirmDiscard(true);
  };

  const menu = env.readOnly
    ? []
    : commentMenu({
        resolved: thread.resolved,
        deleted,
        mine,
        canDelete: mine || env.isAdmin,
        composerAvailable: composerAvailable(),
        onToggleResolved: () => {
          void (thread.resolved ? actions.reopen(comment.id) : actions.resolve(comment.id));
        },
        onCopyLink: () => {
          env.copyLink(comment.id);
        },
        onCopyMarkdown: () => {
          env.copyMarkdown(comment.body);
        },
        onNewIssue: () => undefined,
        onEdit: startEdit,
        onDelete: () => {
          setConfirmDelete(true);
        },
      });

  return (
    <>
      <CommentCard
        id={comment.id}
        authorName={env.userName(comment.userId)}
        via={comment.actorKind === 'user' ? null : comment.actorKind}
        createdAt={comment.createdAt}
        editedAt={comment.editedAt}
        now={env.now}
        body={comment.body}
        deleted={deleted}
        pending={pending}
        highlighted={env.highlightId === comment.id}
        readOnly={env.readOnly}
        chips={reactionChips(reactions, env.me, env.userName, (emoji) => names?.get(emoji))}
        onReact={(emoji, reacted) => {
          void actions.react({
            issueId: env.issueId,
            commentId: comment.id,
            emoji,
            reacted,
          });
        }}
        loadEmoji={loadEmojiLazy}
        pickerOpen={pickerOpen}
        onPickerOpenChange={setPickerOpen}
        menu={menu}
        // A reply has no reply box of its own: replying always adds to its thread (INV-19).
        onReply={() => {
          env.requestReply(thread.root.id);
        }}
        {...(mine && !env.readOnly && !deleted
          ? {
              onToggle: (path: readonly number[], checked: boolean) => {
                void actions.update({
                  commentId: comment.id,
                  baseVersion: comment.version,
                  doc: withChecked(comment.body, path, checked),
                });
              },
            }
          : {})}
        {...(editing === null
          ? {}
          : {
              error: editing.error,
              editor: (
                <ComposerBox
                  value={editing.doc}
                  onChange={(doc) => {
                    setEditing((state) => (state === null ? state : { ...state, doc }));
                  }}
                  onSubmit={save}
                  onCancel={cancel}
                  placeholder=""
                  ariaLabel="Edit comment"
                  submitLabel="Save"
                  canSubmit={hasContent(editing.doc) && !sameDoc(editing.doc, editing.initial)}
                  autofocus="end"
                />
              ),
            })}
      />
      <ConfirmDialog
        open={confirmDelete}
        title="Delete comment"
        description={DELETE_COMMENT_MESSAGE}
        confirmLabel="Delete"
        cancelLabel="Cancel"
        danger
        onCancel={() => {
          setConfirmDelete(false);
        }}
        onConfirm={() => {
          setConfirmDelete(false);
          void actions.delete(comment.id);
        }}
      />
      <ConfirmDialog
        open={confirmDiscard}
        title="Discard changes?"
        description="Your edit hasn't been saved."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        onCancel={() => {
          setConfirmDiscard(false);
        }}
        onConfirm={() => {
          setConfirmDiscard(false);
          setEditing(null);
        }}
      />
    </>
  );
}

/** The thread's "Leave a reply…" box: one line until focused, **Reply** or `R` (§3.2, §7). */
function ReplyBox({
  rootId,
  open,
  onOpen,
  onClose,
}: {
  rootId: string;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const env = useCommentsEnv();
  const [doc, setDoc] = useState<DocNodeJSON>(EMPTY_DOC);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  if (!open) {
    return (
      <button type="button" className={styles.boxCollapsed} onClick={onOpen}>
        Leave a reply…
      </button>
    );
  }

  const send = () => {
    const sent = doc;
    setDoc(EMPTY_DOC);
    onClose();
    void env.actions.create({
      issueId: env.issueId,
      parentId: rootId,
      doc: sent,
      // E2, E15, E17: a refused reply goes back into the box, if it is still there.
      restore: (text) => {
        if (!mounted.current) return 'copy';
        setDoc(text);
        onOpen();
        return 'restored';
      },
    });
  };

  return (
    <ComposerBox
      value={doc}
      onChange={setDoc}
      onSubmit={send}
      onBlur={() => {
        if (!hasContent(doc)) onClose();
      }}
      placeholder="Leave a reply…"
      ariaLabel="Reply"
      submitLabel="Reply"
      canSubmit={hasContent(doc)}
      autofocus="end"
    />
  );
}

export function ThreadView({
  thread,
  reactionsOf,
}: {
  thread: Thread;
  reactionsOf: (commentId: string) => readonly ReactionRow[];
}) {
  const env = useCommentsEnv();
  const { root, replies, resolved } = thread;
  const [expanded, setExpanded] = useState(false);
  const [replyOpen, setReplyOpen] = useState(false);

  // A comment link into a collapsed thread, and `R` on one of its comments, open it.
  const ids = new Set([root.id, ...replies.map((reply) => reply.id)]);
  const request = env.request;
  const highlightId = env.highlightId;
  const [takenN, setTakenN] = useState(0);
  const [takenHighlight, setTakenHighlight] = useState<string | undefined>(undefined);
  if (highlightId !== undefined && highlightId !== takenHighlight && ids.has(highlightId)) {
    setTakenHighlight(highlightId);
    if (resolved) setExpanded(true);
  }
  if (request?.kind === 'reply' && request.n > takenN && ids.has(request.id)) {
    setTakenN(request.n);
    setReplyOpen(true);
  }

  const reopen = env.readOnly
    ? {}
    : {
        onReopen: () => {
          void env.actions.reopen(root.id);
        },
      };
  const line = resolved && root.resolvedAt !== null && (
    <ResolvedThreadLine
      id={root.id}
      text={root.deletedAt === null ? firstLineOf(root.body) : ''}
      resolvedBy={root.resolvedById === null ? 'someone' : env.userName(root.resolvedById)}
      resolvedAt={root.resolvedAt}
      now={env.now}
      expanded={expanded}
      onToggle={() => {
        setExpanded((value) => !value);
      }}
      {...reopen}
    />
  );
  if (resolved && !expanded) return <li className={styles.thread}>{line}</li>;

  return (
    <li className={styles.thread}>
      {line}
      <CommentItem comment={root} thread={thread} reactions={reactionsOf(root.id)} />
      {replies.length > 0 && (
        <ul className={styles.replies} aria-label="Replies">
          {replies.map((reply) => (
            <li key={reply.id}>
              <CommentItem comment={reply} thread={thread} reactions={reactionsOf(reply.id)} />
            </li>
          ))}
        </ul>
      )}
      {!env.readOnly && (
        <ReplyBox
          rootId={root.id}
          open={replyOpen}
          onOpen={() => {
            setReplyOpen(true);
          }}
          onClose={() => {
            setReplyOpen(false);
          }}
        />
      )}
    </li>
  );
}
