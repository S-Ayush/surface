// "Leave a comment…" at the end of the timeline (SPEC-013 §3.1, §7). The text is the issue's synced
// comment `Draft` (PLAN-012 S5's adapter): written 500 ms after the last change and on blur, saved
// at once when the user leaves or the page closes, and discarded when the comment is sent. A
// draft that arrives while the box is empty (another device, or a rejected send put its text back,
// E21) shows in the box.
import { EMPTY_DOC, type DocNodeJSON } from '@surface/domain';
import type { RichTextEditorHandle } from '@surface/editor';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useObserved } from '../../app/context.js';
import { commentFromDescription } from '../issues/description-savers.js';
import { draftAdapterFor } from '../issues/draft-adapter.js';
import { useCommand } from '../../shortcuts/ShortcutProvider.js';
import type { CommentActions } from './actions.js';
import { ComposerBox } from './ComposerBox.js';
import { hasContent, sameDoc } from './model.js';
import type { SyncStore } from '@surface/sync-client';

const sameSaved = (a: DocNodeJSON | undefined, b: DocNodeJSON | undefined) =>
  a === b || (a !== undefined && b !== undefined && sameDoc(a, b));

export function CommentBox({
  issueId,
  store,
  actions,
}: {
  issueId: string;
  store: SyncStore;
  actions: CommentActions;
}) {
  const adapter = draftAdapterFor(store);
  const editor = useRef<RichTextEditorHandle>(null);
  const [doc, setDoc] = useState<DocNodeJSON>(() => adapter.commentText(issueId) ?? EMPTY_DOC);
  const saved = useObserved(
    useCallback(() => adapter.commentText(issueId), [adapter, issueId]),
    sameSaved,
  );

  // Adjusting state while rendering: a saved draft that changed shows in an empty box.
  const [seen, setSeen] = useState(saved);
  if (!sameSaved(saved, seen)) {
    setSeen(saved);
    if (saved !== undefined && !hasContent(doc)) setDoc(saved);
  }

  // SPEC-012 §3.2: expired drafts are discarded from an effect, never by a read; waiting text is
  // saved when the user leaves (this unmounts) or the page closes.
  useEffect(() => {
    adapter.expireOld();
    const save = () => {
      adapter.flush();
    };
    window.addEventListener('pagehide', save);
    return () => {
      window.removeEventListener('pagehide', save);
      adapter.flush();
    };
  }, [adapter]);

  // `Ctrl+M` (SPEC-012 §3.6) and the "Comment…" command.
  useCommand(
    'issue-page:comment',
    () => {
      commentFromDescription(store, issueId, () => {
        editor.current?.focus();
      });
    },
    { level: 'page' },
  );

  const send = () => {
    if (!hasContent(doc)) return;
    const sent = doc;
    setDoc(EMPTY_DOC);
    void actions.create({ issueId, doc: sent });
  };

  return (
    <ComposerBox
      value={doc}
      onChange={(next) => {
        setDoc(next);
        adapter.setCommentText(issueId, next);
      }}
      onBlur={() => {
        adapter.flush();
      }}
      onSubmit={send}
      placeholder="Leave a comment…"
      ariaLabel="Comment"
      submitLabel="Send"
      canSubmit={hasContent(doc)}
      editorRef={editor}
    />
  );
}
