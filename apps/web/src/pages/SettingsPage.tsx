// Settings (SPEC-005 §3, SPEC-001 §7): a section nav beside the PLAN-001 screen for the route.
// Admin-only sections are left out of the nav for Members, and their URLs are not found
// (SPEC-005 §3 guards, permissions.md §5).
import { Spinner } from '@surface/ui';
import { Link } from '@tanstack/react-router';
import { useCallback } from 'react';
import { useApp, useObserved } from '../app/context.js';
import { adminAccess } from '../app/guards.js';
import { settingsNav, type SettingsSection } from '../app/settings.js';
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
  return (
    <>
      <PageHeader crumbs={['Settings', section.title]} title={section.title} />
      <div className={styles.settings}>
        <nav aria-label="Settings" className={styles.settingsNav}>
          <ul>
            {settingsNav(isAdmin).map((item) => (
              <li key={item.nav}>
                <Link to={item.nav}>{item.title}</Link>
              </li>
            ))}
          </ul>
        </nav>
        <section className={styles.settingsBody} aria-label={section.title}>
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
