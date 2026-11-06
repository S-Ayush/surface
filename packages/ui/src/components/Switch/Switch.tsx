import { Switch as RadixSwitch } from 'radix-ui';
import { useId, type ComponentPropsWithRef } from 'react';
import { cx } from '../../internal/cx.js';
import styles from './Switch.module.css';

export type SwitchProps = Omit<ComponentPropsWithRef<typeof RadixSwitch.Root>, 'children'> &
  ({ label: string; 'aria-label'?: never } | { label?: never; 'aria-label': string });

/** An on/off setting that applies immediately (Radix; Space or Enter toggles). */
export function Switch({ id, label, className, ...props }: SwitchProps) {
  const generated = useId();
  const controlId = id ?? generated;
  return (
    <span className={cx(styles.root, className)}>
      <RadixSwitch.Root id={controlId} className={styles.track} {...props}>
        <RadixSwitch.Thumb className={styles.thumb} />
      </RadixSwitch.Root>
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
