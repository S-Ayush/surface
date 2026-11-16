/**
 * The behaviour of the EmojiPicker (design-system §5.3, SPEC-013 §3.4) as pure functions, so
 * search, the "Frequently used" list and the grid keys are unit tested without a DOM.
 *
 * `packages/ui` cannot import the editor, which owns the bundled emoji data (SPEC-013 D22): the
 * picker takes the emoji through a `loadEmoji` prop, and `PickerEmoji` is the part of the
 * editor's `Emoji` it reads (the shapes match, so `apps/web` passes the editor's loader as is).
 */

/** One emoji, as the editor's lazy data gives it. */
export interface PickerEmoji {
  readonly unicode: string;
  /** "thumbs up": the accessible name. */
  readonly label: string;
  /** Shortcodes without colons, the primary one first. */
  readonly shortcodes: readonly string[];
  readonly tags?: readonly string[];
  /** emojibase group: 0 smileys … 9 flags. Group 2 (skin tone components) is never shown. */
  readonly group: number;
}

/** emojibase's group names, in its order; group 2 (components) is left out. */
export const EMOJI_CATEGORIES: readonly { readonly group: number; readonly name: string }[] = [
  { group: 0, name: 'Smileys & emotion' },
  { group: 1, name: 'People & body' },
  { group: 3, name: 'Animals & nature' },
  { group: 4, name: 'Food & drink' },
  { group: 5, name: 'Travel & places' },
  { group: 6, name: 'Activities' },
  { group: 7, name: 'Objects' },
  { group: 8, name: 'Symbols' },
  { group: 9, name: 'Flags' },
];

/** Cells per grid row: the arrow keys move by one cell or by one row. */
export const EMOJI_COLUMNS = 8;

/** At most this many in "Frequently used" (two rows). */
export const FREQUENT_SHOWN = 16;

/** At most this many kept on the device. */
const FREQUENT_KEPT = 48;

/** What "Frequently used" shows before the user has picked anything (Linear's defaults). */
export const DEFAULT_FREQUENT: readonly string[] = ['👍', '👎', '😄', '🎉', '😕', '❤️', '🚀', '👀'];

/** The `localStorage` key of the device's emoji use (SPEC-013 §3.4: kept on this device). */
export const FREQUENT_STORAGE_KEY = 'surface.emoji.frequent';

export interface EmojiSection {
  readonly id: string;
  readonly name: string;
  readonly emoji: readonly PickerEmoji[];
}

/** The emoji use kept on this device: emoji → how often, and when last. */
export type FrequentUse = Readonly<Record<string, { readonly count: number; readonly at: number }>>;

function words(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * The emoji matching `query`: every word must start a word of the label, a shortcode or a tag.
 * A shortcode that starts with the whole query ranks first (`:thu` finds 👍 before 🤔).
 */
export function searchEmoji(emoji: readonly PickerEmoji[], query: string): PickerEmoji[] {
  const needles = words(query.replace(/:/g, ' '));
  if (needles.length === 0) return [];
  const joined = needles.join('_');
  const first: PickerEmoji[] = [];
  const rest: PickerEmoji[] = [];
  for (const entry of emoji) {
    if (entry.group === 2) continue;
    const haystack = [
      ...entry.label.toLowerCase().split(/[\s:,-]+/),
      ...entry.shortcodes.flatMap((code) => [code, ...code.split('_')]),
      ...(entry.tags ?? []).map((tag) => tag.toLowerCase()),
    ];
    if (!needles.every((needle) => haystack.some((word) => word.startsWith(needle)))) continue;
    if (entry.shortcodes.some((code) => code.startsWith(joined))) first.push(entry);
    else rest.push(entry);
  }
  return [...first, ...rest];
}

/** The device's most used emoji, most used first (then most recent), that the data still has. */
export function frequentEmoji(emoji: readonly PickerEmoji[], use: FrequentUse): PickerEmoji[] {
  const byUnicode = new Map(emoji.map((e) => [e.unicode, e]));
  const ranked = Object.entries(use)
    .sort(([, a], [, b]) => b.count - a.count || b.at - a.at)
    .map(([unicode]) => byUnicode.get(unicode))
    .filter((e): e is PickerEmoji => e !== undefined);
  const picked =
    ranked.length > 0 ? ranked : DEFAULT_FREQUENT.flatMap((u) => byUnicode.get(u) ?? []);
  return picked.slice(0, FREQUENT_SHOWN);
}

/** Records one pick: the emoji counts once more, and the list keeps the most used. */
export function recordUse(use: FrequentUse, unicode: string, at: number): FrequentUse {
  const previous = use[unicode];
  const next = { ...use, [unicode]: { count: (previous?.count ?? 0) + 1, at } };
  const kept = Object.entries(next)
    .sort(([, a], [, b]) => b.count - a.count || b.at - a.at)
    .slice(0, FREQUENT_KEPT);
  return Object.fromEntries(kept);
}

/** Reads the stored use; anything unreadable is no use at all. */
export function parseFrequentUse(raw: string | null): FrequentUse {
  if (raw === null) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    const result: Record<string, { count: number; at: number }> = {};
    for (const [unicode, entry] of Object.entries(value)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const count: unknown = Reflect.get(entry, 'count');
      const at: unknown = Reflect.get(entry, 'at');
      if (typeof count === 'number' && typeof at === 'number' && count > 0) {
        result[unicode] = { count, at };
      }
    }
    return result;
  } catch {
    return {};
  }
}

