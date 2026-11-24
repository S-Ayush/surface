// The team archive page (SPEC-015 §3.3, §7; PLAN-015 S4): "Archived issues", with the tabs Issues
// (`/team/:key/archive`) and Recently deleted issues (`/team/:key/archive/recently-deleted`). Both
// read the server (`archive-source.ts`), since the replica holds no archived or deleted issue. Rows
// are normal issue rows in one flat list, newest first, whose date shows the archive or deletion
// day; their menu has Copy › and Restore (`#`).
import { Button, EmptyState } from '@surface/ui';
import { Link } from '@tanstack/react-router';
import { Archive, CloudOff, WifiOff } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useApp, useObserved } from '../../app/context.js';
import { useCommandContext } from '../../command-menu/context.js';
import { GLOBAL_TARGET } from '../../command-menu/model.js';
import { NotFoundPage } from '../../pages/NotFoundPage.js';
import { PageHeader } from '../../shell/PageHeader.js';
import { IssueList, type ArchiveListOptions } from '../issues/IssueList.js';
import styles from '../issues/IssueList.module.css';
import { ListSkeleton } from '../issues/ListParts.js';
import { archiveGroups, type ArchivedIssue } from '../issues/list-model.js';
import { readListLookups } from '../issues/useIssueRows.js';
import { teamArchivePath } from './paths.js';
import type { ArchiveTab } from './archive-source.js';
import { useArchiveSource } from './useArchiveSource.js';
import type { LifecycleSubject } from './useLifecycleCommands.js';

const TABS: readonly { readonly tab: ArchiveTab; readonly label: string }[] = [
  { tab: 'archived', label: 'Issues' },
  { tab: 'deleted', label: 'Recently deleted issues' },
];

export const EMPTY_TITLE = 'No matching issues';

function subjectOf(issue: ArchivedIssue): LifecycleSubject {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    lifecycle:
      issue.deletedAt !== null ? 'deleted' : issue.archivedAt !== null ? 'archived' : 'live',
    deletedAt: issue.deletedAt,
  };
}

export function ArchiveScreen({ teamKey, tab }: { teamKey: string; tab: ArchiveTab }) {
  const app = useApp();
  const team = useObserved(
    useCallback(() => {
      const row = app.team(teamKey);
      return row === undefined ? null : { id: row.id, key: row.key, name: row.name };
    }, [app, teamKey]),
  );
  const ready = useObserved(useCallback(() => app.readyStore !== null, [app]));
  useCommandContext(
    team === null ? GLOBAL_TARGET : { kind: 'team', ids: [team.id], label: team.key },
  );
  const { state, source } = useArchiveSource(tab, team);
  const issues = state.status === 'ready' ? state.issues : null;
  const teamId = team?.id;
  // Status colours, estimate scales and avatars from the replica, when it holds them. Built in the
  // observed read, so a replica change that leaves the rows as they were doesn't re-render.
  const groups = useObserved(
    useCallback(() => {
      const store = app.readyStore;
      if (store === null || issues === null || teamId === undefined) return [];
      return archiveGroups(tab, teamId, issues, readListLookups(store.pool));
    }, [app, issues, teamId, tab]),
  );
  const byId = useMemo(
    () => new Map((issues ?? []).map((issue) => [issue.id, subjectOf(issue)])),
    [issues],
  );
  const archive = useMemo<ArchiveListOptions>(
    () => ({
      subjectOf: (issueId) => byId.get(issueId),
      onEndReached: () => {
        void source?.loadMore();
      },
    }),
    [byId, source],
  );

  if (!ready) return null;
  // A team the user can't see reads like one that doesn't exist (permissions §5).
  if (team === null) return <NotFoundPage />;

  const header = (
    <>
      <PageHeader crumbs={[team.name, 'Archived issues']} title="Archived issues" />
      <nav aria-label="Archive views" className={styles.tabs}>
        {TABS.map(({ tab: value, label }) => (
          <Link
            key={value}
            to={teamArchivePath(team.key, value)}
            activeOptions={{ exact: true }}
            className={styles.tab}
            aria-current={value === tab ? 'page' : undefined}
          >
            {label}
          </Link>
        ))}
      </nav>
    </>
  );

  let body;
  switch (state.status) {
    case 'loading':
      body = <ListSkeleton />;
      break;
    case 'offline':
      body = (
        <div className={styles.empty}>
          <EmptyState icon={<CloudOff />} title="Available when online" />
        </div>
      );
      break;
    case 'error':
      body = (
        <div className={styles.empty}>
          <EmptyState
            icon={<WifiOff />}
            title={state.message}
            action={
              <Button variant="primary" onClick={() => void source?.refresh()}>
                Try again
              </Button>
            }
          />
        </div>
      );
      break;
    case 'ready':
      body =
        groups.length === 0 ? (
          <div className={styles.empty}>
            <EmptyState icon={<Archive />} title={EMPTY_TITLE} />
          </div>
        ) : (
          <div className={styles.area}>
            <IssueList
              key={`${team.key}:${tab}`}
              ariaLabel={
                tab === 'archived'
                  ? `Archived issues in ${team.key}`
                  : `Recently deleted issues in ${team.key}`
              }
              listKey={`archive:${team.key.toUpperCase()}:${tab}`}
              href={teamArchivePath(team.key, tab)}
              groups={groups}
              archive={archive}
            />
          </div>
        );
      break;
  }
  return (
    <>
      {header}
      {body}
    </>
  );
}
