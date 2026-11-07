// Not found (SPEC-005 §3 `*`), also shown for admin routes a Member opens, so they never learn
// those routes exist (permissions.md §5).
import { Button, EmptyState } from '@surface/ui';
import { useNavigate } from '@tanstack/react-router';
import { MapPinOff } from 'lucide-react';
import { PageHeader } from '../shell/PageHeader.js';
import { usePageTitle } from '../shell/usePageTitle.js';
import styles from './Pages.module.css';

const TITLE = 'Page not found';

function NotFoundBody() {
  const navigate = useNavigate();
  return (
    <EmptyState
      icon={<MapPinOff />}
      title="This page doesn't exist"
      description="Check the address, or go back to your home page."
      action={
        <Button
          variant="primary"
          onClick={() => {
            void navigate({ to: '/' });
          }}
        >
          Go home
        </Button>
      }
    />
  );
}

/** Inside the shell. */
export function NotFoundPage() {
  return (
    <>
      <PageHeader crumbs={[TITLE]} title={TITLE} />
      <div className={styles.centered}>
        <NotFoundBody />
      </div>
    </>
  );
}

/** Outside the shell: an address that matches no route at all. */
export function StandaloneNotFoundPage() {
  usePageTitle(TITLE);
  return (
    <main className={styles.public} tabIndex={-1}>
      <NotFoundBody />
    </main>
  );
}
