// Team settings → Automations (SPEC-015 §3.2): auto-archive of closed issues and auto-close of
// stale ones. Each change saves at once through `team.updateAutomations` (optimistic: the control
// follows the replica). Auto-archive has no off switch, and the selects offer only 1, 3, 6, 9 and
// 12 months (D15). Auto-close is off by default; turning it on sets 6 months and the team's first
// Canceled status. "Auto-close parent issues" and "sub-issues" arrive with M3 and are not shown.
// Readers of a public team see the page read-only.
import { AUTOMATION_MONTHS } from '@surface/domain';
import { teamUpdateAutomations, type InputOf } from '@surface/operations';
import { Switch } from '@surface/ui';
import { useApp } from '../../app/context.js';
import type { ScreenProps } from '../../app/screens.js';
import styles from './automations.module.css';
import { submitMutation, toastIfFailed } from './submit.js';
import { TeamSettingsLayout } from './TeamSettingsLayout.js';
import { useAutomations } from './useAutomations.js';
import type { TeamDetails } from './useTeams.js';

export function TeamAutomationsScreen({ params }: ScreenProps) {
  return (
    <TeamSettingsLayout teamKey={params['key'] ?? ''}>
      {(details) => <Automations key={details.team.id} details={details} />}
    </TeamSettingsLayout>
  );
}

type Change = Omit<InputOf<typeof teamUpdateAutomations>, 'team'>;

/** The default period when auto-close is turned on (§3.2). */
const DEFAULT_CLOSE_MONTHS = 6;

const monthsLabel = (months: number) => (months === 1 ? '1 month' : `${months} months`);

function Automations({ details }: { readonly details: TeamDetails }) {
  const app = useApp();
  const { team, access } = details;
  const settings = useAutomations(team.id);
  const readOnly = !access.edit;

  const save = async (change: Change) => {
    const store = app.store;
    if (store === null) return;
    // A rejected change rolls back and is a toast (the shell toasts a server refusal itself);
    // `toastIfFailed` covers a change the store didn't take.
    toastIfFailed(
      await submitMutation(store, teamUpdateAutomations, { team: team.key, ...change }),
    );
  };

  if (settings === null) return null;
  const closeOn = settings.autoCloseMonths !== null;
  const closeStatus = settings.autoCloseStatusId ?? settings.canceled[0]?.id ?? '';

  const monthOptions = AUTOMATION_MONTHS.map((months) => (
    <option key={months} value={months}>
      {monthsLabel(months)}
    </option>
  ));

  return (
    <div className={styles.form}>
      {readOnly && (
        <p className={styles.note}>
          Only members of {team.key} and Admins can change these settings.
        </p>
      )}

      <section className={styles.section} aria-labelledby="auto-archive-title">
        <h3 id="auto-archive-title" className={styles.sectionTitle}>
          Auto-archive
        </h3>
        <p className={styles.note}>
          Automatically archive closed issues (completed, canceled, or duplicate) after the selected
          period. Changes apply within a day.
        </p>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Auto-archive closed items after</span>
          <select
            className={styles.select}
            value={settings.autoArchiveMonths}
            disabled={readOnly}
            onChange={(event) => {
              const months = AUTOMATION_MONTHS.find((m) => String(m) === event.target.value);
              if (months !== undefined) void save({ autoArchiveMonths: months });
            }}
          >
            {monthOptions}
          </select>
        </label>
      </section>

      <section className={styles.section} aria-labelledby="auto-close-title">
        <h3 id="auto-close-title" className={styles.sectionTitle}>
          Auto-close issues
        </h3>
        <Switch
          label="Auto-close stale issues"
          checked={closeOn}
          disabled={readOnly || (!closeOn && settings.canceled.length === 0)}
          onCheckedChange={(on) => void save({ autoCloseMonths: on ? DEFAULT_CLOSE_MONTHS : null })}
        />
        {closeOn && settings.autoCloseMonths !== null && (
          <>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Close after being stale for</span>
              <select
                className={styles.select}
                value={settings.autoCloseMonths}
                disabled={readOnly}
                onChange={(event) => {
                  const months = AUTOMATION_MONTHS.find((m) => String(m) === event.target.value);
                  if (months !== undefined) void save({ autoCloseMonths: months });
                }}
              >
                {monthOptions}
              </select>
            </label>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>When closing stale issues, set status to</span>
              <select
                className={styles.select}
                value={closeStatus}
                disabled={readOnly}
                onChange={(event) => void save({ autoCloseStatus: event.target.value })}
              >
                {settings.canceled.map((status) => (
                  <option key={status.id} value={status.id}>
                    {status.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {!closeOn && settings.canceled.length === 0 && (
          <p className={styles.note}>
            Auto-close needs a Canceled status. Add one in Workflow first.
          </p>
        )}
      </section>
    </div>
  );
}
