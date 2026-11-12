// The workflow page's data, read from the replica and kept current as deltas land (SPEC-010 §7.2:
// no loading state after bootstrap). `null` while the store is not ready.
import { Team, WorkflowStatus } from '@surface/domain/model';
import { useCallback } from 'react';
import { useApp, useObserved } from '../../app/context.js';
import { workflowAccess, type StatusItem, type WorkflowAccess } from './model.js';

export type Workflow = {
  readonly statuses: StatusItem[];
  readonly defaultStatusId: string;
  readonly access: WorkflowAccess;
};

export function useWorkflow(teamId: string): Workflow | null {
  const app = useApp();
  return useObserved(
    useCallback(() => {
      const store = app.store;
      if (store === null || store.status !== 'ready') return null;
      const team = store.pool.get(Team, teamId);
      if (team === undefined) return null;
      const statuses = store.pool
        .all(WorkflowStatus)
        .filter((row) => row.teamId === teamId && row.$archived !== true)
        .map((row): StatusItem => ({
          id: row.id,
          teamId: row.teamId,
          name: row.name,
          category: row.category,
          color: row.color,
          description: row.description,
          position: row.position,
        }));
      return {
        statuses,
        defaultStatusId: team.defaultStatusId,
        access: workflowAccess(app.actor(), { id: teamId }),
      };
    }, [app, teamId]),
  );
}
