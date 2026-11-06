import type { ComponentPropsWithRef } from 'react';
import { cx } from '../../internal/cx.js';
import styles from './Badge.module.css';

export type BadgeProps = ComponentPropsWithRef<'span'> & {
  variant?: 'neutral' | 'accent';
  /** A count; above `max` it shows "99+". Without it, children are the content. */
  count?: number;
  max?: number;
};

/** Sidebar and tab counts (design-system §5.1). Counts use tabular numbers. */
export function Badge({
  variant = 'neutral',
  count,
  max = 99,
  className,
  children,
  ...props
}: BadgeProps) {
  const content = count === undefined ? children : count > max ? `${max}+` : String(count);
  return (
    <span className={cx(styles.root, styles[variant], className)} {...props}>
      {content}
    </span>
  );
}
