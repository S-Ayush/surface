// SPEC-001 §3.2 (login) and AC-3's login part (no magic-link option without SMTP; the e2e is
// held), plus `?next=` after signing in, through the real route tree.
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppModel } from '../src/app/AppModel.js';
import { AuthState, LOGIN_FAILED, type AuthClient, type Session } from '../src/app/auth.js';
import { AppContext } from '../src/app/context.js';
import { createAppRouter, followAuth } from '../src/app/router.js';
import { LoginSubmit, loginProblem, type LoginView } from '../src/pages/LoginPage.js';

function client(): AuthClient {
  let session: Session | null = null;
  return {
    capabilities: () => Promise.resolve({ setupComplete: true, smtp: false }),
    session: () => Promise.resolve(session),
    login: (email, password) => {
      if (password !== 'correct horse') {
        return Promise.resolve({ ok: false, message: 'Email or password is incorrect' });
      }
      session = { userId: email, workspaceId: 'w1' };
      return Promise.resolve({ ok: true });
    },
    logout: () => Promise.resolve(),
  };
}

async function open(path: string) {
  const app = new AppModel(new AuthState(client()));
  const router = createAppRouter(app, {
    history: createMemoryHistory({ initialEntries: [path] }),
    origin: 'http://localhost',
    isServer: false,
    scrollRestoration: false,
  });
  await router.load();
  return { app, router };
}

describe('the login page', () => {
  it('asks for email and password, with no magic-link option without SMTP', async () => {
    const { app, router } = await open('/login');
    const html = renderToString(
      <AppContext value={app}>
        <RouterProvider router={router} />
      </AppContext>,
    );
    expect(html).toContain('Log in to Surface');
    expect(html).toMatch(/<label[^>]*>Email<\/label>/);
    expect(html).toMatch(
      /type="email"[^>]*autoComplete="username"|autoComplete="username"[^>]*type="email"/i,
    );
    expect(html).toMatch(/autoComplete="current-password"/i);
    expect(html).toContain('type="submit"');
    expect(html).not.toMatch(/login link/i);
  });

  it('after signing in, goes on to `next`', async () => {
    const { app, router } = await open('/login?next=%2Fteam%2FENG');
    const stop = followAuth(app, router);
    const settled = new Promise<void>((resolve) => {
      const unsubscribe = router.subscribe('onResolved', () => {
        unsubscribe();
        resolve();
      });
    });
    await expect(app.auth.login('u1', 'wrong')).resolves.toMatchObject({ ok: false });
    expect(router.state.location.href).toBe('/login?next=%2Fteam%2FENG');
    await app.auth.login('u1', 'correct horse');
    await settled;
    expect(router.state.location.href).toBe('/team/ENG');
    stop();
  });

  it('says what is missing before asking the server', () => {
    expect(loginProblem('', '')).toBe('Enter your email and password.');
    expect(loginProblem('  ', 'x')).toBe('Enter your email.');
    expect(loginProblem('ada@example.com', '')).toBe('Enter your password.');
    expect(loginProblem('ada@example.com', 'x')).toBeNull();
  });
});

describe('submitting the login form (review m4)', () => {
  function form(login: (email: string, password: string) => Promise<unknown>) {
    const views: LoginView[] = [];
    const calls: [string, string][] = [];
    const submit = new LoginSubmit(
      (email, password) => {
        calls.push([email, password]);
        return login(email, password) as ReturnType<AuthState['login']>;
      },
      (view) => views.push(view),
    );
    return { submit, views, calls };
  }

  it('says what is missing without asking the server', async () => {
    const { submit, views, calls } = form(() => Promise.resolve({ ok: true }));
    await submit.submit('', '');
    expect(calls).toEqual([]);
    expect(views).toEqual([{ error: 'Enter your email and password.', pending: false }]);
  });

  it('sends the trimmed email once, however often it is submitted meanwhile', async () => {
    let finish: (value: { ok: true }) => void = () => undefined;
    const { submit, views, calls } = form(() => new Promise((resolve) => (finish = resolve)));
    const first = submit.submit(' ada@example.com ', 'pw');
    await submit.submit('ada@example.com', 'pw'); // a second Enter in the same frame
    finish({ ok: true });
    await first;
    expect(calls).toEqual([['ada@example.com', 'pw']]);
    // Signed in: the button stays busy while the guards take the user on.
    expect(views).toEqual([{ error: null, pending: true }]);
  });

  it("shows a refusal's message and lets the user try again", async () => {
    const { submit, views, calls } = form(() =>
      Promise.resolve({ ok: false, message: 'Email or password is incorrect' }),
    );
    await submit.submit('ada@example.com', 'wrong');
    expect(views.at(-1)).toEqual({ error: 'Email or password is incorrect', pending: false });
    await submit.submit('ada@example.com', 'wrong again');
    expect(calls).toHaveLength(2);
  });

  it('says to try again if signing in fails unexpectedly, rather than staying busy', async () => {
    const { submit, views } = form(() => Promise.reject(new Error('unexpected')));
    await submit.submit('ada@example.com', 'pw');
    expect(views.at(-1)).toEqual({ error: LOGIN_FAILED, pending: false });
  });
});
