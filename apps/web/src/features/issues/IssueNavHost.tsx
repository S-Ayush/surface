// Navigation keys of SPEC-012 §3.6 that go to the lists: `G` `E` (the current team's issues),
// `G` `M` (My issues, the tab used last) and `Ctrl+Shift+1…9` (the n-th team in the sidebar).
// Mounted once in the shell (features/hosts.ts), so the keys work on every page.
import { toast } from '@surface/ui';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { useCallback } from 'react';
import { useApp, useObserved } from '../../app/context.js';
import type { CommandId } from '../../commands/catalog.js';
import { useCommand } from '../../shortcuts/ShortcutProvider.js';
import { lastMyIssuesTab, myIssuesPath } from './my-issues-tab.js';

const NTH: readonly { readonly n: number; readonly command: CommandId }[] = [
  { n: 1, command: 'nav:team-1' },
  { n: 2, command: 'nav:team-2' },
  { n: 3, command: 'nav:team-3' },
  { n: 4, command: 'nav:team-4' },
  { n: 5, command: 'nav:team-5' },
  { n: 6, command: 'nav:team-6' },
  { n: 7, command: 'nav:team-7' },
  { n: 8, command: 'nav:team-8' },
  { n: 9, command: 'nav:team-9' },
];

export const teamIssuesPath = (key: string) => `/team/${encodeURIComponent(key)}/issues`;

/** The team key the current address names: `/team/ENG/…` or `/issue/ENG-42/…`. */
export function routeTeamKey(pathname: string): string | undefined {
  const team = /^\/team\/([A-Za-z]+)(?:\/|$)/.exec(pathname);
  if (team?.[1] !== undefined) return team[1].toUpperCase();
  const issue = /^\/issue\/([A-Za-z]{2,5})-\d+(?:\/|$)/.exec(pathname);
  return issue?.[1]?.toUpperCase();
}

function NthTeam({ n, command }: { n: number; command: CommandId }) {
  const app = useApp();
  const navigate = useNavigate();
  const key = useObserved(useCallback(() => app.teams()[n - 1]?.key, [app, n]));
  useCommand(
    command,
    () => {
      if (key !== undefined) void navigate({ href: teamIssuesPath(key) });
    },
    { when: () => key !== undefined },
  );
  return null;
}

export function IssueNavHost() {
  const app = useApp();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });

  useCommand('nav:team-issues', () => {
    // The route's team, else the home team, else the first team the user is in (§3.6).
    const routeKey = routeTeamKey(pathname);
    const key =
      (routeKey !== undefined ? app.team(routeKey)?.key : undefined) ??
      app.homeTeam()?.key ??
      app.teams()[0]?.key;
    if (key === undefined) {
      toast({ message: 'Join a team to see its issues' });
      return;
    }
    void navigate({ href: teamIssuesPath(key) });
  });
  useCommand('nav:my-issues', () => {
    void navigate({ href: myIssuesPath(lastMyIssuesTab()) });
  });
  return (
    <>
      {NTH.map(({ n, command }) => (
        <NthTeam key={n} n={n} command={command} />
      ))}
    </>
  );
}
