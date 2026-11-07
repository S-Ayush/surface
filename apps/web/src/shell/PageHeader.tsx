// The sticky page header (SPEC-005 §2 layout): a sidebar button while the sidebar is hidden (the
// drawer below 1024 px, or collapsed with `[`), the breadcrumb, and an actions slot on the right.
import { IconButton } from '@surface/ui';
import { Menu } from 'lucide-react';
import { useCallback, type ReactNode } from 'react';
import { useObserved } from '../app/context.js';
import { useLayoutMode, useShell } from './ShellContext.js';
import { usePageTitle } from './usePageTitle.js';
import styles from './Shell.module.css';

export type PageHeaderProps = {
  /** The breadcrumb, outermost first; the last entry is the page and its title. */
  crumbs: readonly ReactNode[];
  /** The plain-text page title (document title, announced on navigation). */
  title: string;
  actions?: ReactNode;
};

export function PageHeader({ crumbs, title, actions }: PageHeaderProps) {
  const shell = useShell();
  const mode = useLayoutMode();
  const visible = useObserved(useCallback(() => shell.sidebarVisible(mode), [shell, mode]));
  usePageTitle(title);
  return (
    <header className={styles.header}>
      {(mode === 'drawer' || !visible) && (
        <IconButton
          aria-label={mode === 'drawer' ? 'Open sidebar' : 'Show sidebar'}
          aria-expanded={visible}
          aria-controls="sidebar"
          icon={<Menu />}
          onClick={() => {
            shell.toggleSidebar(mode);
          }}
        />
      )}
      <nav aria-label="Breadcrumb" className={styles.crumbs}>
        <ol>
          {crumbs.map((crumb, i) => (
            <li key={i} aria-current={i === crumbs.length - 1 ? 'page' : undefined}>
              {crumb}
            </li>
          ))}
        </ol>
      </nav>
      {actions !== undefined && <div className={styles.actions}>{actions}</div>}
    </header>
  );
}
