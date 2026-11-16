// The Automations page's data, read from the replica and kept current as deltas land (SPEC-015
// §3.2). `null` while the store is not ready. The optimistic overlay shows through `pool.get`, so
// a control follows the change before the server answers.
import { comparePositions } from '@surface/domain';
import { Team, WorkflowStatus } from '@surface/domain/model';
import { useCallback } from 'react';
import { useApp, useObserved } from '../../app/context.js';

export type CanceledStatus = { readonly id: string; readonly name: string };

export type AutomationSettings = {
  readonly autoArchiveMonths: number;
  /** Null while auto-close is off. */
  readonly autoCloseMonths: number | null;
  readonly autoCloseStatusId: string | null;
  /** The team's Canceled-category statuses, first by position: the only choices (§3.2). */
  readonly canceled: readonly CanceledStatus[];
};

export function useAutomations(teamId: string): AutomationSettings | null {
  const app = useApp();
  return useObserved(
    useCallback(() => {
      const store = app.store;
      if (store === null || store.status !== 'ready') return null;
      const team = store.pool.get(Team, teamId);
      if (team === undefined) return null;
      const canceled = store.pool
        .all(WorkflowStatus)
        .filter((s) => s.teamId === teamId && s.category === 'canceled')
        .sort((a, b) => comparePositions(a.position, b.position))
        .map((s) => ({ id: s.id, name: s.name }));
      return {
        autoArchiveMonths: team.autoArchiveMonths,
        autoCloseMonths: team.autoCloseMonths,
        autoCloseStatusId: team.autoCloseStatusId,
        canceled,
      };
    }, [app, teamId]),
  );
}
