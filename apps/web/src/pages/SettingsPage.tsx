// Settings (SPEC-005 §3, SPEC-001 §7): the PLAN-001 screen for the route in a centred column.
// Admin-only sections are left out of the nav for Members, and their URLs are not found
// (SPEC-005 §3 guards, permissions.md §5).
import { Spinner } from '@surface/ui';
import { useCallback } from 'react';
import { useApp, useObserved } from '../app/context.js';
import { adminAccess } from '../app/guards.js';
import type { SettingsSection } from '../app/settings.js';
import { SCREENS } from '../features/screens.js';
import { PageHeader } from '../shell/PageHeader.js';
import { NotFoundPage } from './NotFoundPage.js';
import { Unavailable } from './PublicPage.js';
import styles from './Pages.module.css';

export type SettingsPageProps = {
  /** From app/settings.ts, which holds the admin flag. */
  section: SettingsSection;
  params?: Readonly<Record<string, string>>;
};

export function SettingsPage({ section, params = {} }: SettingsPageProps) {
  const app = useApp();
  const isAdmin = useObserved(useCallback(() => app.isAdmin(), [app]));
  const access = section.admin ? adminAccess(isAdmin) : { kind: 'allow' as const };
  if (access.kind === 'not-found') return <NotFoundPage />;
  if (access.kind === 'wait') {
    return (
      <div className={styles.centered}>
        <Spinner />
      </div>
    );
  }
  const Screen = SCREENS[section.screen];
  // The settings nav lives in the shell's sidebar (shell/SettingsSidebar.tsx); the page is one
  // centred column under its own title (PLAN-016 S7, design-system §3).
  return (
    <>
      <PageHeader crumbs={['Settings', section.title]} title={section.title} heading={false} />
      <div className={styles.settings}>
        <section className={styles.settingsColumn} aria-label={section.title}>
          <header className={styles.settingsHeader}>
            <h1 className={styles.settingsTitle}>{section.title}</h1>
            <p className={styles.settingsDescription}>{section.description}</p>
          </header>
          {Screen === undefined ? (
            <Unavailable title={section.title} />
          ) : (
            <Screen params={params} />
          )}
        </section>
      </div>
    </>
  );
}
