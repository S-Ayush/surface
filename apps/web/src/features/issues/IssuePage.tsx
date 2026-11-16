// The issue page (SPEC-012 §3.4; PLAN-012 S4 and S4b): header, title, description, the slots later
// slices fill (reactions, attachments, the activity stream with comments), and the properties
// panel. It renders one `IssueView`, from the replica (live, editable) or from `issue.get`
// (read-only), chosen by `chooseIssueSource`. The read-only view reads its activity, comments and
// reactions from one `content.peek` answer (`server-issue.ts`), never from the replica.
import {
  Badge,
  Button,
  EditableTitle,
  EmptyState,
  IconButton,
  Menu,
  Skeleton,
  type MenuEntry,
} from '@surface/ui';
import { issueUpdate } from '@surface/operations';
import { Link, useLocation, useNavigate, useRouter } from '@tanstack/react-router';
import {
  ArrowDown,
  ArrowUp,
  Copy,
  GitBranch,
  Hash,
  Link as LinkIcon,
  MoreHorizontal,
  PanelRight,
  Trash2,
  WifiOff,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { parseIssueRef, type DocNodeJSON } from '@surface/domain';
import type { ContentPeek } from '@surface/sync-client';
import { SyncStoreProvider, usePrefetchContent } from '@surface/sync-react';
import { User } from '@surface/domain/model';
import { useApp, useObserved } from '../../app/context.js';
import { useCommandContext } from '../../command-menu/context.js';
import { askDelete, lastDelete } from './delete-flow.js';
import { shortcutsFor } from '../../command-menu/sources/shortcuts.js';
import { structurallyEqual } from '../../app/equal.js';
import { PageHeader } from '../../shell/PageHeader.js';
import { useCommand, useCommandRegistry, usePageScope } from '../../shortcuts/ShortcutProvider.js';
import { isTypingTarget } from '../../shortcuts/engine.js';
import styles from '../../pages/Pages.module.css';
import { submitMutation, toastIfFailed } from '../teams/submit.js';
import { openComposerWith } from './composer-request.js';
import { IssueNotFound } from './IssueNotFound.js';
import { useIssueApi } from './issue-api.js';
import { COPY_ITEMS, planCopy, runCopy, type CopyKind } from './copy-actions.js';
import { readListSource, wantsTitleEdit, withoutEditTitle } from './focus-model.js';
import {
  chooseIssueSource,
  findRejectedCreate,
  heldRejection,
  loadMissingIssue,
  storeTeamSubscription,
  type IssueLoadResult,
} from './issue-loader.js';
import {
  addressReplacement,
  poolIssueLookup,
  replaceAddress,
  resolveIssueAddress,
} from './issue-url.js';
import { issueViewFromPool, type IssueView } from './issue-view.js';
import type { PickerKind } from './issue-pickers.js';
import { usePanelMode } from './panel-layout.js';
import { openPicker } from './pickers/picker-request.js';
import { PropertiesPanel } from './PropertiesPanel.js';
import { LiveDescription, ReadOnlyDescription } from './IssueDescription.js';
import {
  descriptionOf,
  ServerContentContext,
  useServerContent,
  type ServerContent,
} from './server-issue.js';
import { useIssueCommands } from './useIssueCommands.js';
import { ISSUE_PAGE_SLOTS } from './slots.js';
import { teamListPath, stepInfo, stepTarget, type Direction } from './source-list.js';
import pageStyles from './issue-page.module.css';

/** The replica's row for `issueRef`, the held create rejection, and the server's answer. */
function useIssueSource(issueRef: string) {
  const app = useApp();
  const api = useIssueApi();
  const ready = useObserved(
    useCallback(() => app.store !== null && app.store.status === 'ready', [app]),
  );
  const online = useObserved(useCallback(() => app.store?.connection === 'online', [app]));
  const replica = useObserved(
    useCallback(() => {
      const store = app.store;
      if (store === null || store.status !== 'ready') return undefined;
      const address = resolveIssueAddress(issueRef, poolIssueLookup(store.pool));
      return address.kind === 'found' ? issueViewFromPool(store.pool, address.issue.id) : undefined;
    }, [app, issueRef]),
  );
  const rejected = useObserved(
    useCallback(() => {
      const store = app.store;
      const parsed = parseIssueRef(issueRef);
      if (store === null || parsed?.by !== 'id') return undefined;
      return heldRejection(store.rejections, parsed.id);
    }, [app, issueRef]),
  );

  // Both are tied to the ref they were made for, so stepping to another issue never shows the
  // previous one while the next loads.
  const [last, setLast] = useState<{ readonly ref: string; readonly view: IssueView } | undefined>(
    undefined,
  );
  const [loaded, setLoaded] = useState<
    { readonly ref: string; readonly result: IssueLoadResult } | undefined
  >(undefined);
  const [attempt, setAttempt] = useState(0);
  const refresh = useWindowFocusCount();
  const inReplica = replica !== undefined;
  // A delete or restore not confirmed yet: the server's answer could predate it, so the page asks
  // once it is confirmed (the deleted state after a delete from this page, PLAN-012 S6 handoff).
  const lifecyclePending = useObserved(
    useCallback(
      () =>
        app.store?.pending.some((p) => p.op === 'issue.delete' || p.op === 'issue.restore') ===
        true,
      [app],
    ),
  );
  const replicaTeam = replica?.teamId ?? null;
  useEffect(() => {
    // SPEC-011 §5.7: opening one of a team's issues opens the team on demand, also when the replica
    // already holds the row (through `user:`, or a team opened before): it keeps the team in the
    // recently opened set and its content live. A member or private team is a no-op.
    if (replicaTeam !== null) app.store?.openTeam(replicaTeam);
  }, [app, replicaTeam]);
  // Adjusting state while rendering (react.dev "storing information from previous renders"): the
  // last row the replica had, shown read-only if it leaves the replica while open (E3).
  if (replica !== undefined && (last?.ref !== issueRef || !structurallyEqual(replica, last.view))) {
    setLast({ ref: issueRef, view: replica });
  }
  // An answer from before the row was (again) in the replica says nothing about it once it leaves.
  if (replica !== undefined && loaded?.ref === issueRef) setLoaded(undefined);

  useEffect(() => {
    // Nothing to fetch while the replica loads, while it holds the row, for a held rejection, or
    // while a delete or restore waits for its confirmation. A focus asks again (§3.4 item 8).
    if (!ready || inReplica || rejected !== undefined || lifecyclePending) return;
    let current = true;
    void loadMissingIssue(issueRef, {
      get: (ref) => api.get(ref),
      online: () => app.store?.connection === 'online',
      pool: app.store?.pool,
      subscribeTeam: storeTeamSubscription(app.store),
    }).then((result) => {
      if (current) setLoaded({ ref: issueRef, result });
    });
    return () => {
      current = false;
    };
  }, [app, api, issueRef, ready, online, inReplica, rejected, attempt, lifecyclePending, refresh]);

  const lastView = last?.ref === issueRef ? last.view : undefined;
  return {
    ready,
    refresh,
    retry: () => {
      setLoaded(undefined);
      setAttempt((n) => n + 1);
    },
    source: chooseIssueSource({
      replica,
      rejected,
      last: lastView,
      loaded: loaded?.ref === issueRef ? loaded.result : undefined,
      deletedHere: lastView !== undefined && lastDelete.get()?.id === lastView.id,
    }),
  };
}

/** Counts the window's focus events: the read-only view asks the server again on each (§3.4). */
function useWindowFocusCount(): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const onFocus = () => {
      setCount((n) => n + 1);
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
    };
  }, []);
  return count;
}

