import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';
import { cx } from '../../internal/cx.js';
import styles from './GroupHeader.module.css';

export type GroupHeaderProps = {
  /** The group's name ("In Progress"). */
  name: string;
  count: number;
  /** StatusIcon (or another group icon). */
  icon?: ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  /** Shows the `+` button; absent where the group can't take a new issue. */
  onAdd?: () => void;
  /** 1-based position in the grid: `aria-rowindex`. */
  rowIndex: number;
  /** Roving tabindex from VirtualList. */
  tabIndex?: 0 | -1;
  focused?: boolean;
  /** Draw the keyboard-focus treatment for a focused header (the list turns it off until the first key press). Default true. */
  showFocus?: boolean;
  style?: CSSProperties;
  className?: string;
};

const plural = (count: number) => `${count} ${count === 1 ? 'issue' : 'issues'}`;

/**
 * A group's header row (design-system §5.3): icon, name, count, collapse (click, or `T` from the
 * list's keys) and add. It is a grid row named like "In Progress, 12 issues, collapsed" (SPEC-012 §7.4).
 */
export function GroupHeader({
  name,
  count,
  icon,
  collapsed,
  onToggle,
  onAdd,
  rowIndex,
  tabIndex = -1,
  focused = false,
  showFocus = true,
  style,
  className,
}: GroupHeaderProps) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <div
      role="row"
      aria-rowindex={rowIndex}
      aria-level={1}
      aria-expanded={!collapsed}
      aria-label={`${name}, ${plural(count)}, ${collapsed ? 'collapsed' : 'expanded'}`}
      tabIndex={tabIndex}
      data-focused={focused || undefined}
      data-focus-visible={(focused && showFocus) || undefined}
      className={cx(styles.root, className)}
      style={style}
      onClick={onToggle}
    >
      <div role="gridcell" className={styles.cell}>
        <Chevron aria-hidden="true" className={styles.chevron} />
        {icon !== undefined && <span className={styles.icon}>{icon}</span>}
        <span className={styles.name}>{name}</span>
        <span className={styles.count}>{count}</span>
        {onAdd && (
          <button
            type="button"
            className={styles.add}
            tabIndex={-1}
            aria-label={`Add issue to ${name}`}
            onClick={(event) => {
              event.stopPropagation();
              onAdd();
            }}
          >
            <Plus aria-hidden="true" />
          </button>
        )}
      </div>
    </div>
  );
}
