/**
 * The setup page's state and how each event changes it (SPEC-001 §3.1), as pure functions so
 * they are tested without a browser. `SetupPage` only adds the effects: the requests and timers.
 */
import {
  STEPS,
  stepErrors,
  update,
  type FieldErrors,
  type LinkState,
  type SetupValues,
  type Step,
  type SubmitOutcome,
  EMPTY_VALUES,
} from './wizard.js';

/** What the page shows: checking the link, a dead end, a wait, or the step being filled in. */
export type SetupScreen =
  | { readonly t: 'checking' }
  | { readonly t: 'invalid-link' }
  | { readonly t: 'complete' }
  /** The server is starting or can't be reached; the link may well be fine. */
  | { readonly t: 'unavailable' }
  | { readonly t: 'step'; readonly step: Step };

export interface SetupState {
  readonly screen: SetupScreen;
  readonly values: SetupValues;
  readonly errors: FieldErrors;
  /** A problem with the whole form (from the server, or the network). */
  readonly formError: string | undefined;
  readonly submitting: boolean;
  /** The token setup is finished with: the link's, or one from a newer link pasted later. */
  readonly token: string | null;
  /**
   * Defined once the server refused the token on Finish: the newest link, as the user pastes it.
   * What they typed in the steps is kept meanwhile.
   */
  readonly newLink: string | undefined;
}

export function initialState(token: string | null): SetupState {
  return {
    screen: { t: 'checking' },
    values: EMPTY_VALUES,
    errors: {},
    formError: undefined,
    submitting: false,
    token,
    newLink: undefined,
  };
}

export function linkChecked(state: SetupState, link: LinkState): SetupState {
  const screen: SetupScreen =
    link === 'valid'
      ? { t: 'step', step: STEPS[0] }
      : { t: link === 'invalid' ? 'invalid-link' : link };
  return { ...state, screen };
}

export function checkAgain(state: SetupState): SetupState {
  return state.screen.t === 'unavailable' ? { ...state, screen: { t: 'checking' } } : state;
}

export function edit(state: SetupState, field: keyof SetupValues, value: string): SetupState {
  return { ...state, values: update(state.values, field, value) };
}

export function editNewLink(state: SetupState, text: string): SetupState {
  return { ...state, newLink: text };
}

/**
 * Enter or the button: check the step, then move on, or on the last step send the form.
 * `send` is true exactly when the caller should post it; never twice while one is in flight.
 */
export function advance(state: SetupState): { state: SetupState; send: boolean } {
  const { screen } = state;
  if (screen.t !== 'step' || state.submitting) return { state, send: false };
  const errors = stepErrors(screen.step, state.values);
  if (Object.keys(errors).length > 0) {
    return { state: { ...state, errors, formError: undefined }, send: false };
  }
  const next = STEPS[STEPS.indexOf(screen.step) + 1];
  if (next) {
    return {
      state: { ...state, screen: { t: 'step', step: next }, errors: {}, formError: undefined },
      send: false,
    };
  }
  let { token } = state;
  if (state.newLink !== undefined) {
    const pasted = tokenFromLink(state.newLink);
    if (pasted === undefined) {
      const formError =
        'Paste the newest setup link from the server logs, like https://surface.example.com/setup?token=…';
      return { state: { ...state, errors: {}, formError }, send: false };
    }
    token = pasted;
  }
  return {
    state: { ...state, token, errors: {}, formError: undefined, submitting: true },
    send: true,
  };
}

export function back(state: SetupState): SetupState {
  const { screen } = state;
  if (screen.t !== 'step' || state.submitting) return state;
  const previous = STEPS[STEPS.indexOf(screen.step) - 1];
  if (!previous) return state;
  return { ...state, screen: { t: 'step', step: previous }, errors: {}, formError: undefined };
}

/** What the server's answer to Finish shows. On success the page leaves, so nothing changes. */
export function submitted(state: SetupState, outcome: SubmitOutcome): SetupState {
  switch (outcome.t) {
    case 'done':
      return state;
    case 'complete':
      return { ...state, submitting: false, screen: { t: 'complete' } };
    case 'link':
      // A restart or `surface setup-token` issued a new token while the wizard was open (Q4).
      return {
        ...state,
        submitting: false,
        newLink: '',
        formError:
          'This setup link no longer works: the server restarted or printed a new one. Paste the newest link from the server logs below. What you typed is kept.',
      };
    case 'invalid':
    case 'failed':
      return { ...state, submitting: false, formError: outcome.message };
  }
}

/** The token in a pasted setup link, or the pasted text itself when it is a bare token. */
export function tokenFromLink(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.includes('/') || trimmed.includes('?')) {
    try {
      const token = new URL(trimmed, 'http://setup.invalid').searchParams.get('token');
      return token !== null && token.length > 0 && token.length <= 128 ? token : undefined;
    } catch {
      return undefined;
    }
  }
  // SURFACE_SETUP_TOKEN may be any 16–128 characters (SPEC-004 §7).
  return /^\S{16,128}$/.test(trimmed) ? trimmed : undefined;
}
