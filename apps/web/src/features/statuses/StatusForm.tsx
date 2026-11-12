// The inline add and edit form of the workflow page (SPEC-010 §3.1): color, name (required),
// description, Cancel and Create or Save. `Enter` in a field submits it (a plain form submit);
// `Esc` is the page's `ui:escape` step, not a key handler here. The category cannot change (D18).
import { STATUS_CATEGORY_COLORS, type StatusCategory } from '@surface/domain';
import { Button, ColorPicker, Input } from '@surface/ui';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { statusFormProblems, type StatusFormValues, type StatusItem } from './model.js';
import styles from './statuses.module.css';

export type StatusFormProps = {
  readonly category: StatusCategory;
  /** The status being edited; absent when adding. */
  readonly status?: StatusItem;
  readonly others: readonly StatusItem[];
  readonly count: number;
  /** Resolves to the refusal to show on the form, or undefined when it worked. */
  readonly onSubmit: (values: StatusFormValues) => Promise<string | undefined>;
  readonly onCancel: () => void;
};

export function StatusForm({
  category,
  status,
  others,
  count,
  onSubmit,
  onCancel,
}: StatusFormProps) {
  const adding = status === undefined;
  const [values, setValues] = useState<StatusFormValues>({
    name: status?.name ?? '',
    color: status?.color ?? STATUS_CATEGORY_COLORS[category],
    description: status?.description ?? '',
  });
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const problems = touched ? statusFormProblems(values, others, { adding, count }) : {};

  // The name field has focus when the form opens (§3.1, §7.3).
  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  const edit = (next: Partial<StatusFormValues>) => {
    setError(undefined);
    setValues({ ...values, ...next });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (busy || Object.keys(statusFormProblems(values, others, { adding, count })).length > 0) {
      return;
    }
    setBusy(true);
    const refusal = await onSubmit({ ...values, name: values.name.trim() });
    setBusy(false);
    if (refusal !== undefined) setError(refusal);
  };

  const title = adding ? 'New status' : `Edit ${status.name}`;
  return (
    <form
      className={styles.form}
      aria-label={title}
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      {error !== undefined && (
        <p role="alert" className={styles.formError}>
          {error}
        </p>
      )}
      <div className={styles.formFields}>
        <ColorPicker
          aria-label="Status color"
          value={values.color}
          onValueChange={(color) => edit({ color })}
        />
        <Input
          ref={nameRef}
          label="Name"
          value={values.name}
          error={problems.name}
          onChange={(event) => edit({ name: event.target.value })}
        />
        <Input
          label="Description"
          value={values.description}
          placeholder="Optional"
          error={problems.description}
          onChange={(event) => edit({ description: event.target.value })}
        />
      </div>
      <div className={styles.actions}>
        <Button variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={busy}>
          {adding ? 'Create' : 'Save'}
        </Button>
      </div>
    </form>
  );
}
