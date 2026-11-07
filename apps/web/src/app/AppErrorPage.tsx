// The root error page: auth could not be loaded, or a route failed unexpectedly. It never shows
// the error itself (CLAUDE.md: messages say how to fix the problem, not internals).
import { Button, EmptyState } from '@surface/ui';
import { CloudAlert } from 'lucide-react';
import { usePageTitle } from '../shell/usePageTitle.js';
import styles from '../pages/Pages.module.css';
import { useApp } from './context.js';

export function AppErrorPage() {
  const app = useApp();
  usePageTitle('Something went wrong');
  const snapshot = app.auth.snapshot;
  return (
    <main className={styles.public} tabIndex={-1}>
      <EmptyState
        icon={<CloudAlert />}
        title={
          snapshot.status === 'failed' ? "Surface can't reach the server" : 'Something went wrong'
        }
        description={
          snapshot.status === 'failed' ? snapshot.message : 'Reload the page to try again.'
        }
        action={
          <Button
            variant="primary"
            onClick={() => {
              window.location.reload();
            }}
          >
            Reload
          </Button>
        }
      />
    </main>
  );
}
