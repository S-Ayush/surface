// Team settings → Estimates (SPEC-010 §3.3): a select for the scale and, while a scale is on,
// three switches. Each change saves at once through `team.setEstimates` (optimistic: the control
// follows the replica, so it flips before the server answers); a refusal shows under the
// controls. Turning estimates off keeps the stored values (D21). Readers of a public team see the
// page read-only.
import { teamSetEstimates, type InputOf } from '@surface/operations';
import { Switch } from '@surface/ui';
import { useState } from 'react';
import { useApp } from '../../app/context.js';
import type { ScreenProps } from '../../app/screens.js';
import { submitMutation, useShowsRejection } from '../teams/submit.js';
import { TeamSettingsLayout } from '../teams/TeamSettingsLayout.js';
import type { TeamDetails } from '../teams/useTeams.js';
import styles from './estimates.module.css';
import { SCALE_OPTIONS } from './model.js';
import { useEstimates } from './useEstimates.js';

export function EstimatesScreen({ params }: ScreenProps) {
  return (
    <TeamSettingsLayout teamKey={params['key'] ?? ''}>
      {(details) => <Estimates key={details.team.id} details={details} />}
    </TeamSettingsLayout>
  );
}

type Change = Omit<InputOf<typeof teamSetEstimates>, 'team'>;

function Estimates({ details }: { readonly details: TeamDetails }) {
  const app = useApp();
  const showsRejection = useShowsRejection();
  const { team, access } = details;
  const [error, setError] = useState<string>();
  const settings = useEstimates(team.id);
  const readOnly = !access.edit;

  const save = async (change: Change) => {
    const store = app.store;
    if (store === null) return;
    setError(undefined);
    const result = await submitMutation(
      store,
      teamSetEstimates,
      { team: team.key, ...change },
      { showsRejection },
    );
    if (result.kind === 'rejected' || result.kind === 'failed') setError(result.message);
  };

  if (settings === null) return null;
  const on = settings.scale !== 'off';

  return (
    <div className={styles.form}>
      {readOnly && (
        <p className={styles.note}>
          Only members of {team.key} and Admins can change these settings.
        </p>
      )}
      <label className={styles.field}>
        <span className={styles.fieldLabel}>Issue estimation</span>
        <select
          className={styles.select}
          value={settings.scale}
          disabled={readOnly}
          onChange={(event) => {
            const option = SCALE_OPTIONS.find((o) => o.scale === event.target.value);
            if (option !== undefined) void save({ scale: option.scale });
          }}
        >
          {SCALE_OPTIONS.map((option) => (
            <option key={option.scale} value={option.scale}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {on && (
        <div className={styles.toggles}>
          <Switch
            label="Extended"
            checked={settings.extended}
            disabled={readOnly}
            onCheckedChange={(extended) => void save({ extended })}
          />
          <Switch
            label="Allow zero estimates"
            checked={settings.allowZero}
            disabled={readOnly}
            onCheckedChange={(allowZero) => void save({ allowZero })}
          />
          <Switch
            label="Count unestimated issues as 1 point"
            checked={settings.countUnestimatedAsOne}
            disabled={readOnly}
            onCheckedChange={(countUnestimatedAsOne) => void save({ countUnestimatedAsOne })}
          />
        </div>
      )}
      {!on && (
        <p className={styles.note}>
          Estimates are hidden for {team.key}. Values already set on issues are kept.
        </p>
      )}
      {error !== undefined && (
        <p role="alert" className={styles.formError}>
          {error}
        </p>
      )}
    </div>
  );
}
