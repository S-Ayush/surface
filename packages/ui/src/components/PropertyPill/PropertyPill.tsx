import type { ComponentPropsWithRef, ReactNode } from 'react';
import { cx } from '../../internal/cx.js';
import { VisuallyHidden } from '../../visually-hidden.js';
import styles from './PropertyPill.module.css';

type Common = {
  /** The property's name ("Status"): part of the accessible name. */
  property: string;
  /** The value as text ("In Progress"), or null when the property is empty. */
  value: string | null;
  /** The value's icon (StatusIcon, PriorityIcon, Avatar …). */
  icon?: ReactNode;
  /** Shown beside the icon for an empty value, on hover and focus only. Defaults to "Set <property>". */
  placeholder?: string;
  /** Icon only: the text stays in the accessible name (rows with little room). */
  iconOnly?: boolean;
  /** `panel`: the issue page's 28 px round pill with the placeholder always shown (PLAN-016 S6). */
  variant?: 'inline' | 'panel';
};

export type PropertyPillProps = Common &
  (
    | (Omit<ComponentPropsWithRef<'button'>, 'children' | 'aria-label' | 'value'> & {
        readOnly?: false;
      })
    | { readOnly: true; className?: string }
  );

/**
 * A compact value button (design-system §5.3). It opens the property picker; the named button
 * reads "Status: In Progress, change". Read-only pills (archived issues, lists before pickers are
 * bound) are plain text with the property name read first, and show nothing when empty.
 */
export function PropertyPill({
  property,
  value,
  icon,
  placeholder,
  iconOnly = false,
  variant = 'inline',
  className,
  ...rest
}: PropertyPillProps) {
  const text = value ?? placeholder ?? `Set ${property.toLowerCase()}`;
  const visual = (
    <span aria-hidden="true" className={styles.content}>
      {icon !== undefined && <span className={styles.icon}>{icon}</span>}
      {!iconOnly && (
        <span className={cx(styles.text, value === null && styles.placeholder)}>{text}</span>
      )}
    </span>
  );

  if ('readOnly' in rest && rest.readOnly) {
    return (
      <span
        className={cx(styles.root, styles.readOnly, variant === 'panel' && styles.panel, className)}
      >
        <VisuallyHidden>{`${property}: ${value ?? 'none'}`}</VisuallyHidden>
        {value === null ? null : visual}
      </span>
    );
  }

  const { readOnly: _readOnly, ...buttonProps } = rest as Omit<
    ComponentPropsWithRef<'button'>,
    'children' | 'aria-label'
  > & { readOnly?: false };
  return (
    <button
      type="button"
      className={cx(
        styles.root,
        value === null && styles.empty,
        variant === 'panel' && styles.panel,
        className,
      )}
      {...buttonProps}
    >
      {/* The name is hidden text, not aria-label: the visible part (an avatar's initials, a label) is
          decorative, and axe's label-in-name rule only checks aria-label. */}
      <VisuallyHidden>{`${property}: ${value ?? 'none'}, change`}</VisuallyHidden>
      {visual}
    </button>
  );
}
