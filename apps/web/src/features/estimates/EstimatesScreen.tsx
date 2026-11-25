// Team settings → Estimates (SPEC-010 §3.3): a select for the scale and, while a scale is on,
// three switches. Each change saves at once through `team.setEstimates` (optimistic: the control
// follows the replica, so it flips before the server answers); a refusal shows under the
// controls. Turning estimates off keeps the stored values (D21). Readers of a public team see the
// page read-only.
import { teamSetEstimates, type InputOf } from '@surface/operations';
import { SettingsGroup, SettingsRow, Switch, settingsHintId } from '@surface/ui';
import { useId } from 'react';
import { useApp } from '../../app/context.js';
import type { ScreenProps } from '../../app/screens.js';
import { submitMutation, toastIfFailed } from '../teams/submit.js';
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
  const { team, access } = details;
  const settings = useEstimates(team.id);
  const readOnly = !access.edit;
  const scaleId = useId();
  const extendedId = useId();
  const zeroId = useId();
  const countId = useId();

  const save = async (change: Change) => {
    const store = app.store;
    if (store === null) return;
    // SPEC-010 §7.4: a rejected change rolls back and is a toast. The shell toasts a server
    // refusal itself (no `showsRejection`); `toastIfFailed` covers a change the store didn't take.
    toastIfFailed(await submitMutation(store, teamSetEstimates, { team: team.key, ...change }));
  };

  if (settings === null) return null;
  const on = settings.scale !== 'off';

  return (
    <>
      {readOnly && (
        <p className={styles.note}>
          Only members of {team.key} and Admins can change these settings.
        </p>
      )}
      <SettingsGroup title="Estimation">
        <SettingsRow
          id="setting-estimation"
          label="Issue estimation"
          hint="The scale used to size issues."
          controlId={scaleId}
        >
          <select
            id={scaleId}
            aria-describedby={settingsHintId(scaleId)}
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
        </SettingsRow>
        {on && (
          <>
            <SettingsRow
              id="setting-extended"
              controlId={extendedId}
              label="Extended"
              hint="Adds larger values to the scale."
            >
              <Switch
                id={extendedId}
                aria-describedby={settingsHintId(extendedId)}
                aria-label="Extended"
                checked={settings.extended}
                disabled={readOnly}
                onCheckedChange={(extended) => void save({ extended })}
              />
            </SettingsRow>
            <SettingsRow
              id="setting-allow-zero"
              controlId={zeroId}
              label="Allow zero estimates"
              hint="Lets an issue be sized at 0."
            >
              <Switch
                id={zeroId}
                aria-describedby={settingsHintId(zeroId)}
                aria-label="Allow zero estimates"
                checked={settings.allowZero}
                disabled={readOnly}
                onCheckedChange={(allowZero) => void save({ allowZero })}
              />
            </SettingsRow>
            <SettingsRow
              id="setting-count-unestimated"
              controlId={countId}
              label="Count unestimated issues as 1 point"
              hint="Totals include issues with no estimate."
            >
              <Switch
                id={countId}
                aria-describedby={settingsHintId(countId)}
                aria-label="Count unestimated issues as 1 point"
                checked={settings.countUnestimatedAsOne}
                disabled={readOnly}
                onCheckedChange={(countUnestimatedAsOne) => void save({ countUnestimatedAsOne })}
              />
            </SettingsRow>
          </>
        )}
      </SettingsGroup>
      {!on && (
        <p className={styles.note}>
          Estimates are hidden for {team.key}. Values already set on issues are kept.
        </p>
      )}
    </>
  );
}
