// The signed-in part of the app: opens the client store for the session (SPEC-002 §5), renders
// the shell around the page, and holds the page back until the replica is first ready (SPEC-005
// §3 "Store not ready → shell with a bootstrap progress bar", SPEC-002 §7; app/gate.ts).
import { PRODUCTION_MODELS } from '@surface/domain/model';
import { SyncStore } from '@surface/sync-client';
import { BANNER_PRIORITY, Button, EmptyState, ProgressBar, banner, toast } from '@surface/ui';
import { Outlet } from '@tanstack/react-router';
import { CloudAlert, RefreshCw } from 'lucide-react';
import { reaction } from 'mobx';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Shell } from '../shell/Shell.js';
import styles from '../shell/Shell.module.css';
import type { AppModel } from './AppModel.js';
import type { Session } from './auth.js';
import { useApp, useObserved } from './context.js';
import { gateView } from './gate.js';

export function ShellRoute() {
  const app = useApp();
  const session = useObserved(useCallback(() => app.session, [app]));
  // Signed out: the router's guard is already on its way to /login.
  if (session === null) return null;
  // A new identity gets a new store (and a fresh shell), never the previous user's replica.
  return <SessionShell key={`${session.workspaceId}/${session.userId}`} session={session} />;
}

function SessionShell({ session }: { session: Session }) {
  const app = useApp();
  useSyncStore(app, session);
  return (
    <Shell>
      <StoreGate>
        <Outlet />
      </StoreGate>
    </Shell>
  );
}

/** The store records a failed start in its status, which StoreGate shows. */
const failureShownByStatus = () => undefined;

const OUTDATED_BANNER = 'store-outdated';

function useSyncStore(app: AppModel, { userId, workspaceId }: Session): void {
  useEffect(() => {
    // Before the first ready, StoreGate's own screen says the client is outdated.
    let readyOnce = false;
    const store = new SyncStore({
      // The server's model set, so the schema hashes match (PLAN-001 S1 handoff).
      models: PRODUCTION_MODELS,
      workspaceId,
      userId,
      fetch: (url, init) => window.fetch(url, init),
      // SPEC-002 E10: the session was revoked; the guards send the user to /login.
      onSessionRevoked: () => {
        app.auth.signedOut();
      },
      // SPEC-002 §3.5: the optimistic change is gone; say why.
      onRejected: (rejection) => {
        toast({ tone: 'danger', message: rejection.message });
      },
      // SPEC-002 E7, SPEC-005 §8: persistent, and above any dismissible warning.
      onOutdated: () => {
        if (!readyOnce) return;
        banner.show(OUTDATED_BANNER, {
          tone: 'info',
          message: 'Surface was updated.',
          action: { label: 'Reload', onAction: reload },
          dismissible: false,
          priority: BANNER_PRIORITY.blocking,
        });
      },
    });
    const stopWatching = reaction(
      () => store.status === 'ready',
      (ready) => {
        if (ready) readyOnce = true;
      },
    );
    app.setStore(store);
    store.start().catch(failureShownByStatus);
    return () => {
      stopWatching();
      banner.hide(OUTDATED_BANNER);
      app.setStore(null);
      void store.close();
    };
  }, [app, userId, workspaceId]);
}

const reload = () => {
  window.location.reload();
};

function StoreGate({ children }: { children: ReactNode }) {
  const app = useApp();
  const view = useObserved(
    useCallback(() => {
      const store = app.store;
      const progress = store?.progress;
      return {
        status: store?.status ?? ('idle' as const),
        percent:
          progress !== undefined && progress.total > 0
            ? Math.round((progress.loaded / progress.total) * 100)
            : null,
      };
    }, [app]),
  );
  // Derived from the previous render, so the page stays once the replica has been ready.
  const [readyOnce, setReadyOnce] = useState(false);
  if (view.status === 'ready' && !readyOnce) setReadyOnce(true);
  const shown = gateView(view.status, readyOnce);
  if (shown === 'page') return children;
  if (shown === 'failed' || shown === 'outdated') {
    const outdated = shown === 'outdated';
    return (
      <div className={styles.loading}>
        <EmptyState
          icon={outdated ? <RefreshCw /> : <CloudAlert />}
          title={outdated ? 'Surface was updated' : "Surface couldn't load your workspace"}
          description={
            outdated
              ? 'Reload the page to get the new version.'
              : 'Check your connection, then reload the page.'
          }
          action={
            <Button variant="primary" onClick={reload}>
              Reload
            </Button>
          }
        />
      </div>
    );
  }
  return (
    <div className={styles.loading}>
      <p>Syncing your workspace…</p>
      <ProgressBar aria-label="Syncing workspace" value={view.percent} />
    </div>
  );
}
