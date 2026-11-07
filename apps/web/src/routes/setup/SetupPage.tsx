import { useEffect, useState } from 'react';
import {
  advance,
  back,
  checkAgain,
  edit,
  editNewLink,
  initialState,
  linkChecked,
  submitted,
} from './state.js';
import { SetupView } from './SetupView.js';
import { checkLink, setupBody, submitSetup, type Fetch } from './wizard.js';

export interface SetupPageProps {
  /** The `token` query parameter of the setup link. */
  readonly token: string | null;
  readonly fetchFn?: Fetch;
  /** Where to go when setup is done (a full page load, so the app starts signed in). */
  readonly navigate?: (path: string) => void;
}

// Module-level, so the link check's effect doesn't re-run on every render.
const browserFetch: Fetch = (url, init) => fetch(url, init);
const fullPageLoad = (path: string) => window.location.assign(path);

/** While the server is starting, check the link again this often (its `Retry-After`). */
const RECHECK_MS = 5_000;

/**
 * `/setup` (SPEC-001 §3.1): checks the link, then runs the three steps. The state changes are
 * the pure functions in `state.ts`; this component adds the requests and the retry timer.
 */
export function SetupPage({
  token,
  fetchFn = browserFetch,
  navigate = fullPageLoad,
}: SetupPageProps) {
  const [state, setState] = useState(() => initialState(token));
  const checking = state.screen.t === 'checking';
  const unavailable = state.screen.t === 'unavailable';

  useEffect(() => {
    if (!checking) return;
    let current = true;
    void checkLink(fetchFn, token).then((link) => {
      if (current) setState((s) => linkChecked(s, link));
    });
    return () => {
      current = false;
    };
  }, [checking, fetchFn, token]);

  useEffect(() => {
    if (!unavailable) return;
    const timer = setTimeout(() => setState(checkAgain), RECHECK_MS);
    return () => clearTimeout(timer);
  }, [unavailable]);

  const onSubmit = () => {
    const { state: next, send } = advance(state);
    setState(next);
    if (!send) return;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    void submitSetup(fetchFn, setupBody(next.values, next.token ?? '', timezone)).then(
      (outcome) => {
        if (outcome.t === 'done') navigate(outcome.next);
        setState((s) => submitted(s, outcome));
      },
    );
  };

  return (
    <SetupView
      screen={state.screen}
      values={state.values}
      errors={state.errors}
      formError={state.formError}
      submitting={state.submitting}
      newLink={state.newLink}
      onChange={(field, value) => setState((s) => edit(s, field, value))}
      onNewLinkChange={(text) => setState((s) => editNewLink(s, text))}
      onSubmit={onSubmit}
      onBack={() => setState(back)}
      onRetry={() => setState(checkAgain)}
    />
  );
}
