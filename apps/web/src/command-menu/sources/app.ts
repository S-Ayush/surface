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
  /** Acts on the focused attachment row (SPEC-014 §7): only with an attachment as the target. */
  attachment?: true;
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
  {
    id: 'comment:new-issue',
    section: 'settings',
    keywords: ['create issue', 'turn into issue'],
    comment: true,
  },
  // The attachment context (command-menu.md §3.3, PLAN-014 S5); Rename and Remove are operations.
  { id: 'attachment:open', section: 'settings', keywords: ['view', 'preview'], attachment: true },
  {
    id: 'attachment:download',
    section: 'settings',
    keywords: ['save file', 'file'],
    attachment: true,
  },
  {
    id: 'attachment:copy-link',
    section: 'settings',
    keywords: ['url', 'clipboard'],
    attachment: true,
  },
];

export function appSource(commands: CommandRegistry): CommandSource {
  return () =>
    MENU_COMMANDS.map(({ id, section, keywords, issue, comment, attachment }) => {
      const kind =
        issue === true
          ? 'issue'
          : comment === true
            ? 'comment'
            : attachment === true
              ? 'attachment'
              : undefined;
      return {
        id,
        title: commandTitle(id),
        section,
        keywords,
        shortcuts: shortcutsFor(id),
        when: (ctx: CommandContext) =>
          commands.isAvailable(id) && (kind === undefined || ctx.target.kind === kind),
        ...(kind === undefined
          ? {}
          : { appliesTo: (ctx: CommandContext) => ctx.target.kind === kind }),
        run: () => commands.invoke(id),
      };
    });
}
