import { OverlayProvider } from '@surface/ui';
import { STATUS_CATEGORIES } from '@surface/domain';
import { CommandMenuProvider } from './command-menu/CommandMenuProvider.js';
import { ShortcutHelp } from './shortcuts/ShortcutHelp.js';
import { ShortcutProvider, useCommand } from './shortcuts/ShortcutProvider.js';
import { browserThemeEnvironment, toggleTheme } from './theme/toggleTheme.js';

/** Commands the app implements before the shell exists (PLAN-005 S4 adds the rest). */
function AppCommands() {
  useCommand('toggle:theme', () => {
    toggleTheme(browserThemeEnvironment());
  });
  return null;
}

export function App() {
  return (
    <OverlayProvider>
      <ShortcutProvider>
        <CommandMenuProvider>
          <AppCommands />
          <main tabIndex={-1}>
            <h1>Surface</h1>
            <p>
              Monorepo skeleton (PLAN-004 S1). {STATUS_CATEGORIES.length} status categories loaded.
            </p>
            <p>Press ? for keyboard shortcuts, or Mod+K for the command menu.</p>
          </main>
          <ShortcutHelp />
        </CommandMenuProvider>
      </ShortcutProvider>
    </OverlayProvider>
  );
}
