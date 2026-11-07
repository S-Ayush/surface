// The `?` overlay's content (SPEC-005 §5 "Registry → help", AC-8): generated from the registry,
// grouped, filtered to the build's milestone, and searchable.
import { spokenShortcut, keyLabels, type Platform } from '@surface/ui';
import { commandTitle } from '../commands/catalog.js';
import type { Milestone } from './milestone.js';
import { inBuild, type Shortcut } from './registry.js';

export type HelpRow = {
  readonly id: string;
  readonly title: string;
  readonly keys: readonly string[];
};
export type HelpGroup = { readonly group: string; readonly rows: readonly HelpRow[] };

const normalize = (text: string) => text.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
const compact = (text: string) => normalize(text).replace(/\s+/g, '');
const words = (text: string) =>
  normalize(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** The keys as written, as shown and as spoken, without spaces: "gs", "mod+k", "⌘k", "commandk". */
function keyForms(binding: Shortcut, platform: Platform): string[] {
  return [
    binding.keys.join(''),
    binding.keys.map((chord) => keyLabels(chord, platform).join('')).join(''),
    spokenShortcut(binding.keys, platform).replace(/ then /g, ' '),
  ].map(compact);
}

/**
 * Groups in registry order. A query matches a row when each of its words begins a word of the title
 * or group ("theme", "go to s"), or when it begins the keys ("G S", "⌘K", "command k", "mod"). Only
 * the last word, still being typed, may be a single letter: "g s" is a key search, not two prefixes.
 */
export function helpGroups(
  bindings: readonly Shortcut[],
  options: { query?: string; platform: Platform; milestone?: Milestone },
): HelpGroup[] {
  const query = normalize(options.query ?? '');
  const queryWords = query.split(' ').filter(Boolean);
  const queryKeys = compact(query);
  const groups = new Map<string, HelpRow[]>();
  for (const binding of inBuild(bindings, options.milestone)) {
    const title = commandTitle(binding.command);
    if (query !== '') {
      const text = words(`${title} ${binding.group}`);
      const textMatch = queryWords.every(
        (word, i) =>
          (word.length > 1 || i === queryWords.length - 1) &&
          text.some((candidate) => candidate.startsWith(word)),
      );
      const keyMatch = keyForms(binding, options.platform).some((form) =>
        form.startsWith(queryKeys),
      );
      if (!textMatch && !keyMatch) continue;
    }
    const rows = groups.get(binding.group) ?? [];
    rows.push({ id: binding.id, title, keys: binding.keys });
    groups.set(binding.group, rows);
  }
  return [...groups].map(([group, rows]) => ({ group, rows }));
}
