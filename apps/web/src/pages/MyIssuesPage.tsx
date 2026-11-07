// My issues (SPEC-005 §3): an empty state in M0, where nothing is assigned yet.
import { EmptyState } from '@surface/ui';
import { Inbox } from 'lucide-react';
import { PageHeader } from '../shell/PageHeader.js';
import styles from './Pages.module.css';

export function MyIssuesPage() {
  return (
    <>
      <PageHeader crumbs={['My issues']} title="My issues" />
      <div className={styles.centered}>
        <EmptyState
          icon={<Inbox />}
          title="No issues assigned to you"
          description="Issues assigned to you will appear here."
        />
      </div>
    </>
  );
}
