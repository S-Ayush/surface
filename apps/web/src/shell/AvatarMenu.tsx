// The avatar menu (SPEC-005 §7): Profile, Theme ▸, Keyboard shortcuts, Log out.
import { Avatar, Menu, THEME_PREFERENCES, toast, type ThemePreference } from '@surface/ui';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { useApp, useObserved } from '../app/context.js';
import { chooseTheme } from '../preferences/save.js';
import { useCommandRegistry } from '../shortcuts/ShortcutProvider.js';
import { browserThemeEnvironment, themePreference } from '../theme/toggleTheme.js';
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
  // Initials until the image loads, and if it can't (offline, where the worker doesn't keep
  // /files/, or the server can't send it). A reconnect remounts it, so it tries again.
  const avatar = useObserved(useCallback(() => app.userAvatarSrc(), [app]));
  const online = useObserved(useCallback(() => app.online(), [app]));
  // The synced preference once the replica is ready; before that, this device's (read when the
  // menu opens, so it shows a change made with Alt+Shift+T).
  const synced = useObserved(useCallback(() => app.preferences()?.theme, [app]));
  const [cached, setCached] = useState<ThemePreference>('system');
  const theme = synced ?? cached;

  return (
    <Menu
      onOpenChange={(open) => {
        if (open) setCached(themePreference(browserThemeEnvironment()));
      }}
      trigger={
        // Named by the avatar it shows, not an aria-label on the button: a button label that
        // leaves out the visible initials fails WCAG 2.5.3 (axe label-content-name-mismatch).
        <button type="button" className={styles.avatar}>
          <Avatar
            key={online ? 'online' : 'offline'}
            name={name}
            src={avatar}
            aria-label={`Account menu for ${name}`}
          />
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
          items: [
            {
              type: 'radio',
              label: 'Theme',
              value: theme,
              options: THEME_PREFERENCES.map((preference) => ({
                value: preference,
                label: THEME_LABELS[preference],
              })),
              onValueChange: (value) => {
                const preference = THEME_PREFERENCES.find((option) => option === value);
                if (preference === undefined) return;
                setCached(preference);
                chooseTheme(app.readyStore, browserThemeEnvironment(), preference);
              },
            },
          ],
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
