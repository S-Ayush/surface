// Navigation commands (SPEC-005 §4.1): the route table plus one "Go to {team}" per live team, and
// "Open team…" (O T), a nested page of teams. Hidden until the shell provides `navigate` (S4).
import { commandTitle } from '../../commands/catalog.js';
import type { Command, CommandContext, CommandPage, CommandSource } from '../model.js';
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
];
