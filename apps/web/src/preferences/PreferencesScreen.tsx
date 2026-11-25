// Settings → Account → Preferences (SPEC-005 §6; PLAN-005 S7): theme, font size and home view.
// Each control saves at once with `user.updatePreferences`; the change shows optimistically and
// syncs to the user's other tabs and devices (AC-10).
import type { FontSize, ThemePreferenceValue } from '@surface/operations';
import {
  Button,
  Menu,
  SegmentedControl,
  SettingsGroup,
  SettingsRow,
  Spinner,
  toast,
} from '@surface/ui';
import { ChevronDown } from 'lucide-react';
import { useCallback } from 'react';
import type { AppModel } from '../app/AppModel.js';
import { useApp, useObserved } from '../app/context.js';
import type { ScreenProps } from '../app/screens.js';
import { browserThemeEnvironment } from '../theme/toggleTheme.js';
import { chooseTheme, savePreferences, type PreferenceChange } from './save.js';
import styles from './Preferences.module.css';

const THEMES: readonly { value: ThemePreferenceValue; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

const FONT_SIZES: readonly { value: FontSize; label: string }[] = [
  { value: 'small', label: 'Small' },
  { value: 'default', label: 'Default' },
  { value: 'large', label: 'Large' },
];

export const MY_ISSUES = 'my-issues';
const WAIT = 'Your workspace is still loading. Try again in a moment.';

function save(app: AppModel, change: PreferenceChange): void {
  const store = app.readyStore;
  const problem = store === null ? WAIT : savePreferences(store, change);
  if (problem !== null) toast({ tone: 'danger', message: problem });
}

type TeamOption = { readonly id: string; readonly name: string };

/**
 * The home view's choices: My issues, the user's teams in sidebar order, and the current home
 * team if it isn't one of them (a public team they left still opens: `homeTeamOf`).
 */
export function homeOptions(teams: readonly TeamOption[], home: TeamOption | undefined) {
  const listed = home === undefined || teams.some((team) => team.id === home.id);
  return [
    { value: MY_ISSUES, label: 'My issues' },
    ...[...teams, ...(listed ? [] : [home])].map((team) => ({ value: team.id, label: team.name })),
  ];
}

export function PreferencesScreen(_props: ScreenProps) {
  const app = useApp();
  const preferences = useObserved(useCallback(() => app.preferences(), [app]));
  const teams = useObserved(useCallback(() => app.teams(), [app]));
  // What `/` opens: the home team while it is visible, else My issues (review M1).
  const homeTeam = useObserved(useCallback(() => app.homeTeam(), [app]));
  if (preferences === undefined) {
    return (
      <div className={styles.loading}>
        <Spinner />
      </div>
    );
  }
  const options = homeOptions(teams, homeTeam);
  const home = homeTeam?.id ?? MY_ISSUES;
  const homeLabel = options.find((option) => option.value === home)?.label ?? 'My issues';

  return (
    <SettingsGroup title="Appearance">
      <SettingsRow id="setting-theme" label="Theme" hint="System follows your computer’s setting.">
        <SegmentedControl
          aria-label="Theme"
          options={THEMES}
          value={preferences.theme}
          onValueChange={(theme) => {
            chooseTheme(app.readyStore, browserThemeEnvironment(), theme);
          }}
        />
      </SettingsRow>
      <SettingsRow id="setting-font-size" label="Font size" hint="Changes the size of text.">
        <SegmentedControl
          aria-label="Font size"
          options={FONT_SIZES}
          value={preferences.fontSize}
          onValueChange={(fontSize) => {
            save(app, { fontSize });
          }}
        />
      </SettingsRow>
      <SettingsRow id="setting-home-view" label="Home view" hint="The page Surface opens on.">
        <Menu
          align="end"
          trigger={
            <Button variant="secondary" aria-label={`Home view: ${homeLabel}`}>
              {homeLabel}
              <ChevronDown className={styles.chevron} aria-hidden="true" />
            </Button>
          }
          items={[
            {
              type: 'radio',
              label: 'Home view',
              value: home,
              options,
              onValueChange: (value) => {
                save(app, { homeTeam: value === MY_ISSUES ? null : value });
              },
            },
          ]}
        />
      </SettingsRow>
    </SettingsGroup>
  );
}
