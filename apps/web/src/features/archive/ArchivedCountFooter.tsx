// "N archived issues" at the end of a team's issue list (SPEC-012 §3.3 item 6, SPEC-015 §3.3;
// PLAN-015 S4): a link to the team's archive page. The replica holds no archived issue, so the
// number comes from `issue.count {team, includeArchived, filter: archivedAt is set}` when the list
// opens, on window focus, after the user's own lifecycle confirmations and, while the team is
// subscribed, on its packets that change the archive (`archive-packets.ts`, at most once a
// second). Hidden until it answers, offline, and while the team has none.
import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { useApp, useObserved } from '../../app/context.js';
import { useIssueApi } from '../issues/issue-api.js';
import { teamArchivePath } from './paths.js';
import { watchArchivePackets } from './archive-packets.js';
import { ARCHIVED_FILTER } from './archive-source.js';
import { lifecycleEvents } from './lifecycle-events.js';
import { storePacketDeps } from './useArchiveSource.js';
import styles from './Archive.module.css';

export const archivedCountText = (count: number) =>
  `${String(count)} archived ${count === 1 ? 'issue' : 'issues'}`;

/** The team's archived issue count, or undefined while unknown (loading, offline, a failure). */
export function useArchivedCount(team: {
  readonly id: string;
  readonly key: string;
}): number | undefined {
  const { id: teamId, key: teamKey } = team;
  const app = useApp();
  const store = app.readyStore;
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
    // No list here to look a purged row up in: a purge leaves the archived count as it was.
    const stopPackets =
      store === null
        ? undefined
        : watchArchivePackets(storePacketDeps(store), teamId, () => false, ask);
    return () => {
      window.removeEventListener('focus', ask);
      stop();
      stopPackets?.();
    };
  }, [store, teamId]);
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

export function ArchivedCountFooter({ team }: { team: { id: string; key: string } }) {
  const count = useArchivedCount(team);
  const teamKey = team.key;
  if (count === undefined || count === 0) return null;
  return (
    <div className={styles.footer}>
      <Link to={teamArchivePath(teamKey)} className={styles.footerLink}>
        {archivedCountText(count)}
      </Link>
    </div>
  );
}
