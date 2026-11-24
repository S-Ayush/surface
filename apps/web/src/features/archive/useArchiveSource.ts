// The archive page's adapter (PLAN-015 S4): `ArchiveSource` wired to the store, the issue API and
// the window. The store only reports here (connection, followed teams, applied packets); nothing
// calls `openTeam`, so opening the archive page never subscribes the team (SPEC-015 §3.3 item 6).
import { Issue } from '@surface/domain/model';
import type { SyncStore } from '@surface/sync-client';
import { reaction } from 'mobx';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useApp } from '../../app/context.js';
import type { OperationAnswer } from '../files/operation.js';
import { useIssueApi, type IssueApi } from '../issues/issue-api.js';
import {
  ARCHIVED_FILTER,
  ArchiveSource,
  type ArchivePage,
  type ArchiveSourceDeps,
  type ArchiveState,
  type ArchiveTab,
} from './archive-source.js';
import { lifecycleEvents } from './lifecycle-events.js';

const NO_API: OperationAnswer<never> = {
  ok: false,
  code: 'UNREACHABLE',
  message: "Couldn't reach Surface. Check your connection, then try again.",
};

/** One page of a tab: `issue.list` of archived issues, or `issue.listDeleted`. */
export function fetchArchivePage(
  api: IssueApi,
  tab: ArchiveTab,
  teamKey: string,
  cursor: string | undefined,
  limit: number,
): Promise<OperationAnswer<ArchivePage>> {
  const page = { team: teamKey, limit, ...(cursor === undefined ? {} : { cursor }) };
  if (tab === 'deleted') return api.listDeleted?.(page) ?? Promise.resolve(NO_API);
  return (
    api.list?.({
      ...page,
      includeArchived: true,
      filter: ARCHIVED_FILTER,
      orderBy: { field: 'archivedAt', direction: 'desc' },
    }) ?? Promise.resolve(NO_API)
  );
}

/** The source's view of the store, the API and the window. */
export function storeArchiveDeps(store: SyncStore, api: IssueApi): ArchiveSourceDeps {
  return {
    fetchPage: (tab, teamKey, cursor, limit) => fetchArchivePage(api, tab, teamKey, cursor, limit),
    online: () => store.connection === 'online',
    subscribed: (teamId) => store.followedTeams.has(teamId),
    teamOf: (issueId) => store.pool.get(Issue, issueId)?.teamId,
    watchPackets: (listener) => {
      // `recentPackets` is newest first; the ids grow, so what is newer than the last seen is new.
      let seen = store.recentPackets[0]?.id ?? 0;
      return reaction(
        () => store.recentPackets[0]?.id,
        () => {
          const fresh = store.recentPackets.filter((packet) => packet.id > seen);
          seen = store.recentPackets[0]?.id ?? seen;
          if (fresh.length > 0) listener(fresh.reverse());
        },
      );
    },
    watchOnline: (listener) =>
      reaction(
        () => store.connection === 'online',
        (online) => {
          if (online) listener();
        },
      ),
    watchFocus: (listener) => {
      window.addEventListener('focus', listener);
      return () => {
        window.removeEventListener('focus', listener);
      };
    },
    events: lifecycleEvents,
    setTimeout: (run, ms) => window.setTimeout(run, ms),
    clearTimeout: (handle) => {
      if (typeof handle === 'number') window.clearTimeout(handle);
    },
  };
}

const LOADING: ArchiveState = { status: 'loading' };
const idle = () => () => undefined;

/** The tab's rows for `team`, from the server; one source per tab and team while mounted. */
export function useArchiveSource(
  tab: ArchiveTab,
  team: { readonly id: string; readonly key: string } | null,
): { readonly state: ArchiveState; readonly source: ArchiveSource | null } {
  const app = useApp();
  const api = useIssueApi();
  const store = app.readyStore;
  const teamId = team?.id;
  const teamKey = team?.key;
  // Building a source has no effect; `start` (in the effect) reads and listens.
  const source = useMemo(
    () =>
      store === null || teamId === undefined || teamKey === undefined
        ? null
        : new ArchiveSource(tab, { id: teamId, key: teamKey }, storeArchiveDeps(store, api)),
    [store, api, tab, teamId, teamKey],
  );
  useEffect(() => source?.start(), [source]);
  const state = useSyncExternalStore(
    source?.subscribe ?? idle,
    () => source?.getState() ?? LOADING,
    () => LOADING,
  );
  return { state, source };
}
