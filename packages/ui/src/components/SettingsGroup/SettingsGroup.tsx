import { type ComponentPropsWithRef, type ReactNode } from 'react';
import { cx } from '../../internal/cx.js';
import styles from './SettingsGroup.module.css';

export type SettingsGroupProps = Omit<ComponentPropsWithRef<'section'>, 'title'> & {
  /** The section heading, in the text-label style above the card. */
  title?: string;
  /** Under the heading, above the card: a note or an error (inside the group, not above it). */
  description?: ReactNode;
  /** Right of the heading: a button or a count. */
  actions?: ReactNode;
  /** Render the rows as a list (`<ul>` of `<SettingsRow as="li">`); needs `listLabel`. */
  list?: boolean;
  /** The accessible name of the list, when `list` is set. */
  listLabel?: string;
};

/**
 * design-system §3 Settings: a section heading over an elevated card with `--radius-group` and a
 * hairline ring, holding `SettingsRow`s (or a `SettingsPanel` for a form).
 */
export function SettingsGroup({
  title,
  description,
  actions,
  list = false,
  listLabel,
  children,
  className,
  ...props
}: SettingsGroupProps) {
  const hasHeading = title !== undefined;
  return (
    <section className={cx(styles.root, className)} {...props}>
      {(hasHeading || actions !== undefined) && (
        <div className={styles.head}>
          {hasHeading && <h2 className={styles.title}>{title}</h2>}
          {actions !== undefined && <div className={styles.actions}>{actions}</div>}
        </div>
      )}
      {description !== undefined && <div className={styles.description}>{description}</div>}
      {list ? (
        <ul className={styles.card} aria-label={listLabel}>
          {children}
        </ul>
      ) : (
        <div className={styles.card}>{children}</div>
      )}
    </section>
  );
}

/** A padded block inside a group, for a form or a note that is not a label-and-control row. */
export function SettingsPanel({ className, ...props }: ComponentPropsWithRef<'div'>) {
  return <div className={cx(styles.panel, className)} {...props} />;
}
