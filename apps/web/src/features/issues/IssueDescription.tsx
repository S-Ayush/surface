// The issue page's description (SPEC-012 §3.4 item 3, §7.2, AC-12, AC-21, E5; PLAN-012 S4b).
//
// - Live: the replica's `IssueContent`, opened (and hydrated) while the page is mounted, in the
//   lazy editor; `description-save.ts` decides when `issue.updateDescription` is sent. `Mod+Enter`
//   saves now and `Ctrl+Shift+I` focuses it (the `issue-page` scope). A `CONFLICT` shows the banner
//   with **Copy my text** and **Discard and reload**.
// - Read-only (archived, deleted, not in the replica): the document from `issue.get` or the
//   server-backed answer, shown with `DocView`.
// Skeleton while loading (the `Skeleton` fades in after 150 ms); "Available when online" offline
// when the content was never hydrated.
import { issueUpdateDescription } from '@surface/operations';
import type { DocNodeJSON } from '@surface/domain';
import type { RichTextEditorHandle } from '@surface/editor';
import { docToMarkdown } from '@surface/editor/schema';
import { Button, Skeleton, toast } from '@surface/ui';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useApp, useObserved } from '../../app/context.js';
import { useCommand } from '../../shortcuts/ShortcutProvider.js';
import { CommentDoc, CommentEditor } from '../comments/editor-host.js';
import { hasContent } from '../comments/model.js';
import { copyText } from '../members/reset-link.js';
import {
  DescriptionSaver,
  descriptionSendResult,
  type DescriptionTimers,
  type SavedDescription,
  unconfirmedDescriptionChanges,
} from './description-save.js';
import { docInput } from './draft-adapter.js';
import { descriptionOf, useIssueContentView, type ContentView } from './server-issue.js';
import pageStyles from './issue-page.module.css';

export const DESCRIPTION_CONFLICT_MESSAGE = 'Someone changed this description since you opened it.';
export const DESCRIPTION_OFFLINE_MESSAGE = 'Available when online';

const BROWSER_TIMERS: DescriptionTimers = {
  setTimeout: (run, ms) => window.setTimeout(run, ms),
  clearTimeout: (handle) => {
    if (typeof handle === 'number') window.clearTimeout(handle);
  },
};

/** The live issue's description, from the replica, editable. */
export function LiveDescription({ issueId }: { issueId: string }) {
  const content = useIssueContentView(issueId);
  const saved = useMemo(() => descriptionOf(content.rows['IssueContent']), [content.rows]);
  if (content.state !== 'ready') return <DescriptionState state={content.state} />;
  // An issue created before IssueContent existed has no row: nothing to edit (PLAN-011 S6).
  if (saved === undefined) return <ReadOnlyDescription doc={undefined} state="ready" />;
  return <EditableDescription issueId={issueId} saved={saved} />;
}

function EditableDescription({ issueId, saved }: { issueId: string; saved: SavedDescription }) {
  const app = useApp();
  // SPEC-012 D31: while an earlier save of this description (or the issue's create) is
  // unconfirmed, the replica's version is a prediction the saver must not send on.
  const unconfirmed = useObserved(
    useCallback(
      () => unconfirmedDescriptionChanges(app.store?.pending ?? [], issueId),
      [app, issueId],
    ),
  );
  const [saver] = useState(
    () =>
      new DescriptionSaver(
        saved,
        {
          timers: BROWSER_TIMERS,
          send: async ({ baseVersion, description }, shown) => {
            const store = app.readyStore;
            // Thrown, so the saver reports it: the store never saw it.
            if (store === null) throw new Error("Couldn't save the description. Try again.");
            // While the page is open it shows the refusal itself (the banner, or the toast below);
            // after it closed, the shell's toast does.
            const outcome = await store.dispatch(
              issueUpdateDescription,
              { issue: issueId, baseVersion, description: docInput(description) },
              { reportRejection: () => !shown() },
            );
            return descriptionSendResult(outcome);
          },
          onRefused: (message) => {
            toast({ tone: 'danger', message });
          },
        },
        unconfirmed,
      ),
  );
  useEffect(() => {
    saver.remote(saved, unconfirmed);
  }, [saver, saved, unconfirmed]);
  // Detaching (leaving the page, or stepping to another issue) saves what is unsaved.
  useEffect(() => saver.attach(), [saver]);
  // A tab closed or hidden may never run React's cleanup: the queue keeps what is sent now.
  useEffect(() => {
    const flush = () => {
      saver.saveNow();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') saver.saveNow();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [saver]);
  const state = useSyncExternalStore(saver.subscribe, saver.getState, saver.getState);
  const editor = useRef<RichTextEditorHandle>(null);

  useCommand('issue-page:save-description', () => {
    saver.saveNow();
  });
  useCommand('issue-page:focus-description', () => {
    editor.current?.focus();
  });

  const copyMine = () => {
    void copyText(docToMarkdown(saver.getState().doc), navigator.clipboard).then((ok) => {
      toast(
        ok
          ? { message: 'Your text was copied' }
          : { tone: 'danger', message: "Couldn't copy your text. Select it and copy it." },
      );
    });
  };

  return (
    <section aria-label="Description" className={pageStyles.description}>
      {state.conflict && (
        <div role="alert" className={pageStyles.conflict}>
          <p className={pageStyles.conflictMessage}>{DESCRIPTION_CONFLICT_MESSAGE}</p>
          <Button size="sm" onClick={copyMine}>
            Copy my text
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              saver.discardAndReload();
            }}
          >
            Discard and reload
          </Button>
        </div>
      )}
      <CommentEditor
        ref={editor}
        mode="description"
        value={state.doc}
        onChange={(doc) => {
          saver.edit(doc);
        }}
        onBlur={() => {
          saver.blur();
        }}
        placeholder="Add description…"
        ariaLabel="Description"
      />
    </section>
  );
}

/** Loading or offline, before the content is in memory (SPEC-012 §7.2). */
function DescriptionState({ state }: { state: Exclude<ContentView['state'], 'ready'> }) {
  if (state === 'loading') {
    return (
      <section aria-label="Description" aria-busy="true" className={pageStyles.description}>
        <Skeleton width="80%" />
        <Skeleton width="60%" />
      </section>
    );
  }
  return (
    <section aria-label="Description" className={pageStyles.description}>
      <p className={pageStyles.placeholder}>
        {state === 'offline' ? DESCRIPTION_OFFLINE_MESSAGE : "Couldn't load the description."}
      </p>
    </section>
  );
}

/** A description that can't be edited here: shown, never sent. */
export function ReadOnlyDescription({
  doc,
  state,
}: {
  doc: DocNodeJSON | undefined;
  state: ContentView['state'];
}) {
  if (doc === undefined && state !== 'ready') return <DescriptionState state={state} />;
  return (
    <section aria-label="Description" className={pageStyles.description}>
      {doc !== undefined && hasContent(doc) ? (
        <CommentDoc doc={doc} />
      ) : (
        <p className={pageStyles.placeholder}>No description</p>
      )}
    </section>
  );
}
