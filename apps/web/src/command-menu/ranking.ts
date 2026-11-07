// Ranking (SPEC-005 §4.2): score = fuzzy(query, title + keywords) × (applies to context ? 2 : 1)
// × frecency. Sections keep their order (command-menu.md §1); commands are sorted within them.
import { matchCommand } from './fuzzy.js';
import {
  SECTIONS,
  type Command,
  type CommandContext,
  type CommandPage,
  type CommandSource,
  type PageItem,
  type Section,
} from './model.js';

export type RankedCommand = {
  readonly command: Command;
  readonly section: Section;
  readonly score: number;
  /** Matched title characters, for highlighting. */
  readonly indices: readonly number[];
};

export type RankedSection = { readonly section: Section; readonly items: readonly RankedCommand[] };

export type Booster = { boost(id: string): number };

/** Calls `read`, or returns `fallback` if it throws: one broken command never breaks the menu. */
function safely<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/** Whether the command is offered now. A broken `when` hides its command. */
export const isOffered = (command: Command, ctx: CommandContext): boolean =>
  safely(() => command.when?.(ctx) ?? true, false);

/** Every source's commands; a source that throws contributes none. */
export const collect = (sources: readonly CommandSource[], ctx: CommandContext): Command[] =>
  sources.flatMap((source) => safely(() => source(ctx), []));

/**
 * With an empty query: Suggested (commands that act on the context) first, then the other sections
 * in order (§4.2). With a query: only matches, best first within each section.
 */
export function rankCommands(
  commands: readonly Command[],
  query: string,
  ctx: CommandContext,
  frecency: Booster,
): RankedSection[] {
  const bySection = new Map<Section, RankedCommand[]>();
  const seen = new Set<string>();
  for (const command of commands) {
    if (seen.has(command.id) || !isOffered(command, ctx)) continue;
    seen.add(command.id);
    const match = matchCommand(query, command.title, command.keywords);
    if (match === null) continue;
    const applies = safely(() => command.appliesTo?.(ctx) ?? false, false);
    const section: Section = applies ? 'suggested' : command.section;
    const score = match.score * (applies ? 2 : 1) * frecency.boost(command.id);
    const list = bySection.get(section) ?? [];
    list.push({ command, section, score, indices: match.indices });
    bySection.set(section, list);
  }
  return SECTIONS.flatMap((section) => {
    const items = bySection.get(section);
    if (items === undefined) return [];
    // Stable: equal scores keep source order, so an empty query lists commands as declared.
    return [{ section, items: [...items].sort((a, b) => b.score - a.score) }];
  });
}

export type RankedItem = { readonly item: PageItem; readonly indices: readonly number[] };

/** A nested page's items matching the query, best first. */
export function rankPageItems(page: CommandPage, query: string): RankedItem[] {
  return safely(() => page.items(), [])
    .flatMap((item) => {
      const match = matchCommand(query, item.title, item.keywords);
      return match === null ? [] : [{ item, indices: match.indices, score: match.score }];
    })
    .sort((a, b) => b.score - a.score)
    .map(({ item, indices }) => ({ item, indices }));
}
