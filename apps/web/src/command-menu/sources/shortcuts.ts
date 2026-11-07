// Shortcut hints for commands (SPEC-005 §5 "Bindings are commands"): the keys bound to a command
// in this build, as the menu shows them on the right of each row.
import { SHORTCUTS, inBuild } from '../../shortcuts/registry.js';

const pressed = (keys: readonly string[]) => keys.join(' ');

/**
 * Whether `keys` (registry notation: "Mod+Shift+E" or "G S") are bound in this build. An operation
 * declares its key in `ui.shortcut`; the menu shows it only once the shortcut registry binds it,
 * so a hint (and `aria-keyshortcuts`) never names a key that does nothing.
 */
export function isBound(keys: string): boolean {
  const wanted = pressed(keys.split(' ').filter((part) => part !== ''));
  return inBuild(SHORTCUTS).some((binding) => pressed(binding.keys) === wanted);
}

export function shortcutsFor(id: string): (string | readonly string[])[] {
  return inBuild(SHORTCUTS)
    .filter((binding) => binding.command === id)
    .map((binding) => (binding.keys.length === 1 ? (binding.keys[0] ?? '') : binding.keys));
}
