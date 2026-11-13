// The inline edit form of a label or group (SPEC-010 §3.2): name, color and, for a label, the group
// it sits in (a live group of the same scope, or none). `Enter` in a field submits it; `Esc` is the
// page's `ui:escape` step. Moving into a group never checks issues (§4.2).
import {
  labelUpdateProblem,
  type ColorHue,
  type LabelFacts,
  type LabelScopeInfo,
} from '@surface/domain';
import { Button, ColorPicker, Input } from '@surface/ui';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { groupChoices, type LabelItem } from './model.js';
import styles from './labels.module.css';

export type LabelFormValues = {
  readonly name: string;
  readonly color: ColorHue;
  /** The group's id, or null for none. */
  readonly groupId: string | null;
};

export type LabelFormProps = {
  readonly label: LabelItem;
  /** Where the label lives, for the words of a name clash. */
  readonly scope: LabelScopeInfo;
  /** Every label of the scope, for the checks and the group choices. */
  readonly scopeLabels: readonly LabelItem[];
  /** Resolves to the refusal to show on the form, or undefined when it worked. */
  readonly onSubmit: (values: LabelFormValues) => Promise<string | undefined>;
  readonly onCancel: () => void;
};

function facts(label: LabelItem): LabelFacts {
  return {
    id: label.id,
    name: label.name,
    teamId: label.teamId,
    parentId: label.parentId,
    isGroup: label.isGroup,
    exclusive: label.exclusive,
    archivedAt: label.archived ? 'archived' : null,
  };
}

export function LabelForm({ label, scope, scopeLabels, onSubmit, onCancel }: LabelFormProps) {
  const [values, setValues] = useState<LabelFormValues>({
    name: label.name,
    color: label.color,
    groupId: label.parentId,
  });
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  const group =
    values.groupId === label.parentId
      ? undefined
      : values.groupId === null
        ? null
        : scopeLabels.find((l) => l.id === values.groupId);
  const check = labelUpdateProblem(scopeLabels.map(facts), scope, facts(label), {
    name: values.name.trim(),
    group: group === undefined ? undefined : group && facts(group),
  });
  const problem = touched && check?.field === 'name' ? check.message : undefined;
  const groupProblem = touched && check?.field === 'group' ? check.message : undefined;

  const edit = (next: Partial<LabelFormValues>) => {
    setError(undefined);
    setValues({ ...values, ...next });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (busy || check !== undefined) return;
    setBusy(true);
    const refusal = await onSubmit({ ...values, name: values.name.trim() });
    setBusy(false);
    if (refusal !== undefined) setError(refusal);
  };

  const choices = groupChoices(scopeLabels, label.parentId).filter((g) => g.id !== label.id);
  return (
    <form
      className={styles.form}
      aria-label={`Edit ${label.name}`}
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      {(error ?? groupProblem) !== undefined && (
        <p role="alert" className={styles.formError}>
          {error ?? groupProblem}
        </p>
      )}
      <div className={styles.formFields}>
        <ColorPicker
          aria-label="Label color"
          value={values.color}
          onValueChange={(color) => edit({ color })}
        />
        <Input
          ref={nameRef}
          label="Name"
          value={values.name}
          error={problem}
          onChange={(event) => edit({ name: event.target.value })}
        />
        {!label.isGroup && (
          <label className={styles.field}>
            <span>Group</span>
            <select
              className={styles.select}
              value={values.groupId ?? ''}
              onChange={(event) => edit({ groupId: event.target.value || null })}
            >
              <option value="">No group</option>
              {choices.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.archived ? `${g.name} (archived)` : g.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className={styles.actions}>
        <Button variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" loading={busy}>
          Save
        </Button>
      </div>
    </form>
  );
}
