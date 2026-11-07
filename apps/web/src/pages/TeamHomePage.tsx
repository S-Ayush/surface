// Team home (SPEC-005 §3 `/team/:key`): a placeholder in M0 that sets the command target to the
// team. E5: if the team disappears while open (deleted, archived, or a private team the user
// left), the user goes home with a toast. A team never visible is simply not found.
import { EmptyState, toast } from '@surface/ui';
import { useNavigate } from '@tanstack/react-router';
import { LayoutGrid } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { GLOBAL_TARGET } from '../command-menu/model.js';
import { useCommandContext } from '../command-menu/context.js';
import { useApp, useObserved } from '../app/context.js';
import { lostTeamMessage, observeTeam, type TeamView } from '../app/workspace.js';
import { PageHeader } from '../shell/PageHeader.js';
import { NotFoundPage } from './NotFoundPage.js';
import styles from './Pages.module.css';

export function TeamHomePage({ teamKey }: { teamKey: string }) {
  const app = useApp();
  const navigate = useNavigate();
  const team = useObserved(
    useCallback(() => {
      const row = app.team(teamKey);
      return row === undefined ? null : { id: row.id, key: row.key, name: row.name };
    }, [app, teamKey]),
  );
  // What this page has shown, so a later disappearance reads as "lost" (E5). Updated during
  // render, React's pattern for state derived from the previous render.
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

  if (state === 'not-found') return <NotFoundPage />;
  if (team === null) return null;
  return (
    <>
      <PageHeader crumbs={[team.name]} title={team.name} />
      <div className={styles.centered}>
        <EmptyState
          icon={<LayoutGrid />}
          title={`${team.name} has no issues yet`}
          description="The team's issues will appear here."
        />
      </div>
    </>
  );
}
