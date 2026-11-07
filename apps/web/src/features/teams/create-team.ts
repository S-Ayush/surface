// The create-team form (SPEC-001 §3.7, AC-11, E11) as plain state and functions, so it is tested
// without a DOM. The key is suggested from the name as it is typed, from the keys this client
// knows (the same algorithm as the server's), until the user edits it. Problems show inline
// before submitting; the server still decides, and its answer (a key taken meanwhile, or a
// private team's key this client can't see, D2) is shown on the same field.
import {
  NEW_TEAM_SETTINGS,
  suggestTeamKey,
  teamKeyIssue,
  timeZoneProblem,
  type ColorHue,
} from '@surface/domain';
import { TEAM_NAME_MAX, type teamCreate } from '@surface/operations';
import type { z } from 'zod';

export type CreateTeamForm = {
  readonly name: string;
  readonly key: string;
  /** The user typed in the key field: stop replacing it with suggestions. */
  readonly keyEdited: boolean;
  readonly icon: string;
  readonly color: ColorHue;
  readonly timezone: string;
};

export type CreateTeamField = 'name' | 'key' | 'icon' | 'timezone';
export type CreateTeamProblems = Partial<Record<CreateTeamField, string>>;

/** An empty form; the time zone is the creator's (SPEC-001 §3.7). */
export function emptyCreateTeamForm(myTimezone: string | undefined): CreateTeamForm {
  return {
    name: '',
    key: '',
    keyEdited: false,
    icon: '',
    color: NEW_TEAM_SETTINGS.color,
    timezone: myTimezone ?? NEW_TEAM_SETTINGS.timezone,
  };
}

/** The keys this client knows are taken (upper case), for suggestions and inline errors. */
export function takenKeys(teams: readonly { readonly key: string }[]): ReadonlySet<string> {
  return new Set(teams.map((team) => team.key.toUpperCase()));
}

/**
 * What the dialog reads from the store: the taken keys and the creator's time zone. Archived teams
 * count, because keys stay unique after archiving; private teams the user can't see aren't in the
 * store, so the server's answer covers them (E11, D2). The team this dialog is creating
 * (`creatingId`) doesn't: its optimistic row is in the store while the server answers.
 */
export function createTeamContext(
  teams: readonly { readonly id: string; readonly key: string }[],
  me: { readonly timezone: string } | undefined,
  creatingId?: string,
): { readonly keys: string[]; readonly myTimezone: string | undefined } {
  const others = teams.filter((team) => team.id !== creatingId);
  return { keys: [...takenKeys(others)], myTimezone: me?.timezone };
}

/**
 * Whether closing would lose something the user typed. Once submitted, nothing would: the change
 * is queued and goes through even if the dialog closes (SPEC-002 §3.3).
 */
export function hasUnsavedChanges(form: CreateTeamForm, submitted: boolean): boolean {
  return !submitted && (form.name !== '' || form.keyEdited || form.icon !== '');
}

/** A new name, and a new suggested key unless the user chose one. */
export function withName(
  form: CreateTeamForm,
  name: string,
  taken: ReadonlySet<string>,
): CreateTeamForm {
  if (form.keyEdited) return { ...form, name };
  return { ...form, name, key: suggestTeamKey(name, (key) => taken.has(key)) ?? '' };
}

/** A key the user typed, stored as the server will (trimmed, upper case). Clearing it resumes suggesting. */
export function withKey(
  form: CreateTeamForm,
  key: string,
  taken: ReadonlySet<string>,
): CreateTeamForm {
  const typed = key.trim().toUpperCase();
  if (typed === '') return withName({ ...form, keyEdited: false }, form.name, taken);
  return { ...form, key: typed, keyEdited: true };
}

/**
 * What is wrong with the form, field by field, in the server's words. An empty key is not an
 * error: the server suggests one when the name allows; otherwise the user is asked for one.
 */
export function createTeamProblems(
  form: CreateTeamForm,
  taken: ReadonlySet<string>,
): CreateTeamProblems {
  const problems: { -readonly [F in CreateTeamField]?: string } = {};
  const name = form.name.trim();
  if (name === '') problems.name = 'Team name is required, like Engineering';
  else if (name.length > TEAM_NAME_MAX) {
    problems.name = `Team name must be ${TEAM_NAME_MAX} characters or fewer`;
  }
  if (form.key === '') {
    if (name !== '') problems.key = 'Choose a team key: 2–5 capital letters, like ENG.';
  } else {
    const issue = teamKeyIssue(form.key, name, (key) => taken.has(key));
    if (issue !== undefined) problems.key = issue.message;
  }
  if (form.icon.trim().length > 64) problems.icon = 'Icon must be 64 characters or fewer';
  const zone = timeZoneProblem(form.timezone.trim());
  if (zone !== undefined) problems.timezone = zone;
  return problems;
}

export const hasProblems = (problems: CreateTeamProblems): boolean =>
  Object.values(problems).some((problem) => problem !== undefined);

/** The `team.create` input for a valid form, with the client's UUIDv7 (SPEC-003 §8). */
export function createTeamInput(
  form: CreateTeamForm,
  id: string,
): z.input<typeof teamCreate.input> {
  const icon = form.icon.trim();
  return {
    id,
    name: form.name.trim(),
    key: form.key,
    color: form.color,
    timezone: form.timezone.trim(),
    ...(icon === '' ? {} : { icon }),
  };
}

/**
 * Where a refused `team.create` belongs: key problems on the key field (E11: taken meanwhile, or a
 * private team's key, D2), anything else above the form. The refusal carries no field path, so
 * this goes by code and by `teamKeyIssue`'s wording (the server's `keyProblem` uses it; a test runs
 * its messages through here). The only other CONFLICT, a duplicate `id`, can't happen with a fresh
 * UUIDv7.
 */
export function placeServerError(error: { readonly code: string; readonly message: string }): {
  readonly field: 'key' | 'form';
  readonly message: string;
} {
  const aboutKey =
    error.code === 'CONFLICT' ||
    (error.code === 'INVALID_INPUT' && /\bteam key\b|\breserved\b/i.test(error.message));
  return { field: aboutKey ? 'key' : 'form', message: error.message };
}

/**
 * The keys the server refused as taken while the dialog is open: private teams the user can't see
 * aren't in the store (D2), so without this the form would suggest the same key again.
 */
export function withRefusedKey(
  refused: ReadonlySet<string>,
  error: { readonly code: string },
  key: string | undefined,
): ReadonlySet<string> {
  return error.code === 'CONFLICT' && key !== undefined ? new Set([...refused, key]) : refused;
}
