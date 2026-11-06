import type { ComponentPropsWithRef, MouseEvent, ReactNode } from 'react';
import { cx } from '../../internal/cx.js';
import { ariaKeyShortcuts } from '../../keys.js';
import { usePlatform } from '../../platform.js';
import { Kbd } from '../Kbd/Kbd.js';
import { Spinner } from '../Spinner/Spinner.js';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export type ButtonProps = ComponentPropsWithRef<'button'> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** A leading icon (Lucide, 16 px). */
  icon?: ReactNode;
  /** Shortcut hint rendered as <Kbd> after the label, e.g. "Mod+Enter". */
  shortcut?: string | readonly string[];
  /** Network actions only. Keeps focus and announces busy; clicks are ignored meanwhile. */
  loading?: boolean;
};

/** design-system §5.1. Labels are verbs in sentence case ("Create issue"). */
export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  shortcut,
  loading = false,
  type = 'button',
  className,
  children,
  onClick,
  ...props
}: ButtonProps) {
  const platform = usePlatform();
  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (loading) {
      event.preventDefault();
      return;
    }
    onClick?.(event);
  };
  return (
    <button
      type={type}
      className={cx(styles.root, styles[variant], styles[size], className)}
      aria-busy={loading || undefined}
      // The hint is visual only; the shortcut is exposed as aria-keyshortcuts, so the accessible
      // name stays the label ("Create issue", not "Create issue Command Enter").
      aria-keyshortcuts={shortcut === undefined ? undefined : ariaKeyShortcuts(shortcut, platform)}
      onClick={handleClick}
      {...props}
    >
      {loading ? (
        <Spinner size="sm" label={null} />
      ) : (
        icon && <span className={styles.icon}>{icon}</span>
      )}
      {children !== undefined && <span className={styles.label}>{children}</span>}
      {shortcut !== undefined && <Kbd keys={shortcut} className={styles.kbd} aria-hidden="true" />}
    </button>
  );
}
