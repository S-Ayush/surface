// Commands that shortcuts trigger (SPEC-005 §5 "Bindings are commands", shortcuts.md rule 6). Ids
// follow SPEC-005 §4.1 ("nav:…", "toggle:…"). The command menu (PLAN-005 S6) lists the same ids;
// whoever implements a command registers its handler (commands/registry.ts), and until then its
// shortcut is a no-op with a "not available here" hint.
export const COMMANDS = {
  'ui:command-menu': { title: 'Open command menu' },
  'help:shortcuts': { title: 'Keyboard shortcuts' },
  'toggle:sidebar': { title: 'Toggle sidebar' },
  'nav:settings': { title: 'Go to settings' },
  'toggle:theme': { title: 'Toggle light and dark theme' },
  'ui:escape': { title: 'Close, or clear the selection' },
  'ui:focus-notifications': { title: 'Focus notifications' },
  'nav:open-team': { title: 'Open team…' },
  'ui:submit-dialog': { title: 'Submit the dialog' },
} as const satisfies Record<string, { readonly title: string }>;

export type CommandId = keyof typeof COMMANDS;

export function commandTitle(id: CommandId): string {
  return COMMANDS[id].title;
}
