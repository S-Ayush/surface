import type { ComponentPropsWithRef } from 'react';
import { Field, type FieldMessages, type FieldNaming } from '../../internal/Field.js';
import control from '../../internal/control.module.css';
import { cx } from '../../internal/cx.js';
import styles from './Textarea.module.css';

export type TextareaProps = Omit<
  ComponentPropsWithRef<'textarea'>,
  'aria-label' | 'aria-labelledby'
> &
  FieldNaming &
  FieldMessages;

/** A multi-line text field with label, hint and error (design-system §5.1). */
export function Textarea({
  id,
  label,
  hint,
  error,
  className,
  disabled,
  rows = 3,
  'aria-describedby': describedBy,
  ...props
}: TextareaProps) {
  return (
    <Field id={id} label={label} hint={hint} error={error} describedBy={describedBy}>
      {(a11y) => (
        <div
          className={cx(control.control, styles.box, className)}
          data-invalid={a11y['aria-invalid']}
          data-disabled={disabled || undefined}
        >
          <textarea
            className={cx(control.native, styles.textarea)}
            disabled={disabled}
            rows={rows}
            {...a11y}
            {...props}
          />
        </div>
      )}
    </Field>
  );
}
