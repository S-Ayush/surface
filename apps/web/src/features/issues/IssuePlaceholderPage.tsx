// `/issue/:ref/:slug?` until PLAN-012 S4 builds the issue page (PLAN-011 S4): the identifier and
// title from the replica. Any slug resolves, and the address is replaced with the canonical one
// without a history entry (SPEC-011 §4.1, E27); a pending issue stays at `/issue/<id>` and moves
// to `/issue/ENG-42/<slug>` when its number arrives (Q14). An issue the replica doesn't hold is
// not found, worded like any missing page (E13).
import { EmptyState } from '@surface/ui';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { CircleDot } from 'lucide-react';
import { useCallback, useEffect } from 'react';
import { useApp, useObserved } from '../../app/context.js';
import { PageHeader } from '../../shell/PageHeader.js';
import { NotFoundPage } from '../../pages/NotFoundPage.js';
import styles from '../../pages/Pages.module.css';
import { poolIssueLookup, resolveIssueAddress } from './issue-url.js';

export function IssuePlaceholderPage({ issueRef }: { issueRef: string }) {
  const app = useApp();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const resolved = useObserved(
    useCallback(() => {
      const store = app.store;
      if (store === null || store.status !== 'ready') return null;
      const address = resolveIssueAddress(issueRef, poolIssueLookup(store.pool));
      return address.kind === 'found'
        ? {
            kind: address.kind,
            identifier: address.identifier,
            title: address.issue.title,
            canonical: address.canonical,
          }
        : address;
    }, [app, issueRef]),
  );

  const canonical = resolved?.kind === 'found' ? resolved.canonical : undefined;
  useEffect(() => {
    if (canonical !== undefined && canonical !== pathname) {
      void navigate({ href: canonical, replace: true });
    }
  }, [canonical, pathname, navigate]);

  if (resolved === null) return null;
  if (resolved.kind === 'not-found') return <NotFoundPage />;
  const label = resolved.identifier ?? 'New issue';
  return (
    <>
      <PageHeader crumbs={[label]} title={resolved.title} />
      <div className={styles.centered}>
        <EmptyState icon={<CircleDot />} title={`${label} ${resolved.title}`} />
      </div>
    </>
  );
}
