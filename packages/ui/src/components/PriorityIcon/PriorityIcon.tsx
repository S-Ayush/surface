import { priorityLabel, type Priority } from '@surface/domain';
import { cx } from '../../internal/cx.js';
import styles from './PriorityIcon.module.css';

export type PriorityIconProps = {
  priority: Priority;
  /** Names the icon for screen readers. Pass `true` for the priority's own name ("Urgent"). */
  label?: string | true;
  className?: string;
};

/** Bars filled for High, Medium, Low (3, 2, 1), dashes for No priority, a badge for Urgent. */
export function PriorityIcon({ priority, label, className }: PriorityIconProps) {
  const name = label === true ? priorityLabel(priority) : label;
  const filled = priority >= 2 ? 5 - priority : 0;
  return (
    <svg
      viewBox="0 0 16 16"
      className={cx(styles.root, className)}
      role={name === undefined ? undefined : 'img'}
      aria-label={name}
      aria-hidden={name === undefined ? true : undefined}
      focusable="false"
    >
      {priority === 1 ? (
        <>
          <rect x="1.5" y="1.5" width="13" height="13" rx="3" className={styles.urgent} />
          <path d="M8 4.5v4.2M8 11v.5" className={styles.bang} />
        </>
      ) : priority === 0 ? (
        <path d="M2.5 8h2.5M6.75 8h2.5M11 8h2.5" className={styles.none} />
      ) : (
        [0, 1, 2].map((i) => (
          <rect
            key={i}
            x={2.5 + i * 4.25}
            y={10 - i * 3}
            width="2.5"
            height={3.5 + i * 3}
            rx="0.75"
            className={i < filled ? styles.on : styles.off}
          />
        ))
      )}
    </svg>
  );
}
