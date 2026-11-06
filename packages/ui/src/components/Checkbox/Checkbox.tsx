import { Check, Minus } from 'lucide-react';
import { Checkbox as RadixCheckbox } from 'radix-ui';
import { useId, type ComponentPropsWithRef } from 'react';
import { cx } from '../../internal/cx.js';
import styles from './Checkbox.module.css';

export type CheckboxProps = Omit<ComponentPropsWithRef<typeof RadixCheckbox.Root>, 'children'> &
  ({ label: string; 'aria-label'?: never } | { label?: never; 'aria-label': string });

/** A checkbox with an optional visible label (Radix; Space toggles). Supports "indeterminate". */
export function Checkbox({ id, label, className, ...props }: CheckboxProps) {
  const generated = useId();
  const controlId = id ?? generated;
  return (
    <span className={cx(styles.root, className)}>
      <RadixCheckbox.Root id={controlId} className={styles.box} {...props}>
        <RadixCheckbox.Indicator className={styles.indicator}>
          <Check aria-hidden className={styles.check} />
          <Minus aria-hidden className={styles.minus} />
        </RadixCheckbox.Indicator>
      </RadixCheckbox.Root>
      {label !== undefined && (
        <label
          htmlFor={controlId}
          className={styles.label}
          data-disabled={props.disabled || undefined}
        >
          {label}
        </label>
      )}
    </span>
  );
}
