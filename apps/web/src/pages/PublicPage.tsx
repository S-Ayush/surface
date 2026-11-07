// The public pages (SPEC-005 §3, SPEC-001 §7), rendered without the shell. Session E's screens
// plug in through features/screens.ts; until one is registered the route shows a placeholder.
import { EmptyState } from '@surface/ui';
import { Construction } from 'lucide-react';
import type { ScreenId } from '../app/screens.js';
import { SCREENS } from '../features/screens.js';
import { usePageTitle } from '../shell/usePageTitle.js';
import styles from './Pages.module.css';

export function PublicPage({
  screen,
  title,
  params = {},
}: {
  screen: ScreenId;
  title: string;
  params?: Readonly<Record<string, string>>;
}) {
  usePageTitle(title);
  const Screen = SCREENS[screen];
  return (
    <main className={styles.public} tabIndex={-1}>
      {Screen === undefined ? <Unavailable title={title} /> : <Screen params={params} />}
    </main>
  );
}

/** A screen this build doesn't include yet (PLAN-001 builds them). */
export function Unavailable({ title }: { title: string }) {
  return (
    <EmptyState
      icon={<Construction />}
      title={`${title} isn't available yet`}
      description="This screen is still being built."
    />
  );
}
