// The app's own commands in the menu (command-menu.md §2 "Toggles"): the shortcut catalog's
// commands that make sense as menu rows. Each is offered while its handler is registered
// (useCommand), so a command appears exactly when its shortcut works, also while the menu is open.
import { commandTitle, type CommandId } from '../../commands/catalog.js';
import type { CommandRegistry } from '../../commands/registry.js';
import type { Command, CommandSource } from '../model.js';
import { shortcutsFor } from './shortcuts.js';

const MENU_COMMANDS: readonly {
  id: CommandId;
  section: Command['section'];
  keywords: readonly string[];
}[] = [
  { id: 'toggle:theme', section: 'settings', keywords: ['dark mode', 'light mode', 'appearance'] },
  { id: 'toggle:sidebar', section: 'settings', keywords: ['hide sidebar', 'show sidebar'] },
  { id: 'help:shortcuts', section: 'help', keywords: ['keyboard', 'keys', 'hotkeys'] },
];

export function appSource(commands: CommandRegistry): CommandSource {
  return () =>
    MENU_COMMANDS.map(({ id, section, keywords }) => ({
      id,
      title: commandTitle(id),
      section,
      keywords,
      shortcuts: shortcutsFor(id),
      when: () => commands.isAvailable(id),
      run: () => commands.invoke(id),
    }));
}
