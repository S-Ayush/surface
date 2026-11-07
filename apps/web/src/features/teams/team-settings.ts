// Team settings → General (SPEC-001 §3.7): name, icon, color and time zone; the key is read-only
// (changing it is v2). The form keeps only the fields the user edited, over the live saved values,
// and saving sends only those: a field another member changed meanwhile shows their value and is
// never overwritten with a stale copy.
import { timeZoneProblem, type ColorHue } from '@surface/domain';
import { TEAM_NAME_MAX, type teamUpdate } from '@surface/operations';
import type { z } from 'zod';

export type TeamSettingsForm = {
  readonly name: string;
  readonly icon: string;
  readonly color: ColorHue;
  readonly timezone: string;
};

export type TeamSettingsProblems = Partial<Record<'name' | 'icon' | 'timezone', string>>;

export function teamSettingsForm(team: {
  readonly name: string;
  readonly icon: string | null;
  readonly color: ColorHue;
  readonly timezone: string;
}): TeamSettingsForm {
  return { name: team.name, icon: team.icon ?? '', color: team.color, timezone: team.timezone };
}

export function teamSettingsProblems(form: TeamSettingsForm): TeamSettingsProblems {
  const problems: { -readonly [K in keyof TeamSettingsProblems]?: string } = {};
  const name = form.name.trim();
  if (name === '') problems.name = 'Team name is required, like Engineering';
  else if (name.length > TEAM_NAME_MAX) {
    problems.name = `Team name must be ${TEAM_NAME_MAX} characters or fewer`;
  }
  if (form.icon.trim().length > 64) problems.icon = 'Icon must be 64 characters or fewer';
  const zone = timeZoneProblem(form.timezone.trim());
  if (zone !== undefined) problems.timezone = zone;
  return problems;
}

/** What the user edited; every other field follows the saved team, which may change live. */
export type TeamSettingsEdits = Partial<TeamSettingsForm>;

/** The form as shown: the saved values with the user's edits on top. */
export function withEdits(saved: TeamSettingsForm, edits: TeamSettingsEdits): TeamSettingsForm {
  return { ...saved, ...edits };
}

/**
 * The `team.update` input for the edited fields that differ from `saved`, or `undefined` when none
 * do. Fields the user didn't touch are never sent. An emptied icon clears it (`null`).
 */
export function teamSettingsChanges(
  teamKey: string,
  saved: TeamSettingsForm,
  edits: TeamSettingsEdits,
): z.input<typeof teamUpdate.input> | undefined {
  const name = edits.name?.trim();
  const icon = edits.icon?.trim();
  const timezone = edits.timezone?.trim();
  const { color } = edits;
  const changes = {
    ...(name !== undefined && name !== saved.name ? { name } : {}),
    ...(icon !== undefined && icon !== saved.icon ? { icon: icon === '' ? null : icon } : {}),
    ...(color !== undefined && color !== saved.color ? { color } : {}),
    ...(timezone !== undefined && timezone !== saved.timezone ? { timezone } : {}),
  };
  return Object.keys(changes).length === 0 ? undefined : { team: teamKey, ...changes };
}
