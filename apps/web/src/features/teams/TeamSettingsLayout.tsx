// What both team settings screens share: the team's name and key, General / Members links, and
// the loading and not-found states. A team the user can't see is not found (permissions.md §5).
import { Skeleton } from '@surface/ui';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { NotFoundPage } from '../../pages/NotFoundPage.js';
import styles from './teams.module.css';
import { useTeamDetails, type TeamDetails } from './useTeams.js';

export function TeamSettingsLayout({
  teamKey,
  children,
}: {
  readonly teamKey: string;
  readonly children: (details: TeamDetails) => ReactNode;
}) {
  const details = useTeamDetails(teamKey);
  if (details === null) return <Skeleton shape="block" aria-label="Loading team" />;
  if (details === undefined) return <NotFoundPage />;
  const { team } = details;
  return (
    <div className={styles.screen}>
      <div className={styles.toolbar}>
        <h2 className={styles.rowTitle}>
          {team.icon === null ? '' : `${team.icon} `}
          {team.name} <span className={styles.key}>{team.key}</span>
        </h2>
        <nav aria-label={`${team.name} settings`} className={styles.tabs}>
          <Link to="/settings/teams/$key/general" params={{ key: team.key }}>
            General
          </Link>
          <Link to="/settings/teams/$key/members" params={{ key: team.key }}>
            Members
          </Link>
          <Link to="/settings/teams/$key/workflow" params={{ key: team.key }}>
            Workflow
          </Link>
          <Link to="/settings/teams/$key/labels" params={{ key: team.key }}>
            Labels
          </Link>
          <Link to="/settings/teams/$key/estimates" params={{ key: team.key }}>
            Estimates
          </Link>
        </nav>
      </div>
      {children(details)}
    </div>
  );
}
