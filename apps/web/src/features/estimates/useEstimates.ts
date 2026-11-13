// The estimates page's data, read from the replica and kept current as deltas land (SPEC-010
// §7.2). `null` while the store is not ready. The optimistic overlay shows through `pool.get`, so
// a switch flips before the server answers.
import type { EstimateScale } from '@surface/domain';
import { Team } from '@surface/domain/model';
import { useCallback } from 'react';
import { useApp, useObserved } from '../../app/context.js';

export type EstimateSettings = {
  readonly scale: EstimateScale;
  readonly extended: boolean;
  readonly allowZero: boolean;
  readonly countUnestimatedAsOne: boolean;
};

export function useEstimates(teamId: string): EstimateSettings | null {
  const app = useApp();
  return useObserved(
    useCallback(() => {
      const store = app.store;
      if (store === null || store.status !== 'ready') return null;
      const team = store.pool.get(Team, teamId);
      if (team === undefined) return null;
      return {
        scale: team.estimateScale,
        extended: team.estimateExtended,
        allowZero: team.estimateAllowZero,
        countUnestimatedAsOne: team.estimateCountUnestimatedAsOne,
      };
    }, [app, teamId]),
  );
}
