import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from '../../internal/cx.js';
import styles from './IconButton.module.css';

export type IconButtonProps = Omit<ComponentPropsWithRef<'button'>, 'children' | 'aria-label'> & {
  /** Required: an icon-only button has no visible text (design-system §5.1). */
  'aria-label': string;
  icon: ReactNode;
  variant?: 'ghost' | 'secondary';
  size?: 'sm' | 'md' | 'lg';
};

/** A square, icon-only button. Pair it with a <Tooltip> that names it and shows its shortcut. */
export function IconButton({
  icon,
  variant = 'ghost',
  size = 'md',
  type = 'button',
  className,
  ...props
}: IconButtonProps) {
  return (
    <button
      type={type}
      className={cx(styles.root, styles[variant], styles[size], className)}
      {...props}
    >
      <span aria-hidden="true" className={styles.icon}>
        {icon}
      </span>
    </button>
  );
}
