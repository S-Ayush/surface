import { Progress } from 'radix-ui';
import type { ComponentPropsWithRef } from 'react';
import { cx } from '../../internal/cx.js';
import styles from './ProgressBar.module.css';

export type ProgressBarProps = Omit<ComponentPropsWithRef<typeof Progress.Root>, 'children'> & {
  /** Names the task, e.g. "Syncing workspace". */
  'aria-label': string;
  /** Omit (or null) for indeterminate progress. */
  value?: number | null;
  max?: number;
};

/** role="progressbar" with aria-valuenow/max (Radix). Used by the bootstrap progress (SPEC-005 §3). */
export function ProgressBar({ value = null, max = 100, className, ...props }: ProgressBarProps) {
  const clamped = value === null ? null : Math.min(Math.max(value, 0), max);
  return (
    <Progress.Root className={cx(styles.root, className)} value={clamped} max={max} {...props}>
      <Progress.Indicator
        className={styles.indicator}
        style={
          clamped === null
            ? undefined
            : { transform: `translateX(-${100 - (clamped / max) * 100}%)` }
        }
      />
    </Progress.Root>
  );
}
