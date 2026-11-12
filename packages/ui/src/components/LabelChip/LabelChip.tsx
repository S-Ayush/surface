import { X } from 'lucide-react';
import { cx } from '../../internal/cx.js';
import type { LabelHue } from '../../tokens.gen.js';
import styles from './LabelChip.module.css';

export type LabelChipProps = {
  name: string;
  color: LabelHue;
  /** Edit mode: shows a remove button. */
  onRemove?: () => void;
  className?: string;
};

/** A colour dot and a name; the name carries the meaning, the dot only the hue (design-system §5.3). */
export function LabelChip({ name, color, onRemove, className }: LabelChipProps) {
  return (
    <span className={cx(styles.root, className)}>
      <span className={styles.dot} style={{ color: `var(--label-${color})` }} aria-hidden="true" />
      <span className={styles.name}>{name}</span>
      {onRemove && (
        <button
          type="button"
          className={styles.remove}
          aria-label={`Remove label ${name}`}
          onClick={onRemove}
        >
          <X aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
