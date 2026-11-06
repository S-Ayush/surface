import type { ComponentPropsWithRef } from 'react';
import { cx } from '../../internal/cx.js';
import styles from './Spinner.module.css';

export type SpinnerProps = ComponentPropsWithRef<'span'> & {
  size?: 'sm' | 'md' | 'lg';
  /** Announced by screen readers. Pass null when a parent already says it is busy (aria-busy). */
  label?: string | null;
};

/** Indeterminate progress for network work only; local actions never spin (design-system §1). */
export function Spinner({ size = 'md', label = 'Loading', className, ...props }: SpinnerProps) {
  const a11y = label === null ? { 'aria-hidden': true } : { role: 'status', 'aria-label': label };
  return <span className={cx(styles.root, styles[size], className)} {...a11y} {...props} />;
}
