import type { ComponentPropsWithRef, ReactNode } from 'react';
import { Field, type FieldMessages, type FieldNaming } from '../../internal/Field.js';
import control from '../../internal/control.module.css';
import { cx } from '../../internal/cx.js';
import styles from './Input.module.css';

export type InputProps = Omit<
  ComponentPropsWithRef<'input'>,
  'size' | 'prefix' | 'aria-label' | 'aria-labelledby'
> &
  FieldNaming &
  FieldMessages & {
    size?: 'sm' | 'md' | 'lg';
    /** Content before the text, e.g. a search icon. Decorative unless it is focusable. */
    prefix?: ReactNode;
    suffix?: ReactNode;
  };

/** A single-line text field with label, hint and error (design-system §5.1). */
export function Input({
  id,
  label,
  hint,
  error,
  size = 'md',
  prefix,
  suffix,
  className,
  disabled,
  'aria-describedby': describedBy,
  ...props
}: InputProps) {
  return (
    <Field id={id} label={label} hint={hint} error={error} describedBy={describedBy}>
      {(a11y) => (
        <div
          className={cx(control.control, styles.box, styles[size], className)}
          data-invalid={a11y['aria-invalid']}
          data-disabled={disabled || undefined}
        >
          {prefix !== undefined && <span className={styles.slot}>{prefix}</span>}
          <input className={control.native} disabled={disabled} {...a11y} {...props} />
          {suffix !== undefined && <span className={styles.slot}>{suffix}</span>}
        </div>
      )}
    </Field>
  );
}
