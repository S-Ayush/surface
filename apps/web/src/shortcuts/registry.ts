// The shortcut registry (shortcuts.md §1, SPEC-005 §5). Every shortcut is declared once, here.
// The engine, the `?` help overlay and the conflict test all read SHORTCUTS.
import type { CommandId } from '../commands/catalog.js';
import { toChord, type Chord } from './chord.js';
import { BUILD_MILESTONE, isInBuild, type Milestone } from './milestone.js';

/** Where a binding is active (shortcuts.md §2). Overlay scopes come from the overlay manager. */
export const SCOPES = [
  'global',
  'list',
  'issue',
  'inbox',
  'triage',
  'editor',
  'modal',
  'picker',
] as const;
export type Scope = (typeof SCOPES)[number];

export type ShortcutDefinition = {
  id: string;
  /** One chord ("Mod+K", "?") or a sequence (["G", "S"]). */
  keys: string | readonly string[];
  scope: Scope;
  command: CommandId;
  /** Heading in the `?` help overlay. */
  group: string;
  milestone: Milestone;
  /** Ids of bindings in a less specific scope that this one deliberately overrides (E1). */
  shadows?: readonly string[];
  /** Nothing to say when the command is unavailable (Esc is pressed all the time). */
  quiet?: boolean;
  /**
   * A component handles the key itself (F8: the Radix toast region). The binding is listed in help
   * and checked for conflicts, but the engine does not dispatch it.
   */
  native?: boolean;
};

export type Shortcut = Omit<ShortcutDefinition, 'keys'> & {
  readonly keys: readonly string[];
  readonly chords: readonly Chord[];
};

export function shortcut(definition: ShortcutDefinition): Shortcut {
  const keys = typeof definition.keys === 'string' ? [definition.keys] : [...definition.keys];
  if (keys.length === 0) throw new Error(`Shortcut ${definition.id} has no keys`);
  return { ...definition, keys, chords: keys.map(toChord) };
}

export const SHORTCUTS: readonly Shortcut[] = [
  // shortcuts.md §3.1
  shortcut({
    id: 'global.commandMenu',
    keys: 'Mod+K',
    scope: 'global',
    command: 'ui:command-menu',
    group: 'General',
    milestone: 'M0',
  }),
  shortcut({
    id: 'global.help',
    keys: '?',
    scope: 'global',
    command: 'help:shortcuts',
    group: 'General',
    milestone: 'M0',
  }),
  shortcut({
    id: 'global.sidebar',
    keys: '[',
    scope: 'global',
    command: 'toggle:sidebar',
    group: 'General',
    milestone: 'M0',
  }),
  shortcut({
    id: 'global.settings',
    keys: 'Mod+,',
    scope: 'global',
    command: 'nav:settings',
    group: 'General',
    milestone: 'M0',
  }),
  shortcut({
    id: 'global.theme',
    keys: 'Alt+Shift+T',
    scope: 'global',
    command: 'toggle:theme',
    group: 'General',
    milestone: 'M0',
  }),
  shortcut({
    id: 'global.escape',
    keys: 'Esc',
    scope: 'global',
    command: 'ui:escape',
    group: 'General',
    milestone: 'M0',
    quiet: true,
  }),
  shortcut({
    id: 'global.notifications',
    keys: 'F8',
    scope: 'global',
    command: 'ui:focus-notifications',
    group: 'General',
    milestone: 'M0',
    native: true,
  }),
  // shortcuts.md §3.2
  shortcut({
    id: 'nav.settings',
    keys: ['G', 'S'],
    scope: 'global',
    command: 'nav:settings',
    group: 'Navigation',
    milestone: 'M0',
  }),
  shortcut({
    id: 'nav.openTeam',
    keys: ['O', 'T'],
    scope: 'global',
    command: 'nav:open-team',
    group: 'Navigation',
    milestone: 'M0',
  }),
  // shortcuts.md §3.8 (the other picker and dialog keys are handled by the components)
  shortcut({
    id: 'dialog.submit',
    keys: 'Mod+Enter',
    scope: 'modal',
    command: 'ui:submit-dialog',
    group: 'Dialogs and pickers',
    milestone: 'M0',
  }),
];

/** The bindings this build ships (SPEC-005 §5): the engine sees only these, like the help overlay. */
export function inBuild(
  bindings: readonly Shortcut[],
  milestone: Milestone = BUILD_MILESTONE,
): Shortcut[] {
  return bindings.filter((binding) => isInBuild(binding.milestone, milestone));
}
