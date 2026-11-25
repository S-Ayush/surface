// The team issue list, `/team/:key/issues` (SPEC-012 §3.3). Member teams render from the replica
// at once, offline too; a public team the user hasn't joined shows the states of §7.2 from the
// load seam (`team-load.ts`).
import { EmptyState, Kbd, toast } from '@surface/ui';
import { useNavigate } from '@tanstack/react-router';
import { CircleDot, CloudOff } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp, useObserved } from '../../app/context.js';
import { lostTeamMessage, observeTeam, type TeamView } from '../../app/workspace.js';
import { useCommandContext } from '../../command-menu/context.js';
import { GLOBAL_TARGET } from '../../command-menu/model.js';
import { NotFoundPage } from '../../pages/NotFoundPage.js';
import { ArchivedCountFooter } from '../archive/ArchivedCountFooter.js';
import { PageHeader } from '../../shell/PageHeader.js';
import { IssueList } from './IssueList.js';
import styles from './IssueList.module.css';
import { CreateIssueButton, ListSkeleton } from './ListParts.js';
import { teamListKey } from './focus-model.js';
import type { ListScope } from './list-model.js';
import { useTeamLoadState } from './team-load.js';
import { useIssueRows } from './useIssueRows.js';

export function IssueListPage({ teamKey }: { teamKey: string }) {
  const app = useApp();
  const navigate = useNavigate();
  const team = useObserved(
    useCallback(() => {
      const row = app.team(teamKey);
      return row === undefined ? null : { id: row.id, key: row.key, name: row.name };
    }, [app, teamKey]),
  );
  // As the team home page: a team that disappears while open sends the user home (SPEC-005 E5).
  const [view, setView] = useState<TeamView | null>(null);
  const observed = observeTeam(view, teamKey, team !== null);
  if (view?.key !== observed.view.key || view.seen !== observed.view.seen) setView(observed.view);
  const state = observed.state;
  useCommandContext(
    team === null ? GLOBAL_TARGET : { kind: 'team', ids: [team.id], label: team.key },
  );
  useEffect(() => {
    if (state !== 'lost') return;
    toast({ tone: 'danger', message: lostTeamMessage(teamKey) });
    void navigate({ to: '/', replace: true });
  }, [state, teamKey, navigate]);

  const scope = useMemo<ListScope>(() => ({ kind: 'team', teamId: team?.id ?? '' }), [team?.id]);
  const rows = useIssueRows(scope);
  const load = useTeamLoadState(team?.id ?? '');

  if (state === 'not-found') return <NotFoundPage />;
  if (team === null || !rows.ready) return undefined;
  const count = rows.groups.reduce((sum, group) => sum + group.rows.length, 0);
  const header = (
    <PageHeader
      crumbs={[team.name, 'Issues']}
      title={`${team.name} issues`}
      actions={
        <span className={styles.count}>
          {count === 1 ? '1 issue' : `${count.toLocaleString('en')} issues`}
        </span>
      }
    />
  );

  if (load === 'loading') {
    return (
      <>
        {header}
        <ListSkeleton />
      </>
    );
  }
  if (load === 'offline') {
    return (
      <>
        {header}
        <div className={styles.empty}>
          <EmptyState icon={<CloudOff />} title="Available when online" />
        </div>
      </>
    );
  }
  if (rows.groups.length === 0) {
    return (
      <>
        {header}
        <div className={styles.empty}>
          <EmptyState
            icon={<CircleDot />}
            title={`No issues in ${team.key} yet`}
            description={
              <>
                Create one with <Kbd keys="C" />
              </>
            }
            action={<CreateIssueButton />}
          />
        </div>
        <ArchivedCountFooter team={team} />
      </>
    );
  }
  return (
    <>
      {header}
      <div className={styles.area}>
        <IssueList
          key={team.key}
          ariaLabel={`Issues in ${team.key}`}
          listKey={teamListKey(team.key)}
          href={`/team/${team.key}/issues`}
          groups={rows.groups}
        />
        {/* SPEC-015 §3.3: the way to the team's archive page (PLAN-015 S4). */}
        <ArchivedCountFooter team={team} />
      </div>
    </>
  );
}
