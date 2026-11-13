// My issues (SPEC-012 §3.9): Assigned at `/my-issues`, Created at `/my-issues/created`. Both render
// from the replica, offline too: it holds every issue assigned to or created by the user.
import { EmptyState } from '@surface/ui';
import { Link } from '@tanstack/react-router';
import { Inbox } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useApp } from '../../app/context.js';
import { PageHeader } from '../../shell/PageHeader.js';
import { IssueList } from './IssueList.js';
import styles from './IssueList.module.css';
import { myIssuesKey } from './focus-model.js';
import { CreateIssueButton, ListSkeleton } from './IssueListPage.js';
import type { ListScope } from './list-model.js';
import { myIssuesPath, rememberMyIssuesTab, type MyIssuesTab } from './my-issues-tab.js';
import { useIssueRows } from './useIssueRows.js';

const EMPTY: Record<MyIssuesTab, { title: string; description?: string }> = {
  assigned: {
    title: 'Nothing is assigned to you',
    description: 'Issues assigned to you show up here.',
  },
  created: { title: "You haven't created any issues yet" },
};

export function MyIssuesPage({ tab = 'assigned' }: { tab?: MyIssuesTab }) {
  const app = useApp();
  const userId = app.session?.userId ?? '';
  const scope = useMemo<ListScope>(() => ({ kind: tab, userId }), [tab, userId]);
  const rows = useIssueRows(scope);
  useEffect(() => {
    rememberMyIssuesTab(tab);
  }, [tab]);

  const empty = EMPTY[tab];
  return (
    <>
      <PageHeader crumbs={['My issues']} title="My issues" />
      {/* Subscribed (M4) and Activity (later) stay hidden until they are built. */}
      <nav aria-label="My issues views" className={styles.tabs}>
        {(['assigned', 'created'] as const).map((value) => (
          <Link
            key={value}
            to={value === 'assigned' ? '/my-issues' : '/my-issues/created'}
            activeOptions={{ exact: true }}
            className={styles.tab}
            aria-current={value === tab ? 'page' : undefined}
          >
            {value === 'assigned' ? 'Assigned' : 'Created'}
          </Link>
        ))}
      </nav>
      {!rows.ready ? (
        <ListSkeleton />
      ) : rows.groups.length === 0 ? (
        <div className={styles.empty}>
          <EmptyState
            icon={<Inbox />}
            title={empty.title}
            {...(empty.description === undefined ? {} : { description: empty.description })}
            action={<CreateIssueButton />}
          />
        </div>
      ) : (
        <div className={styles.area}>
          <IssueList
            key={tab}
            ariaLabel={tab === 'assigned' ? 'Issues assigned to you' : 'Issues you created'}
            listKey={myIssuesKey(tab)}
            href={myIssuesPath(tab)}
            groups={rows.groups}
          />
        </div>
      )}
    </>
  );
}
