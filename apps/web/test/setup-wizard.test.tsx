// PLAN-001 S2, SPEC-001 §3.1: the setup wizard. Its logic and state run without a browser; the
// screens are checked as rendered HTML. The end-to-end run (AC-1, e2e) is held (plans README §6).
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  advance,
  back,
  checkAgain,
  edit,
  editNewLink,
  initialState,
  linkChecked,
  submitted,
  tokenFromLink,
  type SetupState,
} from '../src/routes/setup/state.js';
import { SetupView, type SetupScreen, type SetupViewProps } from '../src/routes/setup/SetupView.js';
import {
  checkLink,
  EMPTY_VALUES,
  setupBody,
  stepErrors,
  submitSetup,
  update,
  type Fetch,
  type SetupValues,
} from '../src/routes/setup/wizard.js';

const filled: SetupValues = {
  workspaceName: 'Acme',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  password: 'correct horse battery',
  confirmPassword: 'correct horse battery',
  teamName: 'Engineering',
  teamKey: 'ENG',
  teamKeyEdited: false,
};

/** A fetch that answers one status and body, and records what it was asked. */
function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchFn: Fetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  return { fetchFn, calls };
}

describe('team key suggestion', () => {
  // The suggestion itself is `@surface/domain`'s (PLAN-001 S8, `team-key.test.ts`).
  it('suggests a key from the team name, or none it would refuse', () => {
    expect(update(EMPTY_VALUES, 'teamName', 'Mobile Platform').teamKey).toBe('MP');
    expect(update(EMPTY_VALUES, 'teamName', 'X').teamKey).toBe('');
  });

  it('follows the team name until the user types a key, then keeps theirs', () => {
    let values = update(EMPTY_VALUES, 'teamName', 'Engineering');
    expect(values.teamKey).toBe('ENG');
    values = update(values, 'teamKey', 'core');
    expect(values.teamKey).toBe('CORE');
    values = update(values, 'teamName', 'Platform');
    expect(values.teamKey).toBe('CORE');
  });
});

describe('each step checks its own fields before moving on', () => {
  it('passes a filled-in form', () => {
    for (const step of ['workspace', 'admin', 'team'] as const) {
      expect(stepErrors(step, filled)).toEqual({});
    }
  });

  it('names what is missing or wrong, saying how to fix it', () => {
    expect(stepErrors('workspace', { ...filled, workspaceName: '  ' })).toEqual({
      workspaceName: 'Workspace name is required',
    });
    expect(
      stepErrors('admin', {
        ...filled,
        name: '',
        email: 'ada',
        password: 'short',
        confirmPassword: 'short',
      }),
    ).toEqual({
      name: 'Your name is required',
      email: 'Email must look like name@example.com',
      password: 'Password must be at least 10 characters long',
    });
    expect(stepErrors('admin', { ...filled, confirmPassword: 'something else' })).toEqual({
      confirmPassword: 'Passwords don’t match. Type the same password twice',
    });
    expect(stepErrors('team', { ...filled, teamKey: 'E1' }).teamKey).toBe(
      'Team key must be 2–5 capital letters, like ENG',
    );
  });

  it('applies the server’s limits on the step that has the field, not after Finish', () => {
    expect(stepErrors('workspace', { ...filled, workspaceName: 'a'.repeat(65) })).toEqual({
      workspaceName: 'Workspace name must be at most 64 characters long',
    });
    expect(stepErrors('admin', { ...filled, name: 'a'.repeat(81) }).name).toBe(
      'Your name must be at most 80 characters long',
    );
    expect(stepErrors('admin', { ...filled, email: 'a@b..c' }).email).toBe(
      'Email must look like name@example.com',
    );
    expect(stepErrors('team', { ...filled, teamName: 'a'.repeat(81) }).teamName).toBe(
      'Team name must be at most 80 characters long',
    );
  });
});

