// The composer's view of the replica (`ComposerWorld`), read inside an observer so it updates when
// a delta lands (a status renamed, a label archived while the composer is open).
import { Label, Team, TeamMembership, User, WorkflowStatus } from '@surface/domain/model';
import type { ReadonlyPool } from '@surface/sync-client';
import type { ComposerWorld } from './composer-model.js';

const live = <T extends { readonly $archived?: boolean }>(rows: readonly T[]) =>
  rows.filter((row) => row.$archived !== true);

export function readComposerWorld(
  pool: ReadonlyPool,
  me: string,
  homeTeamId: string | null,
  memberTeamIds: readonly string[],
): ComposerWorld {
  // A plain record of arrays, so `useObserved` compares it structurally.
  const members: Record<string, string[]> = {};
  for (const m of live(pool.all(TeamMembership))) {
    (members[m.teamId] ??= []).push(m.userId);
  }
  for (const list of Object.values(members)) list.sort();
  return {
    me,
    homeTeamId,
    memberTeamIds,
    members,
    teams: live(pool.all(Team)).map((t) => ({
      id: t.id,
      key: t.key,
      name: t.name,
      private: t.private,
      defaultStatusId: t.defaultStatusId,
      estimate: {
        scale: t.estimateScale,
        extended: t.estimateExtended,
        allowZero: t.estimateAllowZero,
      },
    })),
    statuses: live(pool.all(WorkflowStatus)).map((s) => ({
      id: s.id,
      teamId: s.teamId,
      name: s.name,
      category: s.category,
      position: s.position,
      color: s.color,
    })),
    labels: pool.all(Label).map((l) => ({
      id: l.id,
      teamId: l.teamId,
      name: l.name,
      archived: l.archivedAt !== null || l.$archived === true,
      isGroup: l.isGroup,
      parentId: l.parentId,
      exclusive: l.exclusive,
      color: l.color,
    })),
    users: pool.all(User).map((u) => ({
      id: u.id,
      name: u.name,
      displayName: u.displayName,
      email: u.email,
      active: u.active,
    })),
  };
}
