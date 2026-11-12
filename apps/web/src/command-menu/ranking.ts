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
  type Entry = {
    command: Command;
    applies: boolean;
    match: NonNullable<ReturnType<typeof matchCommand>>;
  };
  const entries: Entry[] = [];
  for (const command of commands) {
    if (seen.has(command.id) || !isOffered(command, ctx)) continue;
    seen.add(command.id);
    const match = matchCommand(query, command.title, command.keywords);
    if (match === null) continue;
    entries.push({
      command,
      applies: safely(() => command.appliesTo?.(ctx) ?? false, false),
      match,
    });
  }
  const scoreOf = (entry: Entry, base: number) =>
    base * (entry.applies ? 2 : 1) * frecency.boost(entry.command.id);
  // SPEC-012 §3.8, AC-16: a destructive command ranks first only when its title matches the query
  // better than any other command does. Otherwise it drops out of Suggested into its own section,
  // so a keyword match ("deleted") never puts "Delete issue" under the cursor.
  const bestOther = Math.max(
    0,
    ...entries
      .filter((entry) => entry.command.destructive !== true)
      .map((e) => scoreOf(e, e.match.score)),
  );
  for (const entry of entries) {
    const { command, match } = entry;
    let section: Section = entry.applies ? 'suggested' : command.section;
    let score = scoreOf(entry, match.score);
    if (command.destructive === true) {
      const titleScore = matchCommand(query, command.title)?.score ?? 0;
      if (scoreOf(entry, titleScore) <= bestOther) {
        section = command.section;
        score = Math.min(match.score * frecency.boost(command.id), bestOther * 0.99);
      }
    }
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