export function IssuePage({ issueRef }: { issueRef: string }) {
  const { ready, source, retry, refresh } = useIssueSource(issueRef);

  if (!ready) return null;
  switch (source.kind) {
    case 'loading':
      return <IssueLoading />;
    case 'not-found':
      return <IssueNotFound issueRef={issueRef} />;
    case 'error':
      return (
        <Unavailable
          title="Couldn't load this issue"
          description="Something went wrong on our side. Try again in a moment."
          action={
            <Button variant="primary" onClick={retry}>
              Try again
            </Button>
          }
        />
      );
    case 'offline':
      return (
        <Unavailable title="Available when online" description="Connect to open this issue." />
      );
    case 'create-rejected':
      return (
        <Unavailable
          title={`This issue couldn't be created: ${source.message}`}
          description=""
          action={<RestoreInComposer issueRef={issueRef} />}
        />
      );
    case 'view':
      // Keyed by issue, so stepping to another one starts with fresh title-edit, drawer and address
      // state.
      return (
        <IssueBody
          key={source.view.id}
          view={source.view}
          readOnly={source.readOnly}
          refresh={refresh}
        />
      );
  }
}

/** E9: reopens the composer with what was sent (SPEC-012 §3.1 item 9). */
function RestoreInComposer({ issueRef }: { issueRef: string }) {
  const app = useApp();
  const commands = useCommandRegistry();
  const input = useObserved(
    useCallback(() => {
      const store = app.store;
      const parsed = parseIssueRef(issueRef);
      if (store === null || parsed?.by !== 'id') return undefined;
      return findRejectedCreate(store.rejections, parsed.id)?.input;
    }, [app, issueRef]),
    Object.is,
  );
  if (input === undefined) return null;
  return (
    <Button
      variant="primary"
      onClick={() => {
        openComposerWith({ kind: 'rejected', input }, (id) => commands.run(id));
      }}
    >
      Restore in composer
    </Button>
  );
}

