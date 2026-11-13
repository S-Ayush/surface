// The issue page (SPEC-012 §3.4, PLAN-012 S4 part 1): header, title, description (read-only for
// now), the slots later slices fill, and the properties panel. It renders one `IssueView`, from the
// replica (live, editable) or from `issue.get` (read-only), chosen by `chooseIssueSource`.
//
// Not here yet (PLAN-012 S4 follow-up, PLAN-011 S6): the description editor and its save
// controller, the activity stream with history lines, `content.peek` for the read-only view, the
// live deleted/archived switch with hydration on open.
import {
  Badge,
  EditableTitle,
  EmptyState,
  IconButton,
  Menu,
  Skeleton,
  toast,
  type MenuEntry,
} from '@surface/ui';
import { issueUpdate } from '@surface/operations';
import { Link, useLocation, useNavigate } from '@tanstack/react-router';
import {
  ArrowDown,
  ArrowUp,
  Copy,
  GitBranch,
  Hash,
  Link as LinkIcon,
  MoreHorizontal,
  PanelRight,
  WifiOff,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { parseIssueRef } from '@surface/domain';
import { User } from '@surface/domain/model';
import { useApp, useObserved } from '../../app/context.js';
import { structurallyEqual } from '../../app/equal.js';
import { PageHeader } from '../../shell/PageHeader.js';
import { useCommand, usePageScope } from '../../shortcuts/ShortcutProvider.js';
import { isTypingTarget } from '../../shortcuts/engine.js';
import styles from '../../pages/Pages.module.css';
import { copyText } from '../members/reset-link.js';
import { submitMutation, toastIfFailed } from '../teams/submit.js';
import { IssueNotFound } from './IssueNotFound.js';
import { useIssueApi } from './issue-api.js';
import { issueCopyValues } from './issue-copy.js';
import {
  chooseIssueSource,
  heldRejection,
  loadMissingIssue,
  NO_TEAM_SUBSCRIPTION,
  type IssueLoadResult,
} from './issue-loader.js';
import {
  addressReplacement,
  poolIssueLookup,
  replaceAddress,
  resolveIssueAddress,
} from './issue-url.js';
import { issueViewFromPool, type IssueView } from './issue-view.js';
import { usePanelMode } from './panel-layout.js';
import { PropertiesPanel } from './PropertiesPanel.js';
import { ISSUE_PAGE_SLOTS } from './slots.js';
import {
  backTarget,
  readSourceList,
  restoreFocusOn,
  stepInfo,
  stepTarget,
  type Direction,
} from './source-list.js';
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

  const [last, setLast] = useState<IssueView | undefined>(undefined);
  const [loaded, setLoaded] = useState<
    { readonly ref: string; readonly result: IssueLoadResult } | undefined
  >(undefined);
  const inReplica = replica !== undefined;
  // Adjusting state while rendering (react.dev "storing information from previous renders"): the
  // last row the replica had, shown read-only if it leaves the replica while open (E3).
  if (replica !== undefined && !structurallyEqual(replica, last)) setLast(replica);

  useEffect(() => {
    // Nothing to fetch while the replica loads, while it holds the row, or for a held rejection.
    if (!ready || inReplica || rejected !== undefined) return;
    let current = true;
    void loadMissingIssue(issueRef, {
      get: (ref) => api.get(ref),
      online: () => app.store?.connection === 'online',
      subscribeTeam: NO_TEAM_SUBSCRIPTION,
    }).then((result) => {
      if (current) setLoaded({ ref: issueRef, result });
    });
    return () => {
      current = false;
    };
  }, [app, api, issueRef, ready, online, inReplica, rejected]);

  return {
    ready,
    source: chooseIssueSource({
      replica,
      rejected,
      last: last?.id === replica?.id || replica === undefined ? last : undefined,
      loaded: loaded?.ref === issueRef ? loaded.result : undefined,
    }),
  };
}

