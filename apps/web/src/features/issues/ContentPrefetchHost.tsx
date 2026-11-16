// After start, prefetch the content of the open issues assigned to the user: the 100 most
// recently updated (SPEC-011 §5.4, PLAN-011 S7). Mounted once in the shell (features/hosts.ts).
// The shell's hosts sit outside `SyncStoreProvider`, so this reads `app.readyStore` itself.
import { Issue, WorkflowStatus } from '@surface/domain/model';
import { PREFETCH_ASSIGNED } from '@surface/sync-client';
import { useCallback, useEffect } from 'react';
import { useApp, useObserved } from '../../app/context.js';
import { assignedPrefetchIds } from './content-prefetch.js';

/** The prefetch slot of this host (one pending prefetch per slot, `store.content.prefetchList`). */
const SLOT = 'assigned';

export function ContentPrefetchHost() {
  const app = useApp();
  const ids = useObserved(
    useCallback((): string => {
      const store = app.readyStore;
      const userId = app.session?.userId;
      if (store === null || userId === undefined) return '';
      const { pool } = store;
      const categories = new Map(pool.all(WorkflowStatus).map((s) => [s.id, s.category]));
      // By the assignee index: only the user's issues are read, so other issues' changes don't
      // run this again.
      const issues = pool.findBy(Issue, 'assigneeId', userId).map((i) => ({
        id: i.id,
        statusId: i.statusId,
        assigneeId: i.assigneeId,
        archivedAt: i.archivedAt,
        deletedAt: i.deletedAt,
        updatedAt: i.updatedAt,
      }));
      return assignedPrefetchIds(issues, categories, userId, PREFETCH_ASSIGNED).join(',');
    }, [app]),
  );
  useEffect(() => {
    const store = app.readyStore;
    if (store === null || ids === '') return undefined;
    // Debounced by the store: while issues and teams load, only the settled list is fetched.
    store.content.prefetchList(SLOT, ids.split(','), PREFETCH_ASSIGNED);
    return () => store.content.prefetchList(SLOT, []);
  }, [app, ids]);
  return null;
}
