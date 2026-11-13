// The inline "New label" and "New group" row (SPEC-010 §3.2): a color, the name, a description,
// Cancel and Create. In the label row, `Group/Label` or `Group:Label` makes the group when it does
// not exist (AC-25). The text is checked with the server's rules before anything is sent
// (`planNewLabel`). `Enter` in a field submits (a plain form submit); `Esc` is the page's
// `ui:escape` step, not a key handler here.
import { Button, ColorPicker, Input } from '@surface/ui';
import type { ColorHue } from '@surface/domain';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { NewLabelPlan } from './model.js';
import styles from './labels.module.css';

export type NewLabelValues = {
  readonly text: string;
  readonly color: ColorHue;
  readonly description: string;
};

export type NewLabelRowProps = {
  readonly kind: 'label' | 'group';
  /** Text to start with, e.g. `Size/` from "Add label to group". */
  readonly initialText?: string;
  /** What the text makes, or why it can't. */
  readonly plan: (text: string) => NewLabelPlan;
  /** Resolves to the refusal to show on the row, or undefined when it worked. */
  readonly onSubmit: (values: NewLabelValues, plan: NewLabelPlan) => Promise<string | undefined>;
  readonly onCancel: () => void;
};

export function NewLabelRow({
  kind,
  initialText = '',
  plan,
  onSubmit,
  onCancel,
}: NewLabelRowProps) {
  const [values, setValues] = useState<NewLabelValues>({
    text: initialText,
    color: 'gray',
    description: '',
  });
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const current = plan(values.text);
  const problem = touched && !current.ok ? current.problem : undefined;
  const noun = kind === 'group' ? 'group' : 'label';

  // The name field has focus when the row opens (§3.2, §7.3), the cursor after any starting text.
  useEffect(() => {
    const input = nameRef.current;
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }, []);

  const edit = (next: Partial<NewLabelValues>) => {
    setError(undefined);
    setValues({ ...values, ...next });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (busy || !current.ok) return;
    setBusy(true);
    const refusal = await onSubmit(values, current);
    setBusy(false);
    if (refusal !== undefined) setError(refusal);
  };

  return (
    <form
      className={styles.form}
      aria-label={`New ${noun}`}
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      {(error ?? problem) !== undefined && (
        <p role="alert" className={styles.formError}>
          {error ?? problem}
        </p>
      )}
      <div className={styles.formFields}>
        <ColorPicker
          aria-label={`${kind === 'group' ? 'Group' : 'Label'} color`}
          value={values.color}
          onValueChange={(color) => edit({ color })}
        />
        <Input
          ref={nameRef}
          aria-label={kind === 'group' ? 'Group name' : 'Label name'}
          placeholder={kind === 'group' ? 'Group name' : 'Label name'}
          value={values.text}
          onChange={(event) => edit({ text: event.target.value })}
        />
        <Input
          aria-label="Description"
          placeholder="Add description…"
          value={values.description}
          onChange={(event) => edit({ description: event.target.value })}
        />
      </div>
      <div className={styles.actions}>
        <Button variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={busy}>
          {`Create ${noun}`}
        </Button>
      </div>
    </form>
  );
}
