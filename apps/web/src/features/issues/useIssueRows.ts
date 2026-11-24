// The list's groups, read from the replica and kept current as deltas land (SPEC-012 §3.3, §3.9).
// `useObserved` re-runs the read when a MobX observable it touched changes, so a status change
// from another device moves the row without any polling.
import { Issue, Label, Team, User, WorkflowStatus } from '@surface/domain/model';
import type { ReadonlyPool } from '@surface/sync-client';
import { useCallback } from 'react';
import { useApp, useObserved } from '../../app/context.js';
import { fileUrl } from '../files/url.js';
import {
  buildGroups,
  type ListGroup,
  type ListLookups,
  type ListScope,
  type ListVariant,
} from './list-model.js';

export type IssueRows =
  /** The replica isn't ready: the shell shows its progress. */
  { readonly ready: false } | { readonly ready: true; readonly groups: readonly ListGroup[] };

/** Today as `YYYY-MM-DD` in the viewer's zone. */
export function localToday(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * Only `active` reads the store. PLAN-015 S4 passes `archived` and `deleted` rows from its own
 * data source straight to `buildGroups`, since the replica holds neither.
 */
export function useIssueRows(scope: ListScope, variant: Extract<ListVariant, 'active'> = 'active') {
  const app = useApp();
  const read = useCallback((): IssueRows => {
    const store = app.readyStore;
    if (store === null) return { ready: false };
    const { pool } = store;
    const lookups = readListLookups(pool);
    const issues = pool.all(Issue).map((i) => ({
      id: i.id,
      teamId: i.teamId,
      number: i.number,
      title: i.title,
      statusId: i.statusId,
      priority: i.priority,
      assigneeId: i.assigneeId,
      creatorId: i.creatorId,
      labelIds: i.labelIds,
      estimate: i.estimate,
      dueDate: i.dueDate,
      archivedAt: i.archivedAt,
      deletedAt: i.deletedAt,
      createdAt: i.createdAt,
      updatedAt: i.updatedAt,
    }));
    return { ready: true, groups: buildGroups(scope, variant, issues, lookups) };
  }, [app, scope, variant]);
  return useObserved(read);
}

/**
 * What a list row reads from the replica besides the issue: statuses, teams, labels and users.
 * The archive page (PLAN-015 S4) reads it too, for rows that come from the server.
 */
export function readListLookups(pool: ReadonlyPool): ListLookups {
  return {
    statuses: pool.all(WorkflowStatus).map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
      position: s.position,
      color: s.color,
    })),
    teams: new Map(
      pool.all(Team).map((t) => [
        t.id,
        {
          key: t.key,
          estimate: {
            scale: t.estimateScale,
            extended: t.estimateExtended,
            allowZero: t.estimateAllowZero,
          },
        },
      ]),
    ),
    labels: new Map(pool.all(Label).map((l) => [l.id, { name: l.name, color: l.color }])),
    users: new Map(
      pool.all(User).map((u) => {
        const avatarUrl = fileUrl(u.avatarFileId);
        return [u.id, avatarUrl === undefined ? { name: u.name } : { name: u.name, avatarUrl }];
      }),
    ),
    today: localToday(),
  };
}
