// The signed-in part of the app: opens the client store for the session (SPEC-002 §5), renders
// the shell around the page, and holds the page back until the replica is first ready (SPEC-005
// §3 "Store not ready → shell with a bootstrap progress bar", SPEC-002 §7; app/gate.ts).
import { PRODUCTION_MODELS, Team } from '@surface/domain/model';
import { SyncStore, statusGoneMessage, type SeenDeletes } from '@surface/sync-client';
import { SyncInspector, SyncStoreProvider, inspectorAllowed } from '@surface/sync-react';
import { BANNER_PRIORITY, Button, EmptyState, ProgressBar, banner, toast } from '@surface/ui';
import { Outlet } from '@tanstack/react-router';
import { CloudAlert, RefreshCw } from 'lucide-react';
import { reaction } from 'mobx';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { followPreferences } from '../preferences/apply.js';
import { savePreferences } from '../preferences/save.js';
import { Shell } from '../shell/Shell.js';
import { commentActionsFor } from '../features/comments/useComments.js';
import { SystemBanners } from '../shell/SystemBanners.js';
import { browserThemeEnvironment } from '../theme/toggleTheme.js';
import styles from '../shell/Shell.module.css';
import type { AppModel } from './AppModel.js';
import type { Session } from './auth.js';
import { useApp, useObserved } from './context.js';
import { gateView } from './gate.js';
import { runStore, sessionAuthHooks } from './session-store.js';

export function ShellRoute() {
  const app = useApp();
  const current = useObserved(
    useCallback(() => {
      const snapshot = app.auth.snapshot;
      return snapshot.status === 'ready' && snapshot.session !== null
        ? { session: snapshot.session, epoch: snapshot.epoch }
        : null;
    }, [app]),
  );
  // Signed out: the router's guard is already on its way to /login.
  if (current === null) return null;
  const { session, epoch } = current;
  // Each session gets a new store and a fresh shell: never the previous user's replica, and a
  // new socket after a 4001 even for the same user (the old one stays closed for good). A mutate
  // 401 that the same session answers keeps the store (AuthState.recheck, SPEC-002 E14).
  return (
    <SessionShell
      key={`${epoch}/${session.workspaceId}/${session.userId}`}
      session={session}
      epoch={epoch}
    />
  );
}

function SessionShell({ session, epoch }: { session: Session; epoch: number }) {
  const app = useApp();
  useSyncStore(app, session, epoch);
  // The user's theme and font size, from the replica and live from their other tabs (AC-10).
  useEffect(
    () =>
      followPreferences(
        {
          read: () => {
            const preferences = app.preferences();
            const theme = app.savedTheme();
            return preferences && theme !== undefined
              ? { theme, fontSize: preferences.fontSize }
              : undefined;
          },
          adopt: (theme) => {
            const store = app.readyStore;
            if (store !== null) savePreferences(store, { theme });
          },
        },
        browserThemeEnvironment(),
        document.documentElement,
      ),
    [app],
  );
  const store = useObserved(
    useCallback(() => app.store, [app]),
    Object.is,
  );
  return (
    <Shell
      docked={
        store !== null && (
          <SyncStoreProvider store={store}>
            <InspectorDock />
          </SyncStoreProvider>
        )
      }
    >
      {store !== null && (
        <SyncStoreProvider store={store}>
          <SystemBanners />
        </SyncStoreProvider>
      )}
      <StoreGate>
        <Outlet />
      </StoreGate>
    </Shell>
  );
}

/**
 * The sync inspector (SPEC-002 §5.4): dev builds, or `?debug=sync` for an Admin. Folded in a
 * corner until opened. `role` stays undefined until roles reach the client (PLAN-001 S7), which
 * keeps `?debug=sync` closed in production builds (session D's handoff).
 */
function InspectorDock() {
  const [allowed] = useState(() =>
    inspectorAllowed({ dev: import.meta.env.DEV, search: window.location.search, role: undefined }),
  );
  if (!allowed) return null;
  return (
    <details className={styles.inspector}>
      <summary>Sync</summary>
      <SyncInspector />
    </details>
  );
}

const OUTDATED_BANNER = 'store-outdated';

function useSyncStore(app: AppModel, { userId, workspaceId }: Session, epoch: number): void {
  useEffect(() => {
    // Before the first ready, StoreGate's own screen says the client is outdated.
    let readyOnce = false;
    // E10, E14, SPEC-001 Q11: a 401 or a 4001 asks who is signed in now (app/session-store.ts).
    const auth = sessionAuthHooks(app.auth, epoch, (url, init) => window.fetch(url, init));
    const store = new SyncStore({
      // The server's model set, so the schema hashes match (PLAN-001 S1 handoff).
      models: PRODUCTION_MODELS,
      workspaceId,
      userId,
      fetch: auth.fetch,
      onSessionRevoked: auth.onSessionRevoked,
      // SPEC-002 §3.5: the optimistic change is gone; say why. A change naming a status this
      // replica saw deleted says so instead of "not found" (SPEC-010 E1).
      // A comment or an edit sent again after a reload has no waiting `dispatch`: its text goes back
      // to the draft or to **Copy text** (SPEC-013 §3.1 item 2, E21).
      onRejected: (rejection) => {
        const text = commentActionsFor(store).reportQueuedRejection({
          op: rejection.op,
          input: rejection.input,
          message: rejection.message,
        });
        if (text) return;
        toast({ tone: 'danger', message: statusGoneMessage(rejection, seenDeletes) });
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
    // E1's lookups: the session's remembered status deletes, and a team key to its id.
    const seenDeletes: SeenDeletes = {
      seenDeleted: (model, rowId) => store.seenDeleted(model, rowId),
      seenDeletedRows: (model) => store.seenDeletedRows(model),
      teamIdOf: (key) =>
        store.pool.all(Team).find((team) => team.key.toLowerCase() === key.toLowerCase())?.id,
    };
    const stopWatching = reaction(
      () => store.status === 'ready',
      (ready) => {
        if (ready) readyOnce = true;
      },
    );
    app.openStore(store, epoch);
    // Starts once the previous session's store has closed, so it can adopt the queue (E5).
    const dispose = runStore(app.stores, store);
    return () => {
      stopWatching();
      banner.hide(OUTDATED_BANNER);
      app.closeStore(store);
      dispose();
    };
  }, [app, userId, workspaceId, epoch]);
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
  const store = useObserved(
    useCallback(() => app.store, [app]),
    Object.is,
  );
  // Pages read team load states through sync-react (PLAN-011 S4c), so they need the store; while
  // a new session's store is being set up there is none, and the sync screen shows.
  if (shown === 'page' && store !== null) {
    return <SyncStoreProvider store={store}>{children}</SyncStoreProvider>;
  }
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
