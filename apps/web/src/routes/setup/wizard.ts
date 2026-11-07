/**
 * The first-run setup wizard's logic (SPEC-001 §3.1, PLAN-001 S2), kept out of the components so
 * it is tested without a browser: per-step checks, the team key suggestion, and the two requests.
 * Setup is one of the documented plain-HTTP routes (SPEC-001 §6.1), not an operation: there is no
 * signed-in user to dispatch as yet.
 */
import {
  emailProblem,
  NAME_MAX_LENGTH,
  nameProblem,
  passwordProblem,
  suggestTeamKey,
  teamKeyProblem,
} from '@surface/domain';

export const STEPS = ['workspace', 'admin', 'team'] as const;
export type Step = (typeof STEPS)[number];

export interface SetupValues {
  workspaceName: string;
  name: string;
  email: string;
  password: string;
  confirmPassword: string;
  teamName: string;
  teamKey: string;
  /** False until the user edits the key: until then it follows the team name. */
  teamKeyEdited: boolean;
}

export const EMPTY_VALUES: SetupValues = {
  workspaceName: '',
  name: '',
  email: '',
  password: '',
  confirmPassword: '',
  teamName: '',
  teamKey: '',
  teamKeyEdited: false,
};

export type FieldErrors = Partial<Record<keyof SetupValues, string>>;

/**
 * What stops `step` from advancing; empty when it can. The rules are the server's own
 * (`@surface/domain`), so a problem shows on the step that has the field, not after Finish.
 */
export function stepErrors(step: Step, values: SetupValues): FieldErrors {
  const found: [keyof SetupValues, string | undefined][] =
    step === 'workspace'
      ? [
          [
            'workspaceName',
            nameProblem('Workspace name', values.workspaceName, NAME_MAX_LENGTH.workspace),
          ],
        ]
      : step === 'admin'
        ? [
            ['name', nameProblem('Your name', values.name, NAME_MAX_LENGTH.person)],
            ['email', emailProblem(values.email)],
            ['password', passwordProblem(values.password)],
            [
              'confirmPassword',
              passwordProblem(values.password) === undefined &&
              values.confirmPassword !== values.password
                ? 'Passwords don’t match. Type the same password twice'
                : undefined,
            ],
          ]
        : [
            ['teamName', nameProblem('Team name', values.teamName, NAME_MAX_LENGTH.team)],
            ['teamKey', teamKeyProblem(values.teamKey)],
          ];
  const errors: FieldErrors = {};
  for (const [field, problem] of found) if (problem !== undefined) errors[field] = problem;
  return errors;
}

/**
 * Applies an edit; the key follows the team name until the user types a key of their own. The
 * suggestion is the server's (`@surface/domain`); at setup no key is taken yet.
 */
export function update(values: SetupValues, field: keyof SetupValues, value: string): SetupValues {
  const next = { ...values, [field]: value };
  if (field === 'teamKey') return { ...next, teamKey: value.toUpperCase(), teamKeyEdited: true };
  if (field === 'teamName' && !values.teamKeyEdited) next.teamKey = suggestTeamKey(value) ?? '';
  return next;
}

/** `POST /setup`'s body. */
export function setupBody(values: SetupValues, token: string, timezone: string | undefined) {
  return {
    token,
    workspace: { name: values.workspaceName },
    admin: {
      name: values.name,
      email: values.email,
      password: values.password,
      ...(timezone ? { timezone } : {}),
    },
    team: { name: values.teamName, key: values.teamKey },
  };
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** `unavailable`: the server is starting (503) or can't be reached, which says nothing of the link. */
export type LinkState = 'valid' | 'invalid' | 'complete' | 'unavailable';

/** Whether the link's token can still finish setup. */
export async function checkLink(fetchFn: Fetch, token: string | null): Promise<LinkState> {
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  let body: unknown;
  try {
    const res = await fetchFn(`/setup/status${query}`, { headers: { accept: 'application/json' } });
    if (!res.ok) return 'unavailable';
    body = await res.json();
  } catch {
    return 'unavailable';
  }
  const result = isRecord(body) && isRecord(body['result']) ? body['result'] : {};
  if (result['complete'] === true) return 'complete';
  return result['tokenValid'] === true ? 'valid' : 'invalid';
}

export type SubmitOutcome =
  | { readonly t: 'done'; readonly next: string }
  | { readonly t: 'invalid'; readonly message: string }
  | { readonly t: 'link' }
  | { readonly t: 'complete' }
  | { readonly t: 'failed'; readonly message: string };

export async function submitSetup(fetchFn: Fetch, body: unknown): Promise<SubmitOutcome> {
  let res: Response;
  try {
    res = await fetchFn('/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return {
      t: 'failed',
      message: 'Could not reach the server. Check your connection and try again.',
    };
  }
  const payload: unknown = await res.json().catch(() => undefined);
  if (res.status === 201) {
    const next =
      isRecord(payload) && isRecord(payload['result']) ? payload['result']['next'] : undefined;
    // Same-origin paths only: `//host` would leave the app.
    const local = typeof next === 'string' && next.startsWith('/') && !next.startsWith('//');
    return { t: 'done', next: local ? next : '/' };
  }
  if (res.status === 403) return { t: 'link' };
  if (res.status === 409) return { t: 'complete' };
  const message =
    isRecord(payload) &&
    isRecord(payload['error']) &&
    typeof payload['error']['message'] === 'string'
      ? payload['error']['message']
      : undefined;
  if (res.status === 400 && message) return { t: 'invalid', message };
  return { t: 'failed', message: message ?? 'Setup failed. Try again in a moment.' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