function IssueLoading() {
  return (
    <>
      <PageHeader crumbs={['Issue']} title="Issue" />
      <div className={pageStyles.loading} aria-busy="true" aria-label="Loading issue">
        <Skeleton width="60%" />
        <Skeleton />
        <Skeleton width="80%" />
      </div>
    </>
  );
}

function Unavailable({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <>
      <PageHeader crumbs={['Issue']} title="Issue" />
      <div className={styles.centered}>
        <EmptyState
          icon={<WifiOff />}
          title={title}
          {...(description === '' ? {} : { description })}
          {...(action === undefined ? {} : { action })}
        />
      </div>
    </>
  );
}

function IssueBody({
  view,
  readOnly,
  refresh,
}: {
  view: IssueView;
  readOnly: boolean;
  refresh: number;
}) {
  const app = useApp();
  // The read-only view's activity, comments and reactions: one server answer, kept in memory.
  const peek = useCallback(
    (issueId: string): Promise<ContentPeek> =>
      app.readyStore?.content.peek(issueId) ?? Promise.resolve({ state: 'offline' }),
    [app],
  );
  const server = useServerContent(view.id, readOnly, peek, refresh);
  const navigate = useNavigate();
  const router = useRouter();
  const pathname = useLocation({ select: (location) => location.pathname });
  const routerState = useLocation({ select: (location) => location.state });
  const mode = usePanelMode();
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Narrowing to one column drops an open drawer: the panel is on the page then, and widening
  // again must not bring a stale drawer back (SPEC-012 §7.3).
  if (mode === 'stacked' && drawerOpen) setDrawerOpen(false);
  // `Shift+R` on a list row opens the page with the title in edit mode (SPEC-012 §3.6).
  const [editing, setEditing] = useState(() => !readOnly && wantsTitleEdit(routerState));
  const now = new Date();

  usePageScope('issue-page');

  // The address the page is at: the router's location when it opened, then what the two
  // replaces made it (AC-13). Kept in a ref so a replace never re-renders or remounts the page.
  const address = useRef(pathname);
  useEffect(() => {
    const next = addressReplacement(
      address.current,
      { id: view.id, number: view.number, title: view.title },
      view.teamKey,
    );
    if (next !== undefined) {
      // On purpose the router's location stays stale: `issue/$ref` and `issue/$ref/$slug` are
      // different routes, so telling the router would remount the page and lose focus and scroll.
      replaceAddress(window.history, next);
      address.current = next;
    }
  }, [view.id, view.number, view.title, view.teamKey]);

  const source = readListSource(routerState);
  const position = source === undefined ? undefined : stepInfo(source.issueIds, view.id);
  const userName = useObserved(
    useCallback(() => {
      const store = app.store;
      const session = app.session;
      if (store === null || store.status !== 'ready' || session === null) return '';
      const user = store.pool.get(User, session.userId);
      return user?.displayName ?? '';
    }, [app]),
  );

  const step = useCallback(
    (direction: Direction) => {
      // Read again at each press (E11): the ids in router state are the list's current ones.
      const target = stepTarget(readListSource(routerState)?.issueIds, view.id, direction);
      if (target === undefined) return;
      // `replace`, so the page is one history entry however far the user steps and Back (or Esc)
      // returns to the list.
      void navigate({
        to: '/issue/$ref',
        params: { ref: target },
        // The next issue opens normally, not in title edit mode.
        state: withoutEditTitle(routerState),
        replace: true,
      });
    },
    [navigate, routerState, view.id],
  );

  const goBack = useCallback(() => {
    // Esc and the browser's Back are the same step (SPEC-012 §3.3 item 8). From a list the page
    // is the entry after it, so going back pops it; without a list there is nothing to pop to.
    // The list restores its own focus and scroll from its focus memory when it comes back.
    if (source === undefined) {
      void navigate({ to: teamListPath(view.teamKey), replace: true });
    } else {
      router.history.back();
    }
  }, [navigate, router, source, view.teamKey]);

  // SPEC-012 §3.4 item 9, §4.2: Esc leaves a text field first (the field handles it), then goes back.
  useCommand('ui:escape', goBack, {
    level: 'page',
    when: () => !isTypingTarget(document.activeElement),
  });
  useCommand('issue-page:next', () => {
    step('next');
  });
  useCommand('issue-page:previous', () => {
    step('previous');
  });
  const editable = !readOnly && view.lifecycle === 'live' && view.teamId !== null;
  // For "Copy issue as Markdown" (§3.7), read when the copy runs: the replica's content on a live
  // page, the server's answer on a read-only one.
  const description = (): DocNodeJSON | null =>
    (readOnly
      ? (view.description ?? descriptionOf(server?.rows['IssueContent'])?.doc)
      : descriptionOf(app.readyStore?.content.rows(view.id)['IssueContent'])?.doc) ?? null;
  // The open issue is the command target (the chip in `Mod+K`, the property commands), and the
  // `issue` commands act on it (PLAN-012 S6).
  useCommandContext({ kind: 'issue', ids: [view.id], label: view.identifier ?? 'New issue' });
  useIssueCommands(
    () => ({
      id: view.id,
      identifier: view.identifier,
      title: view.title,
      teamKey: view.teamKey,
      lifecycle: view.lifecycle,
      editable,
      description: description(),
    }),
    {
      // The properties panel's pill; with the panel closed (the drawer), the page itself.
      anchor: (kind) =>
        document.querySelector(`[data-property="${kind}"]`) ??
        document.querySelector('[data-shortcut-scope="issue"]'),
      rename: () => {
        setEditing(true);
      },
    },
  );

  // Read on click, not in render: the origin is the browser's.
  const copyOf = (kind: CopyKind) => {
    const plan = planCopy(
      kind,
      { ...view, description: description() },
      window.location.origin,
      userName,
    );
    void runCopy(plan, navigator.clipboard);
  };
  const deleteKeys = shortcutsFor('issue:delete')[0];
  const deleteHint = deleteKeys === undefined ? {} : { shortcut: deleteKeys };
  const menu: MenuEntry[] = [
    {
      type: 'submenu',
      label: 'Copy',
      icon: <Copy />,
      items: COPY_ITEMS.map(({ kind, label }) => ({
        type: 'item' as const,
        label,
        onSelect: () => {
          copyOf(kind);
        },
      })),
    },
    ...(editable && view.identifier !== null
      ? ([
          { type: 'separator' },
          {
            type: 'item',
            label: 'Delete',
            icon: <Trash2 />,
            ...deleteHint,
            onSelect: () => {
              if (view.identifier === null) return;
              askDelete({ issueId: view.id, identifier: view.identifier, title: view.title });
            },
          },
        ] satisfies MenuEntry[])
      : []),
  ];

  const saveTitle = (title: string) => {
    const store = app.store;
    if (store === null) return;
    void submitMutation(store, issueUpdate, { issue: view.id, title }).then(toastIfFailed);
  };

  const label = view.identifier ?? 'New issue';
  const badge =
    view.lifecycle === 'archived' ? 'Archived' : view.lifecycle === 'deleted' ? 'Deleted' : null;
  const listCrumb =
    view.lifecycle === 'archived'
      ? 'Archived issues'
      : view.lifecycle === 'deleted'
        ? 'Recently deleted issues'
        : null;

  const panel = (
    <PropertiesPanel
      view={view}
      now={now}
      stacked={mode === 'stacked'}
      {...(editable
        ? {
            onPick: (kind: PickerKind, anchor: HTMLElement) => {
              openPicker({ kind, issueId: view.id, anchor });
            },
          }
        : {})}
    />
  );

  return (
    <>
      {position !== undefined && (
        <PrefetchNeighbours
          {...(position.next === undefined ? {} : { next: position.next })}
          {...(position.previous === undefined ? {} : { previous: position.previous })}
        />
      )}
      <PageHeader
        title={`${label} ${view.title}`}
        crumbs={[
          <Link key="team" to="/team/$key" params={{ key: view.teamKey }}>
            {view.teamKey}
          </Link>,
          listCrumb ?? (
            <Link key="issues" to="/team/$key" params={{ key: view.teamKey }}>
              Issues
            </Link>
          ),
          `${label} ${view.title}`,
        ]}
        actions={
          <>
            {position !== undefined && (
              <span className={pageStyles.position}>
                <span aria-live="polite">{`${position.position} / ${position.total}`}</span>
                <IconButton
                  aria-label="Next issue"
                  icon={<ArrowDown />}
                  disabled={position.next === undefined}
                  onClick={() => {
                    step('next');
                  }}
                />
                <IconButton
                  aria-label="Previous issue"
                  icon={<ArrowUp />}
                  disabled={position.previous === undefined}
                  onClick={() => {
                    step('previous');
                  }}
                />
              </span>
            )}
            <IconButton aria-label="Copy link" icon={<LinkIcon />} onClick={() => copyOf('url')} />
            <IconButton aria-label="Copy ID" icon={<Hash />} onClick={() => copyOf('id')} />
            <IconButton
              aria-label="Copy git branch name"
              icon={<GitBranch />}
              onClick={() => copyOf('branch')}
            />
            {mode === 'drawer' && (
              <IconButton
                aria-label="Properties"
                aria-expanded={drawerOpen}
                icon={<PanelRight />}
                onClick={() => {
                  setDrawerOpen((open) => !open);
                }}
              />
            )}
            <Menu
              align="end"
              trigger={<IconButton aria-label="More actions" icon={<MoreHorizontal />} />}
              items={menu}
            />
          </>
        }
      />
      <div className={pageStyles.layout} data-shortcut-scope="issue">
        <article className={pageStyles.column}>
          <div className={pageStyles.titleRow}>
            <EditableTitle
              value={view.title}
              editing={editing}
              onEditingChange={setEditing}
              onSave={saveTitle}
              readOnly={readOnly}
            />
            {badge !== null && <Badge>{badge}</Badge>}
          </div>
          {mode === 'stacked' && panel}
          {editable ? (
            <StoreProvided>
              <LiveDescription issueId={view.id} />
            </StoreProvided>
          ) : (
            <ReadOnlyDescription
              doc={view.description ?? descriptionOf(server?.rows['IssueContent'])?.doc}
              state={server?.state ?? 'loading'}
            />
          )}
          {readOnly
            ? server !== undefined && <ServerSlots view={view} server={server} />
            : view.teamId !== null && (
                <>
                  <Slots view={view} teamId={view.teamId} part="under-description" />
                  <Slots view={view} teamId={view.teamId} part="comments" />
                </>
              )}
        </article>
        {mode !== 'stacked' && (mode === 'inline' || drawerOpen) && (
          <aside className={mode === 'drawer' ? pageStyles.drawer : pageStyles.aside}>
            {panel}
          </aside>
        )}
      </div>
    </>
  );
}

