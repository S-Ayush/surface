// The issue page (SPEC-012 §3.4, PLAN-012 S4 part 1): header, title, description (read-only for
// now), the slots later slices fill, and the properties panel. It renders one `IssueView`, from the
// replica (live, editable) or from `issue.get` (read-only), chosen by `chooseIssueSource`.
//
// Not here yet (PLAN-012 S4 follow-up, PLAN-011 S6): the description editor and its save
// controller, the activity stream with history lines, `content.peek` for the read-only view, the
// live deleted/archived switch with hydration on open.
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
import { parseIssueRef } from '@surface/domain';
import { User } from '@surface/domain/model';
import { useApp, useObserved } from '../../app/context.js';
import { useCommandContext } from '../../command-menu/context.js';
import { askDelete } from './delete-flow.js';
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
  const inReplica = replica !== undefined;
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

  useEffect(() => {
    // Nothing to fetch while the replica loads, while it holds the row, or for a held rejection.
    if (!ready || inReplica || rejected !== undefined) return;
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
  }, [app, api, issueRef, ready, online, inReplica, rejected, attempt]);

  return {
    ready,
    retry: () => {
      setLoaded(undefined);
      setAttempt((n) => n + 1);
    },
    source: chooseIssueSource({
      replica,
      rejected,
      last: last?.ref === issueRef ? last.view : undefined,
      loaded: loaded?.ref === issueRef ? loaded.result : undefined,
    }),
  };
}

export function IssuePage({ issueRef }: { issueRef: string }) {
  const { ready, source, retry } = useIssueSource(issueRef);

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
      return <IssueBody key={source.view.id} view={source.view} readOnly={source.readOnly} />;
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

function IssueBody({ view, readOnly }: { view: IssueView; readOnly: boolean }) {
  const app = useApp();
  const navigate = useNavigate();
  const router = useRouter();
  const pathname = useLocation({ select: (location) => location.pathname });
  const routerState = useLocation({ select: (location) => location.state });
  const mode = usePanelMode();
  const [drawerOpen, setDrawerOpen] = useState(false);
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
    const plan = planCopy(kind, view, window.location.origin, userName);
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

  return (
    <>
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
          {/* TODO(PLAN-012 S4 follow-up, PLAN-011 S6): the description editor and its save
              controller. Until `issue.updateDescription` exists the page has no description to
              show: the row doesn't carry one (IssueContent arrives with S5a/S6). */}
          <DescriptionArea />
          {!readOnly && view.teamId !== null && (
            <Slots view={view} teamId={view.teamId} part="under-description" />
          )}
          {/* TODO(PLAN-012 S4 follow-up): ActivityStream (needs IssueHistory, PLAN-011 S6). */}
          <section aria-label="Activity" data-slot="activity" />
          {!readOnly && view.teamId !== null && (
            <Slots view={view} teamId={view.teamId} part="comments" />
          )}
        </article>
        {(mode === 'inline' || drawerOpen) && (
          <aside className={mode === 'drawer' ? pageStyles.drawer : pageStyles.aside}>
            <PropertiesPanel
              view={view}
              now={now}
              {...(editable
                ? {
                    onPick: (kind: PickerKind, anchor: HTMLElement) => {
                      openPicker({ kind, issueId: view.id, anchor });
                    },
                  }
                : {})}
            />
          </aside>
        )}
      </div>
    </>
  );
}

function DescriptionArea() {
  return (
    <section aria-label="Description" className={pageStyles.description}>
      <p className={pageStyles.placeholder}>No description</p>
    </section>
  );
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
  const { reactions: Reactions, attachments: Attachments, comments: Comments } = ISSUE_PAGE_SLOTS;
  const props = { issueId: view.id, teamId };
  if (part === 'comments') return Comments === null ? null : <Comments {...props} />;
  return (
    <>
      {Reactions !== null && <Reactions {...props} />}
      {Attachments !== null && <Attachments {...props} />}
    </>
  );
}
