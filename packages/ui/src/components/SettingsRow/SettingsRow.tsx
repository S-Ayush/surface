import { useId, type HTMLAttributes, type ReactNode } from 'react';
import { cx } from '../../internal/cx.js';
import styles from './SettingsRow.module.css';

export type SettingsRowProps = Omit<HTMLAttributes<HTMLElement>, 'title'> & {
  /** `li` inside a `SettingsGroup list`. */
  as?: 'div' | 'li';
  /** The setting's name (13 / 500). */
  label: ReactNode;
  /** One line of help under the label (12 / 450). */
  hint?: ReactNode;
  /** Before the text: an avatar, a swatch or a status icon. */
  leading?: ReactNode;
  /**
   * The id of the control the label names: the label becomes a `<label for>`. Without it the row
   * is a group named by its label, and its hint is the group's description.
   */
  controlId?: string;
  /** The control, aligned right; below the text when `stacked`. */
  children?: ReactNode;
  /** Put the control under the text instead of beside it (a wide input). */
  stacked?: boolean;
};

/**
 * design-system §3 Settings: a label and hint on the left, the control on the right, at least
 * `--settings-row-min-height` tall, a hairline between rows. `id` is the row's anchor.
 */
export function SettingsRow({
  as = 'div',
  label,
  hint,
  leading,
  controlId,
  children,
  stacked = false,
  className,
  ...props
}: SettingsRowProps) {
  const ids = useId();
  const labelId = `${ids}-label`;
  const hintId = `${ids}-hint`;
  const Root = as;
  const named = controlId === undefined;
  return (
    <Root
      className={cx(styles.root, stacked && styles.stacked, className)}
      role={named && as === 'div' ? 'group' : undefined}
      aria-labelledby={named ? labelId : undefined}
      aria-describedby={named && hint !== undefined ? hintId : undefined}
      {...props}
    >
      {leading !== undefined && <span className={styles.leading}>{leading}</span>}
      <div className={styles.text}>
        {named ? (
          <span id={labelId} className={styles.label}>
            {label}
          </span>
        ) : (
          <label htmlFor={controlId} className={styles.label}>
            {label}
          </label>
        )}
        {hint !== undefined && (
          <span id={hintId} className={styles.hint}>
            {hint}
          </span>
        )}
      </div>
      {children !== undefined && <div className={styles.control}>{children}</div>}
    </Root>
  );
}