describe('talking to the server', () => {
  it('sends the three steps as POST /setup’s body, without the confirmation', () => {
    expect(setupBody(filled, 'TOKEN', 'Europe/Berlin')).toEqual({
      token: 'TOKEN',
      workspace: { name: 'Acme' },
      admin: {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        password: 'correct horse battery',
        timezone: 'Europe/Berlin',
      },
      team: { name: 'Engineering', key: 'ENG' },
    });
  });

  it('checks the link’s token, and knows when setup is already done', async () => {
    const valid = fakeFetch(200, { ok: true, result: { complete: false, tokenValid: true } });
    expect(await checkLink(valid.fetchFn, 'AB CD')).toBe('valid');
    expect(valid.calls[0]?.url).toBe('/setup/status?token=AB%20CD');
    const invalid = fakeFetch(200, { ok: true, result: { complete: false, tokenValid: false } });
    expect(await checkLink(invalid.fetchFn, null)).toBe('invalid');
    expect(invalid.calls[0]?.url).toBe('/setup/status');
    const done = fakeFetch(200, { ok: true, result: { complete: true, tokenValid: false } });
    expect(await checkLink(done.fetchFn, 'X')).toBe('complete');
  });

  it('does not blame the link when the server is starting or unreachable', async () => {
    const starting = fakeFetch(503, { ok: false, error: { code: 'UNAVAILABLE', message: 'x' } });
    expect(await checkLink(starting.fetchFn, 'X')).toBe('unavailable');
    const offline: Fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    expect(await checkLink(offline, 'X')).toBe('unavailable');
  });

  it.each([
    [201, { ok: true, result: { next: '/team/ENG' } }, { t: 'done', next: '/team/ENG' }],
    [201, { ok: true, result: { next: '//evil.example' } }, { t: 'done', next: '/' }],
    [403, { ok: false, error: { code: 'FORBIDDEN', message: 'x' } }, { t: 'link' }],
    [409, { ok: false, error: { code: 'CONFLICT', message: 'x' } }, { t: 'complete' }],
    [
      400,
      {
        ok: false,
        error: { code: 'INVALID_INPUT', message: 'Team key must be 2–5 capital letters, like ENG' },
      },
      { t: 'invalid', message: 'Team key must be 2–5 capital letters, like ENG' },
    ],
    [
      500,
      { ok: false, error: { code: 'INTERNAL', message: 'Something went wrong' } },
      { t: 'failed', message: 'Something went wrong' },
    ],
  ])('turns a %s answer into what the wizard shows', async (status, body, outcome) => {
    const { fetchFn, calls } = fakeFetch(status, body);
    expect(await submitSetup(fetchFn, { token: 'T' })).toEqual(outcome);
    expect(calls[0]).toMatchObject({ url: '/setup', init: { method: 'POST' } });
  });

  it('says to check the connection when the server can’t be reached', async () => {
    const offline: Fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    expect(await submitSetup(offline, {})).toEqual({
      t: 'failed',
      message: 'Could not reach the server. Check your connection and try again.',
    });
  });
});

describe('the wizard’s state', () => {
  const atStep = (state: SetupState) =>
    state.screen.t === 'step' ? state.screen.step : state.screen.t;
  const ready = (values: SetupValues = filled) => ({
    ...linkChecked(initialState('LINK-TOKEN'), 'valid'),
    values,
  });
  /** Continue from the first step to the last. */
  const toLast = (state: SetupState) => advance(advance(state).state).state;

  it('opens on the first step for a valid link, and on the matching screen otherwise', () => {
    expect(atStep(linkChecked(initialState('T'), 'valid'))).toBe('workspace');
    expect(atStep(linkChecked(initialState('T'), 'invalid'))).toBe('invalid-link');
    expect(atStep(linkChecked(initialState('T'), 'complete'))).toBe('complete');
    expect(atStep(linkChecked(initialState('T'), 'unavailable'))).toBe('unavailable');
  });

  it('checks the link again from the "can’t reach" screen, and only from there', () => {
    const waiting = linkChecked(initialState('T'), 'unavailable');
    expect(atStep(checkAgain(waiting))).toBe('checking');
    expect(checkAgain(ready())).toEqual(ready());
  });

  it('stays on a step with errors, and moves on once it is fixed', () => {
    const blank = advance(ready({ ...filled, workspaceName: '' }));
    expect([atStep(blank.state), blank.send]).toEqual(['workspace', false]);
    expect(blank.state.errors).toEqual({ workspaceName: 'Workspace name is required' });
    const fixed = advance(edit(blank.state, 'workspaceName', 'Acme'));
    expect([atStep(fixed.state), fixed.send, fixed.state.errors]).toEqual(['admin', false, {}]);
  });

  it('goes back without losing what was typed, clearing the step’s errors', () => {
    const admin = advance(ready()).state;
    const withErrors = advance(edit(admin, 'email', 'nope')).state;
    expect(withErrors.errors.email).toBeDefined();
    const previous = back(withErrors);
    expect([atStep(previous), previous.errors, previous.values.email]).toEqual([
      'workspace',
      {},
      'nope',
    ]);
    expect(back(previous)).toBe(previous); // nothing before the first step
  });

  it('sends the form once from the last step, and not again while it is in flight', () => {
    const last = toLast(ready());
    expect(atStep(last)).toBe('team');
    const sent = advance(last);
    expect([sent.send, sent.state.submitting]).toEqual([true, true]);
    expect(advance(sent.state).send).toBe(false);
    expect(back(sent.state)).toBe(sent.state);
  });

  it('shows each answer of the server where it belongs', () => {
    const sending = advance(toLast(ready())).state;
    expect(submitted(sending, { t: 'done', next: '/team/ENG' })).toBe(sending);
    expect(atStep(submitted(sending, { t: 'complete' }))).toBe('complete');
    const failed = submitted(sending, {
      t: 'failed',
      message: 'Setup failed. Try again in a moment.',
    });
    expect([failed.submitting, failed.formError, atStep(failed)]).toEqual([
      false,
      'Setup failed. Try again in a moment.',
      'team',
    ]);
  });

  it('keeps what was typed when the link stopped working, and finishes with a newer link', () => {
    const sending = advance(toLast(ready())).state;
    const refused = submitted(sending, { t: 'link' });
    expect([atStep(refused), refused.values, refused.newLink]).toEqual(['team', filled, '']);
    expect(refused.formError).toContain('Paste the newest link from the server logs');

    const nothingPasted = advance(refused);
    expect(nothingPasted.send).toBe(false);
    expect(nothingPasted.state.formError).toContain('Paste the newest setup link');

    const pasted = advance(
      editNewLink(refused, ' https://surface.example.com/setup?token=NEW-TOKEN-0000-1111 '),
    );
    expect([pasted.send, pasted.state.token]).toEqual([true, 'NEW-TOKEN-0000-1111']);
    expect(setupBody(pasted.state.values, pasted.state.token ?? '', undefined).token).toBe(
      'NEW-TOKEN-0000-1111',
    );
  });

  it.each([
    ['https://surface.example.com/setup?token=ABCD-EFGH', 'ABCD-EFGH'],
    ['/setup?token=ABCD-EFGH', 'ABCD-EFGH'],
    ['my-fixed-setup-token-123', 'my-fixed-setup-token-123'],
    ['https://surface.example.com/setup', undefined],
    ['short', undefined],
    ['   ', undefined],
  ])('reads the token in a pasted link: %s', (text, token) => {
    expect(tokenFromLink(text)).toBe(token);
  });
});

