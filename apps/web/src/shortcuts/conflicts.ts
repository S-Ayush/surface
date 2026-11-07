// The conflict and reserved-keys check (shortcuts.md rule 5, SPEC-005 AC-7), run on SHORTCUTS by
// test/shortcuts-conflicts.test.ts.
import type { Platform } from '@surface/ui';
import { platformChordText, toChord } from './chord.js';
import type { Scope, Shortcut } from './registry.js';

/** Browser and OS shortcuts a binding must never take (shortcuts.md rule 5). */
export const RESERVED_SHORTCUTS = [
  'Mod+T',
  'Mod+W',
  'Mod+N',
  'Mod+Q',
  'Mod+L',
  'Mod+R',
  'Mod+Shift+T',
  'Mod+Tab',
  'F5',
  'F11',
  'F12',
] as const;

const PLATFORMS: readonly Platform[] = ['mac', 'other'];

/**
 * Scopes that can be active together (shortcuts.md §2). `global` is always active. An open overlay
 * captures page scopes (`list`, `inbox`, …) but not the editor, which can sit inside a dialog.
 */
const OVERLAPPING: ReadonlyArray<readonly [Scope, Scope]> = [
  ['list', 'issue'],
  ['list', 'inbox'],
  ['list', 'triage'],
  ['issue', 'inbox'],
  ['issue', 'triage'],
  ['issue', 'editor'],
  ['editor', 'inbox'],
  ['editor', 'triage'],
  ['editor', 'modal'],
  ['editor', 'picker'],
  ['modal', 'picker'],
];

export function scopesOverlap(a: Scope, b: Scope): boolean {
  if (a === b || a === 'global' || b === 'global') return true;
  return OVERLAPPING.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

export type Conflict = { readonly a: string; readonly b: string; readonly keys: string };

/** The sequence as pressed on a platform: ["G", "S"] → "G S". */
const pressed = (binding: Shortcut, platform: Platform) =>
  binding.chords.map((chord) => platformChordText(chord, platform));

const isPrefix = (short: readonly string[], long: readonly string[]) =>
  short.length <= long.length && short.every((chord, i) => chord === long[i]);

/**
 * Pairs of bindings in overlapping scopes where one's keys equal or begin the other's ("G" and
 * "G S": the single key would fire before the sequence could finish), on either platform. A
 * binding may override one in a less specific scope only by naming it in `shadows`.
 */
export function findConflicts(bindings: readonly Shortcut[]): Conflict[] {
  const conflicts: Conflict[] = [];
  bindings.forEach((a, i) => {
    for (const b of bindings.slice(i + 1)) {
      if (!scopesOverlap(a.scope, b.scope)) continue;
      if (a.scope !== b.scope && (a.shadows?.includes(b.id) || b.shadows?.includes(a.id))) {
        continue;
      }
      for (const platform of PLATFORMS) {
        const keysA = pressed(a, platform);
        const keysB = pressed(b, platform);
        if (isPrefix(keysA, keysB) || isPrefix(keysB, keysA)) {
          conflicts.push({ a: a.id, b: b.id, keys: `${keysA.join(' ')} / ${keysB.join(' ')}` });
          break;
        }
      }
    }
  });
  return conflicts;
}

/** Bindings that use a reserved browser or OS shortcut anywhere in their keys, on either platform. */
export function findReserved(bindings: readonly Shortcut[]): { id: string; keys: string }[] {
  const reserved = PLATFORMS.flatMap((platform) =>
    RESERVED_SHORTCUTS.map((text) => platformChordText(toChord(text), platform)),
  );
  return bindings.flatMap((binding) =>
    PLATFORMS.flatMap((platform) => pressed(binding, platform))
      .filter((keys) => reserved.includes(keys))
      .slice(0, 1)
      .map((keys) => ({ id: binding.id, keys })),
  );
}

/** How specific a scope is: global < page < focused component < overlay (SPEC-005 §5 order). */
const SPECIFICITY: Readonly<Record<Scope, number>> = {
  global: 0,
  inbox: 1,
  triage: 1,
  list: 2,
  issue: 2,
  editor: 2,
  modal: 3,
  picker: 3,
};

/** Other registry rules: unique ids, and `shadows` naming real bindings in less specific scopes. */
export function findInvalid(bindings: readonly Shortcut[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const binding of bindings) {
    if (ids.has(binding.id)) problems.push(`Duplicate shortcut id ${binding.id}`);
    ids.add(binding.id);
  }
  for (const binding of bindings) {
    for (const id of binding.shadows ?? []) {
      const target = bindings.find((other) => other.id === id);
      if (target === undefined) problems.push(`${binding.id} shadows unknown ${id}`);
      else if (SPECIFICITY[target.scope] >= SPECIFICITY[binding.scope]) {
        problems.push(`${binding.id} can only shadow a less specific scope than ${target.scope}`);
      }
    }
  }
  return problems;
}
