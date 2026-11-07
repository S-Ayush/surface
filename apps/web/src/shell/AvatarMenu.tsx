// The avatar menu (SPEC-005 §7): Profile, Theme ▸, Keyboard shortcuts, Log out.
import { Avatar, Menu, THEME_PREFERENCES, toast, type ThemePreference } from '@surface/ui';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { useApp, useObserved } from '../app/context.js';
import { useCommandRegistry } from '../shortcuts/ShortcutProvider.js';
import {
  browserThemeEnvironment,
  setThemePreference,
  themePreference,
} from '../theme/toggleTheme.js';
import styles from './Shell.module.css';

const THEME_LABELS: Readonly<Record<ThemePreference, string>> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
};

export function AvatarMenu() {
  const app = useApp();
  const commands = useCommandRegistry();
  const navigate = useNavigate();
  const name = useObserved(useCallback(() => app.userName() ?? 'You', [app]));
  // Read when the menu opens, so it shows a change made with Alt+Shift+T.
  const [theme, setTheme] = useState<ThemePreference>('system');

  return (
    <Menu
      onOpenChange={(open) => {
        if (open) setTheme(themePreference(browserThemeEnvironment()));
      }}
      trigger={
        <button type="button" className={styles.avatar} aria-label={`Account menu for ${name}`}>
          <Avatar name={name} />
        </button>
      }
      align="end"
      items={[
        {
          type: 'item',
          label: 'Profile',
          onSelect: () => {
            void navigate({ to: '/settings/account/profile' });
          },
        },
        {
          type: 'submenu',
          label: 'Theme',
          items: THEME_PREFERENCES.map((preference) => ({
            type: 'checkbox' as const,
            label: THEME_LABELS[preference],
            checked: theme === preference,
            onCheckedChange: () => {
              setThemePreference(browserThemeEnvironment(), preference);
            },
          })),
        },
        {
          type: 'item',
          label: 'Keyboard shortcuts',
          shortcut: '?',
          onSelect: () => {
            commands.run('help:shortcuts');
          },
        },
        { type: 'separator' },
        {
          type: 'item',
          label: 'Log out',
          onSelect: () => {
            // The guards then send the user to /login (followAuth).
            app.auth.logout().catch(() => {
              toast({ tone: 'danger', message: "Couldn't log out. Try again." });
            });
          },
        },
      ]}
    />
  );
}
