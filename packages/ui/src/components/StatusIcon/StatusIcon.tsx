import type { StatusCategory } from '@surface/domain';
import { cx } from '../../internal/cx.js';
import type { LabelHue } from '../../tokens.gen.js';
import styles from './StatusIcon.module.css';

export type StatusIconProps = {
  category: StatusCategory;
  /** The status's palette hue. */
  color?: LabelHue;
  /** Names the icon for screen readers ("In Progress"). Without it the icon is decorative. */
  label?: string;
  className?: string;
};

/** One glyph per category, in the status's colour (design-system §5.1). Shape, not colour alone, tells them apart. */
function Glyph({ category }: { category: StatusCategory }) {
  switch (category) {
    case 'backlog':
      return <circle cx="8" cy="8" r="6" fill="none" strokeWidth="1.5" strokeDasharray="2 2" />;
    case 'unstarted':
      return <circle cx="8" cy="8" r="6" fill="none" strokeWidth="1.5" />;
    case 'started':
      return (
        <>
          <circle cx="8" cy="8" r="6" fill="none" strokeWidth="1.5" />
          <path d="M8 4.5a3.5 3.5 0 0 1 0 7z" className={styles.fill} stroke="none" />
        </>
      );
    case 'completed':
      return (
        <>
          <circle cx="8" cy="8" r="7" className={styles.fill} stroke="none" />
          <path d="M5 8.2 7.1 10.3 11 6" className={styles.mark} />
        </>
      );
    case 'canceled':
      return (
        <>
          <circle cx="8" cy="8" r="7" className={styles.fill} stroke="none" />
          <path d="M5.8 5.8 10.2 10.2M10.2 5.8 5.8 10.2" className={styles.mark} />
        </>
      );
    case 'duplicate':
      return (
        <>
          <circle cx="8" cy="8" r="7" className={styles.fill} stroke="none" />
          <path d="M5.5 6.5h5M5.5 9.5h5" className={styles.mark} />
        </>
      );
    case 'triage':
      return (
        <>
          <circle cx="8" cy="8" r="6" fill="none" strokeWidth="1.5" />
          <path d="M5.5 7 8 9.5 10.5 7" fill="none" strokeWidth="1.5" />
        </>
      );
  }
}

export function StatusIcon({ category, color = 'gray', label, className }: StatusIconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={cx(styles.root, className)}
      style={{ color: `var(--label-${color})` }}
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
      focusable="false"
    >
      <g className={styles.stroke} strokeLinecap="round" strokeLinejoin="round">
        <Glyph category={category} />
      </g>
    </svg>
  );
}
