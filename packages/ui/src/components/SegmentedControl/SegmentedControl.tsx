import { RadioGroup } from 'radix-ui';
import type { ReactNode } from 'react';
import { cx } from '../../internal/cx.js';
import styles from './SegmentedControl.module.css';

export type SegmentedOption<V extends string> = {
  value: V;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
};

export type SegmentedControlProps<V extends string> = {
  /** 2–5 options (design-system §5.1), e.g. List / Board. */
  options: readonly SegmentedOption<V>[];
  value: V;
  onValueChange: (value: V) => void;
  /** Names the group, e.g. "Layout". */
  'aria-label': string;
  size?: 'sm' | 'md';
  className?: string;
};

/** One choice from a few options. A radio group: arrow keys move and select (Radix). */
export function SegmentedControl<V extends string>({
  options,
  value,
  onValueChange,
  size = 'md',
  className,
  'aria-label': ariaLabel,
}: SegmentedControlProps<V>) {
  const select = (next: string) => {
    const option = options.find((o) => o.value === next);
    if (option) onValueChange(option.value);
  };
  return (
    <RadioGroup.Root
      className={cx(styles.root, styles[size], className)}
      value={value}
      onValueChange={select}
      orientation="horizontal"
      loop
      aria-label={ariaLabel}
    >
      {options.map((option) => (
        <RadioGroup.Item
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          className={styles.item}
        >
          {option.icon !== undefined && (
            <span className={styles.icon} aria-hidden="true">
              {option.icon}
            </span>
          )}
          {option.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