export function IssuePage({ issueRef }: { issueRef: string }) {
  const app = useApp();
  const { ready, source } = useIssueSource(issueRef);
  const teamKey = useObserved(
    useCallback(() => {
      const store = app.store;
      if (store === null || store.status !== 'ready') return undefined;
      const parsed = parseIssueRef(issueRef);
      if (parsed?.by !== 'identifier') return undefined;
      return resolveIssueAddress(`${parsed.key}-1`, poolIssueLookup(store.pool)).kind === 'found'
        ? parsed.key
        : undefined;
    }, [app, issueRef]),
  );

  if (!ready) return null;
  switch (source.kind) {
    case 'loading':
      return <IssueLoading />;
    case 'not-found':
      return <IssueNotFound issueRef={issueRef} teamKey={teamKey} />;
    case 'offline':
      return (
        <Unavailable title="Available when online" description="Connect to open this issue." />
      );
    case 'create-rejected':
      return (
        <Unavailable title={`This issue couldn't be created: ${source.message}`} description="" />
      );
    case 'view':
      return <IssueBody view={source.view} readOnly={source.readOnly} />;
  }
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

function Unavailable({ title, description }: { title: string; description: string }) {
  return (
    <>
      <PageHeader crumbs={['Issue']} title="Issue" />
      <div className={styles.centered}>
        <EmptyState
          icon={<WifiOff />}
          title={title}
          {...(description === '' ? {} : { description })}
        />
      </div>
    </>
  );
}

async function copy(value: string | null, what: string) {
  if (value === null) {
    toast({ message: 'This issue has no number yet. Try again in a moment.' });
    return;
  }
  const copied = await copyText(value, navigator.clipboard);
  toast(
    copied
      ? { message: `Copied ${what}` }
      : { tone: 'danger', message: `Couldn't copy ${what}. Select it and copy it by hand.` },
  );
}

function IssueBody({ view, readOnly }: { view: IssueView; readOnly: boolean }) {
  const app = useApp();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const routerState = useLocation({ select: (location) => location.state });
  const mode = usePanelMode();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const now = new Date();

  usePageScope('issue-page');

  // The address the page is at: the router's location when it opened, then what the two
  // replaces made it (AC-13). Kept in a ref so a replace never re-renders or remounts the page.
  const address = useRef(pathname);
  useEffect(() => {
    const next = addressReplacement(
      address.current,
      { id: view.id, teamId: view.teamId, number: view.number, title: view.title },
      view.teamKey,
    );
    if (next !== undefined) {
      replaceAddress(window.history, next);
      address.current = next;
    }
  }, [view.id, view.teamId, view.number, view.title, view.teamKey]);

  const source = readSourceList(routerState);
  const position = source === undefined ? undefined : stepInfo(source.ids, view.id);
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
      const target = stepTarget(readSourceList(routerState)?.ids, view.id, direction);
      if (target === undefined) return;
      void navigate({ to: '/issue/$ref', params: { ref: target }, state: routerState });
    },
    [navigate, routerState, view.id],
  );

  const goBack = useCallback(() => {
    void navigate({ to: backTarget(source, view.teamKey) }).then(() => {
      restoreFocusOn(view.id);
    });
  }, [navigate, source, view.teamKey, view.id]);

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
  useCommand(
    'issue:rename',
    () => {
      setEditing(true);
    },
    { when: () => !readOnly },
  );

  // Read on click, not in render: the origin is the browser's.
  const copyOf = (kind: 'id' | 'link' | 'branch') => {
    const values = issueCopyValues(view, window.location.origin, userName);
    void copy(values[kind], kind === 'branch' ? 'branch name' : kind === 'id' ? 'ID' : 'link');
  };
  const menu: MenuEntry[] = [
    {
      type: 'submenu',
      label: 'Copy',
      icon: <Copy />,
      items: [
        { type: 'item', label: 'Copy ID', onSelect: () => copyOf('id') },
        { type: 'item', label: 'Copy link', onSelect: () => copyOf('link') },
        {
          type: 'item',
          label: 'Copy git branch name',
          onSelect: () => copyOf('branch'),
        },
      ],
    },
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
            <IconButton aria-label="Copy link" icon={<LinkIcon />} onClick={() => copyOf('link')} />
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
          {!readOnly && <Slots view={view} part="under-description" />}
          {/* TODO(PLAN-012 S4 follow-up): ActivityStream (needs IssueHistory, PLAN-011 S6). */}
          <section aria-label="Activity" data-slot="activity" />
          {!readOnly && <Slots view={view} part="comments" />}
        </article>
        {(mode === 'inline' || drawerOpen) && (
          <aside className={mode === 'drawer' ? pageStyles.drawer : pageStyles.aside}>
            <PropertiesPanel view={view} now={now} />
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

function Slots({ view, part }: { view: IssueView; part: 'under-description' | 'comments' }) {
  const { reactions: Reactions, attachments: Attachments, comments: Comments } = ISSUE_PAGE_SLOTS;
  const props = { issueId: view.id, teamId: view.teamId };
  if (part === 'comments') return Comments === null ? null : <Comments {...props} />;
  return (
    <>
      {Reactions !== null && <Reactions {...props} />}
      {Attachments !== null && <Attachments {...props} />}
    </>
  );
}
