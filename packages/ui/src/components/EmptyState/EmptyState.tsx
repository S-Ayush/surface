import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from '../../internal/cx.js';
import styles from './EmptyState.module.css';

export type EmptyStateProps = Omit<ComponentPropsWithRef<'div'>, 'title'> & {
  /** A Lucide icon (rendered at 20 px, decorative). */
  icon: ReactNode;
  /** One sentence, e.g. "No issues yet". */
  title: string;
  /** Optional second line of help. */
  description?: string;
  /** The primary action, usually a <Button> with its shortcut. */
  action?: ReactNode;
};

/** design-system §4 "Empty states": an icon, one sentence, a primary action and its shortcut. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div className={cx(styles.root, className)} {...props}>
      <span className={styles.icon} aria-hidden="true">
        {icon}
      </span>
      <p className={styles.title}>{title}</p>
      {description !== undefined && <p className={styles.description}>{description}</p>}
      {action !== undefined && <div className={styles.action}>{action}</div>}
    </div>
  );
}