describe('the screens', () => {
  const render = (screen: SetupScreen, over: Partial<SetupViewProps> = {}) =>
    renderToString(
      <SetupView
        screen={screen}
        values={filled}
        errors={{}}
        formError={undefined}
        submitting={false}
        newLink={undefined}
        onChange={() => undefined}
        onNewLinkChange={() => undefined}
        onSubmit={() => undefined}
        onBack={() => undefined}
        onRetry={() => undefined}
        {...over}
      />,
    );

  it('without a valid link, says where to find one (SPEC-001 §3.1)', () => {
    const html = render({ t: 'invalid-link' });
    expect(html).toContain('Find the setup link in the server logs');
    expect(html).toContain('surface setup-token');
    expect(html).not.toContain('<form');
  });

  it('while the server is starting, says so and offers to try again, instead of blaming the link', () => {
    const html = render({ t: 'unavailable' });
    expect(html).toContain('Can’t reach Surface yet');
    expect(html).toContain('Try again');
    expect(html).not.toContain('Find the setup link');
  });

  it('asks for the newest link on the last step once the old one stopped working', () => {
    expect(render({ t: 'step', step: 'team' })).not.toContain('Newest setup link');
    const html = render({ t: 'step', step: 'team' }, { newLink: '' });
    expect(html).toContain('Newest setup link');
    expect(html).toContain('value="ENG"'); // the team step keeps its values
  });

  it('shows the step, its progress, and Continue until the last step', () => {
    const first = render({ t: 'step', step: 'workspace' });
    expect(first).toContain('Step <!-- -->1<!-- --> of <!-- -->3');
    expect(first).toContain('Workspace name');
    expect(first).toContain('Continue');
    expect(first).not.toContain('Back');
    const last = render({ t: 'step', step: 'team' });
    expect(last).toContain('Finish setup');
    expect(last).toContain('Back');
    expect(last).toContain('value="ENG"');
  });

  it('asks for the password twice, as new-password fields', () => {
    const html = render({ t: 'step', step: 'admin' });
    expect(html.match(/type="password"/g)).toHaveLength(2);
    expect(html.match(/autoComplete="new-password"/gi)).toHaveLength(2);
  });

  it('shows field and form errors as text the screen reader announces', () => {
    const html = render(
      { t: 'step', step: 'team' },
      {
        errors: { teamKey: 'Team key must be 2–5 capital letters, like ENG' },
        formError: 'Setup failed. Try again in a moment.',
      },
    );
    expect(html).toContain('Team key must be 2–5 capital letters, like ENG');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('role="alert"');
  });
});