/** The store for sync-react's hooks, wherever the page mounts (the shell provides it too). */
function StoreProvided({ children }: { children: ReactNode }) {
  const app = useApp();
  const store = app.readyStore;
  return store === null ? null : <SyncStoreProvider store={store}>{children}</SyncStoreProvider>;
}

/**
 * The read-only view's reactions and activity (§3.4 item 8): the same slots, fed by the server's
 * answer through `ServerContentContext` (`useIssueContentView`), with every write control hidden.
 * A slot reads `content.server` to know it is read-only.
 */
function ServerSlots({ view, server }: { view: IssueView; server: ServerContent }) {
  return (
    <ServerContentContext value={server}>
      <Slots view={view} teamId={view.teamId ?? ''} part="under-description" />
      <Slots view={view} teamId={view.teamId ?? ''} part="comments" />
    </ServerContentContext>
  );
}

/**
 * `J` and `K` open these next (SPEC-012 §3.4): their content is prefetched (SPEC-011 §5.4). In its
 * own provider, as `Slots`, so the page works wherever it mounts.
 */
function PrefetchNeighbours({ next, previous }: { next?: string; previous?: string }) {
  const store = useApp().readyStore;
  if (store === null) return null;
  return (
    <SyncStoreProvider store={store}>
      <Prefetch ids={[next, previous].filter((id): id is string => id !== undefined)} />
    </SyncStoreProvider>
  );
}

function Prefetch({ ids }: { ids: readonly string[] }) {
  usePrefetchContent(ids);
  return null;
}

function Slots({
  view,
  teamId,
  part,
}: {
  view: IssueView;
  teamId: string;
  part: 'under-description' | 'comments';
}) {
  const app = useApp();
  const store = app.readyStore;
  const { reactions: Reactions, attachments: Attachments, comments: Comments } = ISSUE_PAGE_SLOTS;
  const props = { issueId: view.id, teamId };
  const slots =
    part === 'comments' ? (
      Comments !== null && <Comments {...props} />
    ) : (
      <>
        {Reactions !== null && <Reactions {...props} />}
        {Attachments !== null && <Attachments {...props} />}
      </>
    );
  // The comment slots read the issue's content through sync-react (PLAN-013 S5). The shell already
  // provides the store; providing it here makes the page's slots work wherever the page mounts.
  return store === null ? null : <SyncStoreProvider store={store}>{slots}</SyncStoreProvider>;
}