/** The sections to show: results for a query, else "Frequently used" and the categories. */
export function emojiSections(
  emoji: readonly PickerEmoji[],
  query: string,
  use: FrequentUse,
): EmojiSection[] {
  if (words(query).length > 0) {
    const results = searchEmoji(emoji, query);
    return results.length === 0 ? [] : [{ id: 'results', name: 'Search results', emoji: results }];
  }
  const sections: EmojiSection[] = [];
  const frequent = frequentEmoji(emoji, use);
  if (frequent.length > 0)
    sections.push({ id: 'frequent', name: 'Frequently used', emoji: frequent });
  for (const { group, name } of EMOJI_CATEGORIES) {
    const members = emoji.filter((e) => e.group === group);
    if (members.length > 0) sections.push({ id: `group-${String(group)}`, name, emoji: members });
  }
  return sections;
}

/** A cell of the grid: its section and its index there. The highlight is one cell. */
export interface GridCell {
  readonly section: number;
  readonly index: number;
}

/** The first cell, or null when there is nothing to show. */
export function firstCell(sections: readonly EmojiSection[]): GridCell | null {
  const section = sections.findIndex((s) => s.emoji.length > 0);
  return section < 0 ? null : { section, index: 0 };
}

export function cellEmoji(
  sections: readonly EmojiSection[],
  cell: GridCell | null,
): PickerEmoji | undefined {
  return cell === null ? undefined : sections[cell.section]?.emoji[cell.index];
}

/**
 * Moves the highlight with an arrow key, `Home` or `End`. Left and right step through the cells in
 * reading order, across sections; up and down keep the column, moving into the section above or
 * below at its last or first row. Stops at the edges.
 */
export function moveCell(
  sections: readonly EmojiSection[],
  cell: GridCell | null,
  key: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End',
): GridCell | null {
  if (cell === null) return firstCell(sections);
  const size = (section: number) => sections[section]?.emoji.length ?? 0;
  const { section, index } = cell;
  switch (key) {
    case 'Home':
      return firstCell(sections);
    case 'End': {
      for (let s = sections.length - 1; s >= 0; s -= 1) {
        if (size(s) > 0) return { section: s, index: size(s) - 1 };
      }
      return cell;
    }
    case 'ArrowRight': {
      if (index + 1 < size(section)) return { section, index: index + 1 };
      for (let s = section + 1; s < sections.length; s += 1) {
        if (size(s) > 0) return { section: s, index: 0 };
      }
      return cell;
    }
    case 'ArrowLeft': {
      if (index > 0) return { section, index: index - 1 };
      for (let s = section - 1; s >= 0; s -= 1) {
        if (size(s) > 0) return { section: s, index: size(s) - 1 };
      }
      return cell;
    }
    case 'ArrowDown': {
      const column = index % EMOJI_COLUMNS;
      if (index + EMOJI_COLUMNS < size(section)) return { section, index: index + EMOJI_COLUMNS };
      // The next row of this section may be shorter than the column: its last cell.
      const nextRowStart = index - column + EMOJI_COLUMNS;
      if (nextRowStart < size(section)) return { section, index: size(section) - 1 };
      for (let s = section + 1; s < sections.length; s += 1) {
        if (size(s) > 0) return { section: s, index: Math.min(column, size(s) - 1) };
      }
      return cell;
    }
    case 'ArrowUp': {
      const column = index % EMOJI_COLUMNS;
      if (index >= EMOJI_COLUMNS) return { section, index: index - EMOJI_COLUMNS };
      for (let s = section - 1; s >= 0; s -= 1) {
        const n = size(s);
        if (n === 0) continue;
        const lastRowStart = Math.floor((n - 1) / EMOJI_COLUMNS) * EMOJI_COLUMNS;
        return { section: s, index: Math.min(lastRowStart + column, n - 1) };
      }
      return cell;
    }
  }
}
