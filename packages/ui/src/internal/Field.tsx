// Shared label / hint / error wiring for text fields (design-system §5.1 Input): the label is a real
// <label for>, and the hint and error are linked with aria-describedby.
import { useId, type ReactNode } from 'react';
import styles from './Field.module.css';

/** A field is named by a visible label, or by aria-label / aria-labelledby when there is none. */
export type FieldNaming =
  | { label: string; 'aria-label'?: never; 'aria-labelledby'?: never }
  | { label?: never; 'aria-label': string; 'aria-labelledby'?: never }
  | { label?: never; 'aria-label'?: never; 'aria-labelledby': string };

export type FieldMessages = {
  /** Help text under the field. */
  hint?: string;
  /** Error text: marks the control invalid and replaces the hint. Say how to fix it. */
  error?: string;
};

type ControlA11y = {
  id: string;
  'aria-describedby': string | undefined;
  'aria-invalid': true | undefined;
};

export function Field({
  id: givenId,
  label,
  hint,
  error,
  describedBy,
  children,
}: FieldMessages & {
  id: string | undefined;
  label: string | undefined;
  describedBy: string | undefined;
  children: (a11y: ControlA11y) => ReactNode;
}) {
  const generated = useId();
  const id = givenId ?? generated;
  const messageId = `${id}-message`;
  const message = error ?? hint;
  const describedByIds = [describedBy, message !== undefined ? messageId : undefined]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={styles.field}>
      {label !== undefined && (
        <label className={styles.label} htmlFor={id}>
          {label}
        </label>
      )}
      {children({
        id,
        'aria-describedby': describedByIds || undefined,
        'aria-invalid': error !== undefined || undefined,
      })}
      {message !== undefined && (
        <p id={messageId} className={error !== undefined ? styles.error : styles.hint}>
          {message}
        </p>
      )}
    </div>
  );
}
