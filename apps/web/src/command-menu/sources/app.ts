// The app's own commands in the menu (command-menu.md §2 "Toggles"): the shortcut catalog's
// commands that make sense as menu rows. Each is offered while its handler is registered
// (useCommand), so a command appears exactly when its shortcut works, also while the menu is open.
import { commandTitle, type CommandId } from '../../commands/catalog.js';
import type { CommandRegistry } from '../../commands/registry.js';
import type { Command, CommandContext, CommandSource } from '../model.js';
import { shortcutsFor } from './shortcuts.js';

const MENU_COMMANDS: readonly {
  id: CommandId;
  section: Command['section'];
  keywords: readonly string[];
  /** Acts on the focused or open issue: offered only with an issue as the target (SPEC-012 §3.8). */
  issue?: true;
  /** Acts on the focused comment (SPEC-013 §7): offered only with a comment as the target. */
  comment?: true;
}[] = [
  { id: 'toggle:theme', section: 'settings', keywords: ['dark mode', 'light mode', 'appearance'] },
  { id: 'toggle:sidebar', section: 'settings', keywords: ['hide sidebar', 'show sidebar'] },
  { id: 'help:shortcuts', section: 'help', keywords: ['keyboard', 'keys', 'hotkeys'] },
  // The issue commands of PLAN-012 S6. Their handlers come from the issue list or the issue page.
  { id: 'issue:rename', section: 'settings', keywords: ['title', 'edit title'], issue: true },
  { id: 'issue:copy-id', section: 'settings', keywords: ['identifier', 'clipboard'], issue: true },
  { id: 'issue:copy-url', section: 'settings', keywords: ['link', 'clipboard'], issue: true },
  { id: 'issue:copy-title', section: 'settings', keywords: ['name', 'clipboard'], issue: true },
  { id: 'issue:copy-title-link', section: 'settings', keywords: ['markdown link'], issue: true },
  {
    id: 'issue:copy-markdown',
    section: 'settings',
    keywords: ['clipboard', 'description'],
    issue: true,
  },
  {
    id: 'issue:copy-branch',
    section: 'settings',
    keywords: ['git', 'branch name', 'clipboard'],
    issue: true,
  },
  // The comment context (SPEC-013 §7, PLAN-013 S5). Their handlers come from the comment timeline.
  { id: 'comment:copy-link', section: 'settings', keywords: ['url', 'clipboard'], comment: true },
  {
    id: 'comment:copy-markdown',
    section: 'settings',
    keywords: ['clipboard', 'text'],
    comment: true,
  },
];

export function appSource(commands: CommandRegistry): CommandSource {
  return () =>
    MENU_COMMANDS.map(({ id, section, keywords, issue, comment }) => ({
      id,
      title: commandTitle(id),
      section,
      keywords,
      shortcuts: shortcutsFor(id),
      when: (ctx) =>
        commands.isAvailable(id) &&
        (issue !== true || ctx.target.kind === 'issue') &&
        (comment !== true || ctx.target.kind === 'comment'),
      ...(issue === true
        ? { appliesTo: (ctx: CommandContext) => ctx.target.kind === 'issue' }
        : comment === true
          ? { appliesTo: (ctx: CommandContext) => ctx.target.kind === 'comment' }
          : {}),
      run: () => commands.invoke(id),
    }));
}
