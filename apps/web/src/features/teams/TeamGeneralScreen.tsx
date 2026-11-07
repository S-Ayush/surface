// Team settings → General (SPEC-001 §3.7): name, icon, color and time zone; the key is shown
// read-only. Members of the team and Admins may change them (`team.update`); everyone else sees
// them read-only. Changes show at once (optimistic) and in other clients as their delta lands.
import { teamUpdate } from '@surface/operations';
import { Button, ColorPicker, Input } from '@surface/ui';
import { useState, type FormEvent } from 'react';
import { useApp } from '../../app/context.js';
import type { ScreenProps } from '../../app/screens.js';
import { submitMutation } from './submit.js';
import {
  teamSettingsChanges,
  teamSettingsForm,
  teamSettingsProblems,
  withEdits,
  type TeamSettingsEdits,
  type TeamSettingsForm,
} from './team-settings.js';
import { TeamSettingsLayout } from './TeamSettingsLayout.js';
import styles from './teams.module.css';
import type { TeamDetails } from './useTeams.js';

export function TeamGeneralScreen({ params }: ScreenProps) {
  return (
    <TeamSettingsLayout teamKey={params['key'] ?? ''}>
      {(details) => <GeneralForm key={details.team.id} details={details} />}
    </TeamSettingsLayout>
  );
}

function GeneralForm({ details }: { readonly details: TeamDetails }) {
  const app = useApp();
  const { team, access } = details;
  const saved = teamSettingsForm(team);
  // Only what the user edited: every other field follows the saved team as its deltas land.
  const [edits, setEdits] = useState<TeamSettingsEdits>({});
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const form = withEdits(saved, edits);
  const problems = touched ? teamSettingsProblems(form) : {};
  const changes = teamSettingsChanges(team.key, saved, edits);
  const readOnly = !access.edit;
  const edit = (next: Partial<TeamSettingsForm>) => {
    setError(undefined);
    setEdits({ ...edits, ...next });
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    const store = app.store;
    if (store === null || busy || changes === undefined) return;
    if (Object.keys(teamSettingsProblems(form)).length > 0) return;
    setBusy(true);
    const result = await submitMutation(store, teamUpdate, changes);
    setBusy(false);
    if (result.kind === 'rejected' || result.kind === 'failed') setError(result.message);
    else setEdits({});
  };

  return (
    <form className={styles.form} onSubmit={(event) => void save(event)} noValidate>
      {readOnly && (
        <p className={styles.note}>
          Only members of {team.key} and Admins can change these settings.
        </p>
      )}
      {error !== undefined && (
        <p role="alert" className={styles.formError}>
          {error}
        </p>
      )}
      <Input
        label="Name"
        value={form.name}
        readOnly={readOnly}
        error={problems.name}
        onChange={(event) => edit({ name: event.target.value })}
      />
      <Input
        label="Key"
        value={team.key}
        readOnly
        hint="The key prefixes issue ids, like ENG-123. It can't be changed."
      />
      <Input
        label="Icon"
        value={form.icon}
        placeholder="An emoji, optional"
        readOnly={readOnly}
        error={problems.icon}
        onChange={(event) => edit({ icon: event.target.value })}
      />
      <div className={styles.field}>
        <span className={styles.fieldLabel} aria-hidden="true">
          Color
        </span>
        {readOnly ? (
          // Not a picker: a read-only radio group would still take arrow keys (design-system §5.4).
          <span className={styles.colorValue}>
            <span
              className={styles.swatch}
              style={{ backgroundColor: `var(--label-${form.color})` }}
              aria-hidden="true"
            />
            {form.color}
          </span>
        ) : (
          <ColorPicker
            aria-label="Team color"
            value={form.color}
            onValueChange={(color) => edit({ color })}
          />
        )}
      </div>
      <Input
        label="Time zone"
        value={form.timezone}
        placeholder="Europe/Berlin"
        readOnly={readOnly}
        error={problems.timezone}
        onChange={(event) => edit({ timezone: event.target.value })}
      />
      {!readOnly && (
        <div className={styles.actions}>
          <Button
            variant="ghost"
            type="button"
            disabled={Object.keys(edits).length === 0}
            onClick={() => {
              setEdits({});
              setTouched(false);
              setError(undefined);
            }}
          >
            Discard
          </Button>
          <Button type="submit" loading={busy} disabled={changes === undefined}>
            Save changes
          </Button>
        </div>
      )}
    </form>
  );
}
