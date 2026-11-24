// Navigation commands (SPEC-005 §4.1): the route table plus one "Go to {team}" per live team, and
// "Open team…" (O T), a nested page of teams. Hidden until the shell provides `navigate` (S4).
// The identifier fast path (command-menu §3.1, SPEC-011 §7): `eng-87` puts "Open ENG-87" first.
import { teamArchivePath } from '../../features/archive/paths.js';
import { typedIdentifier } from '../../features/issues/issue-url.js';
import { commandTitle } from '../../commands/catalog.js';
import type { Command, CommandContext, CommandPage, CommandSource } from '../model.js';
import { isOffered, type RankedSection } from '../ranking.js';
import { shortcutsFor } from './shortcuts.js';

/** M0 pages (SPEC-005 §3). Later pages add rows here as they land. */
export const NAV_ROUTES: readonly {
  id: string;
  title: string;
  path: string;
  keywords: readonly string[];
}[] = [
  {
    id: 'nav:my-issues',
    title: 'Go to My issues',
    path: '/my-issues',
    keywords: ['home', 'assigned to me'],
  },
  {
    id: 'nav:drafts',
    title: 'Go to Drafts',
    path: '/drafts',
    keywords: ['unsent', 'saved issues'],
  },
  {
    id: 'nav:settings',
    title: commandTitle('nav:settings'),
    path: '/settings',
    keywords: ['preferences', 'account', 'workspace'],
  },
];

export const teamPath = (key: string) => `/team/${encodeURIComponent(key)}`;

const canNavigate = (ctx: CommandContext) => ctx.navigate !== undefined;

export function teamsPage(ctx: CommandContext): CommandPage {
  return {
    title: 'Open team',
    placeholder: 'Search teams…',
    empty: 'No teams yet',
    items: () =>
      ctx.teams().map((team) => ({
        id: `team:${team.id}`,
        title: team.name,
        keywords: [team.key],
        run: () => ctx.navigate?.(teamPath(team.key)),
      })),
  };
}

export const OPEN_TEAM: Command = {
  id: 'nav:open-team',
  title: commandTitle('nav:open-team'),
  section: 'navigation',
  keywords: ['switch team', 'team'],
  shortcuts: shortcutsFor('nav:open-team'),
  when: canNavigate,
  page: teamsPage,
};

export const navigationSource: CommandSource = (ctx) => [
  ...NAV_ROUTES.map((route): Command => ({
    id: route.id,
    title: route.title,
    section: 'navigation',
    keywords: route.keywords,
    shortcuts: shortcutsFor(route.id),
    when: canNavigate,
    run: (c) => c.navigate?.(route.path),
  })),
  OPEN_TEAM,
  ...ctx.teams().map((team): Command => ({
    id: `nav:team:${team.id}`,
    title: `Go to ${team.name}`,
    section: 'navigation',
    keywords: [team.key],
    when: canNavigate,
    run: (c) => c.navigate?.(teamPath(team.key)),
  })),
  // SPEC-012 §3.3 item 1, §3.8: "Go to ENG issues", one per team.
  ...ctx.teams().map((team): Command => ({
    id: `nav:team-issues:${team.id}`,
    title: `Go to ${team.key} issues`,
    section: 'navigation',
    keywords: [team.name, 'issues'],
    when: canNavigate,
    run: (c) => c.navigate?.(`${teamPath(team.key)}/issues`),
  })),
  // SPEC-015 §7 (PLAN-015 S4): the team archive page's two tabs, one pair per team. `G` `X` is
  // the route's team's (`nav:team-archive`).
  ...ctx.teams().flatMap((team): Command[] => [
    {
      id: `nav:team-archive:${team.id}`,
      title: `Go to archived issues in ${team.key}`,
      section: 'navigation',
      keywords: [team.name, 'archive', 'archived'],
      when: canNavigate,
      run: (c) => c.navigate?.(teamArchivePath(team.key)),
    },
    {
      id: `nav:team-recently-deleted:${team.id}`,
      title: `Go to recently deleted issues in ${team.key}`,
      section: 'navigation',
      keywords: [team.name, 'deleted', 'trash', 'restore'],
      when: canNavigate,
      run: (c) => c.navigate?.(teamArchivePath(team.key, 'deleted')),
    },
  ]),
];

/**
 * "Open ENG-87" for a query like `eng-87` (command-menu §3.1): opens `/issue/ENG-87`, and the
 * issue page adds the slug (SPEC-011 §4.1). An identifier the replica doesn't hold opens the not
 * found page, as a pasted address would.
 */
export function issueFastPath(query: string): Command | undefined {
  const identifier = typedIdentifier(query);
  if (identifier === undefined) return undefined;
  return {
    id: 'nav:open-issue',
    title: `Open ${identifier}`,
    section: 'navigation',
    when: canNavigate,
    run: (c) => c.navigate?.(`/issue/${identifier}`),
  };
}

/** `ranked` with the fast path's command first, in Suggested, when the query is an identifier. */
export function withIssueFastPath(
  ranked: RankedSection[],
  query: string,
  ctx: CommandContext,
): RankedSection[] {
  const command = issueFastPath(query);
  if (command === undefined || !isOffered(command, ctx)) return ranked;
  const first = { command, section: 'suggested' as const, score: Infinity, indices: [] };
  const suggested = ranked.find((s) => s.section === 'suggested');
  return [
    { section: 'suggested', items: [first, ...(suggested?.items ?? [])] },
    ...ranked.filter((s) => s.section !== 'suggested'),
  ];
}
