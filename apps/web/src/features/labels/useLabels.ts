// The labels pages' data, read from the replica and kept current as deltas land (SPEC-010 §7.2: no
// loading state after bootstrap). `null` while the store is not ready.
import { Label } from '@surface/domain/model';
import { useCallback } from 'react';
import { useApp, useObserved } from '../../app/context.js';
import { labelsAccess, type LabelItem, type LabelsAccess, type LabelsScope } from './model.js';

export type LabelsData = {
  /** Every label the replica holds (every scope), as plain items. */
  readonly all: LabelItem[];
  readonly access: LabelsAccess;
};

export function useLabels(scope: LabelsScope): LabelsData | null {
  const app = useApp();
  const teamId = scope.kind === 'team' ? scope.teamId : null;
  return useObserved(
    useCallback(() => {
      const store = app.store;
      if (store === null || store.status !== 'ready') return null;
      const all = store.pool.all(Label).map((row): LabelItem => ({
        id: row.id,
        teamId: row.teamId,
        name: row.name,
        color: row.color,
        description: row.description,
        parentId: row.parentId,
        isGroup: row.isGroup,
        exclusive: row.exclusive,
        archived: row.$archived === true || row.archivedAt !== null,
        createdAt: String(row.createdAt),
      }));
      const scoped: LabelsScope =
        teamId === null ? { kind: 'workspace' } : { kind: 'team', teamId, teamKey: '' };
      return { all, access: labelsAccess(app.actor(), scoped) };
    }, [app, teamId]),
  );
}
