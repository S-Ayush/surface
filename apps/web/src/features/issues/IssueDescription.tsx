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
import { reaction } from 'mobx';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { AppModel } from '../../app/AppModel.js';
import { structurallyEqual } from '../../app/equal.js';
import { useApp } from '../../app/context.js';
import { useCommand } from '../../shortcuts/ShortcutProvider.js';
import { CommentDoc, CommentEditor } from '../comments/editor-host.js';
import { hasContent } from '../comments/model.js';
import { copyText } from '../members/reset-link.js';
import {
  changesDescription,
  DescriptionSaver,
  descriptionSendResult,
  type DescriptionSnapshot,
  type DescriptionSource,
  type DescriptionTimers,
  type SavedDescription,
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

const NOTHING: DescriptionSnapshot = { saved: undefined, changes: [], refusals: [] };

/**
 * The store as the saver watches it (SPEC-012 D31): the replica's row, and the queue's unconfirmed
 * changes and recent refusals of this description, read together. Outlives the page: the saver
 * stops watching once what it holds is sent.
 */
export function storeDescriptionSource(app: AppModel, issueId: string): DescriptionSource {
  const read = (): DescriptionSnapshot => {
    const store = app.store;
    if (store === null) return NOTHING;
    const key = (seq: number) => `${store.clientId}:${seq}`;
    return {
      saved: descriptionOf(store.content.rows(issueId)['IssueContent']),
      changes: store.pending
        .filter(({ op, input }) => changesDescription(op, input, issueId))
        .map(({ seq }) => key(seq)),
      refusals: store.rejections
        .filter(({ op, input }) => changesDescription(op, input, issueId))
        .map(({ seq, message }) => ({ key: key(seq), message })),
    };
  };
  return {
    read,
    watch: (changed) => reaction(read, changed, { equals: structurallyEqual }),
  };
}

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
  // The saver reads the store itself (SPEC-012 D31): the row and the queue in one read, also
  // after the page closed, until what it holds is sent.
  const [saver] = useState(
    () =>
      new DescriptionSaver(saved, {
        source: storeDescriptionSource(app, issueId),
        timers: BROWSER_TIMERS,
        send: async ({ baseVersion, description }, shown, queued) => {
          const store = app.readyStore;
          // Thrown, so the saver reports it: the store never saw it.
          if (store === null) throw new Error("Couldn't save the description. Try again.");
          // While the page is open it shows the refusal itself (the banner, or the toast below);
          // after it closed, the shell's toast does.
          const outcome = await store.dispatch(
            issueUpdateDescription,
            { issue: issueId, baseVersion, description: docInput(description) },
            {
              reportRejection: () => !shown(),
              onQueued: ({ clientId, seq }) => {
                queued(`${clientId}:${seq}`);
              },
            },
          );
          return descriptionSendResult(outcome);
        },
        onRefused: (message) => {
          toast({ tone: 'danger', message });
        },
      }),
  );
  // Detaching (leaving the page, or stepping to another issue) saves what is unsaved.
  useEffect(() => saver.attach(), [saver]);
  // A tab closed or hidden may never run React's cleanup: the queue keeps what is sent now. A save
  // already in flight when the tab closes holds back the next one (one in flight), so text typed
  // after it is lost (SPEC-012 D31 records the limit).
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
          <p className={pageStyles.conflictMessage}>
            {state.conflictMessage ?? DESCRIPTION_CONFLICT_MESSAGE}
          </p>
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
