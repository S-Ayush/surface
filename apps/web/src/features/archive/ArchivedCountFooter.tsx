// "N archived issues" at the end of a team's issue list (SPEC-012 §3.3 item 6, SPEC-015 §3.3;
// PLAN-015 S4): a link to the team's archive page. The replica holds no archived issue, so the
// number comes from `issue.count {team, includeArchived, filter: archivedAt is set}` when the list
// opens, on window focus and after the user's own lifecycle confirmations. Hidden until it
// answers, offline, and while the team has none.
import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { useApp, useObserved } from '../../app/context.js';
import { useIssueApi } from '../issues/issue-api.js';
import { teamArchivePath } from './paths.js';
import { ARCHIVED_FILTER } from './archive-source.js';
import { lifecycleEvents } from './lifecycle-events.js';
import styles from './Archive.module.css';

export const archivedCountText = (count: number) =>
  `${String(count)} archived ${count === 1 ? 'issue' : 'issues'}`;

/** The team's archived issue count, or undefined while unknown (loading, offline, a failure). */
export function useArchivedCount(teamKey: string): number | undefined {
  const app = useApp();
  const api = useIssueApi();
  const online = useObserved(useCallback(() => app.readyStore?.connection === 'online', [app]));
  const [answer, setAnswer] = useState<{ key: string; count: number } | undefined>(undefined);
  const [asks, setAsks] = useState(0);
  useEffect(() => {
    const ask = () => {
      setAsks((n) => n + 1);
    };
    window.addEventListener('focus', ask);
    const stop = lifecycleEvents.subscribe((event) => {
      if (event.kind === 'confirmed') ask();
    });
    return () => {
      window.removeEventListener('focus', ask);
      stop();
    };
  }, []);
  useEffect(() => {
    if (!online || api.count === undefined) return;
    let current = true;
    void api
      .count({ team: teamKey, includeArchived: true, filter: ARCHIVED_FILTER })
      .then((result) => {
        if (current && result.ok) setAnswer({ key: teamKey, count: result.result.count });
      });
    return () => {
      current = false;
    };
  }, [api, teamKey, online, asks]);
  if (!online || answer?.key !== teamKey) return undefined;
  return answer.count;
}

export function ArchivedCountFooter({ teamKey }: { teamKey: string }) {
  const count = useArchivedCount(teamKey);
  if (count === undefined || count === 0) return null;
  return (
    <div className={styles.footer}>
      <Link to={teamArchivePath(teamKey)} className={styles.footerLink}>
        {archivedCountText(count)}
      </Link>
    </div>
  );
}
