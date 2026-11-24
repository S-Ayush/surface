// The archive feature's shell host (PLAN-015 S4), mounted once in `SHELL_HOSTS`: `G` `X` (the
// route's team archive page, SPEC-015 §3.3, §7) and the Permanently delete dialog (§3.4, D14),
// which the issue page's ⋯ menu and "Permanently delete…" in `Mod+K` open with `askPurge`.
import { toast } from '@surface/ui';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { useSyncExternalStore } from 'react';
import { useApp } from '../../app/context.js';
import { useCommand } from '../../shortcuts/ShortcutProvider.js';
import { routeTeamKey } from '../issues/IssueNavHost.js';
import { PurgeIssueDialog } from './PurgeIssueDialog.js';
import { teamArchivePath } from './paths.js';
import { purgeIssue, purgeRequests } from './purge-flow.js';

export function ArchiveHost() {
  const app = useApp();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const request = useSyncExternalStore(
    purgeRequests.subscribe,
    purgeRequests.snapshot,
    purgeRequests.snapshot,
  );

  // `G` `X`: the route's team, else the home team, else the first team, like `G` `E` (§3.3).
  useCommand('nav:team-archive', () => {
    const routeKey = routeTeamKey(pathname);
    const key =
      (routeKey !== undefined ? app.team(routeKey)?.key : undefined) ??
      app.homeTeam()?.key ??
      app.teams()[0]?.key;
    if (key === undefined) {
      toast({ message: 'Join a team to see its archive' });
      return;
    }
    void navigate({ href: teamArchivePath(key) });
  });

  if (request === undefined) return null;
  return (
    <PurgeIssueDialog
      open
      identifier={request.identifier}
      title={request.title}
      onConfirm={() => {
        const store = app.readyStore;
        purgeRequests.close();
        if (store !== null) void purgeIssue(store, request);
      }}
      onCancel={() => {
        purgeRequests.close();
      }}
    />
  );
}
