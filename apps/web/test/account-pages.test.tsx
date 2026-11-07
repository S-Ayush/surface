// PLAN-001 S4, SPEC-001 §3.2, §3.3, §7: the login page's other ways in, and the check-email,
// forgot, reset and login-link pages, through the real route tree (AC-3's and AC-4's page parts;
// their e2e tests are held, plans README §6).
import { CSRF_COOKIE, CSRF_HEADER } from '@surface/sync-protocol';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AppModel } from '../src/app/AppModel.js';
import { AuthState, type AuthClient } from '../src/app/auth.js';
import { AppContext } from '../src/app/context.js';
import { createAppRouter } from '../src/app/router.js';
import { httpAccountApi, UNREACHABLE, type AccountResult } from '../src/features/account/api.js';
import {
  ASK_ADMIN_TEXT,
  CHECK_EMAIL_TEXT,
  INCOMPLETE_LINK,
} from '../src/features/account/AccountScreens.js';
import {
  AccountSubmit,
  newPasswordProblem,
  type FormView,
} from '../src/features/account/submit.js';

function client(smtp: boolean): AuthClient {
  return {
    capabilities: () => Promise.resolve({ setupComplete: true, smtp }),
    session: () => Promise.resolve(null),
    login: () => Promise.resolve({ ok: false, message: 'no' }),
    logout: () => Promise.resolve(),
  };
}

async function render(path: string, { smtp = true } = {}) {
  const app = new AppModel(new AuthState(client(smtp)));
  const router = createAppRouter(app, {
    history: createMemoryHistory({ initialEntries: [path] }),
    origin: 'http://localhost',
    isServer: false,
    scrollRestoration: false,
  });
  await router.load();
  return renderToString(
    <AppContext value={app}>
      <RouterProvider router={router} />
    </AppContext>,
  )
    .replaceAll('<!-- -->', '')
    .replaceAll('&#x27;', "'");
}

describe('the login page', () => {
  it('offers a login link and "Forgot password?" when the server sends email', async () => {
    const html = await render('/login');
    expect(html).toMatch(/<button[^>]*>(<span[^>]*>)?Email me a login link/);
    expect(html).toMatch(/<a[^>]*href="\/forgot"[^>]*>Forgot password\?<\/a>/);
  });

  it('offers no login link without SMTP, but still "Forgot password?" (AC-3)', async () => {
    const html = await render('/login', { smtp: false });
    expect(html).not.toMatch(/login link/i);
    expect(html).toContain('Forgot password?');
  });
});

describe('the account pages', () => {
  it('/login/check-email says a link may be on its way, without naming the address', async () => {
    const html = await render('/login/check-email');
    expect(html).toContain('Check your email');
    expect(html).toContain(CHECK_EMAIL_TEXT);
  });

  it('/forgot asks for the email when the server sends email', async () => {
    const html = await render('/forgot');
    expect(html).toContain('Reset your password');
    expect(html).toMatch(/autoComplete="username"/i);
    expect(html).toContain('Send reset link');
  });

  it('/forgot says to ask an Admin without SMTP (AC-3)', async () => {
    const html = await render('/forgot', { smtp: false });
    expect(html).toContain(ASK_ADMIN_TEXT);
    expect(html).not.toContain('Send reset link');
  });

  it('/reset asks for the new password twice', async () => {
    const html = await render('/reset?token=abc');
    expect(html).toContain('Choose a new password');
    expect(html.match(/autoComplete="new-password"/gi)).toHaveLength(2);
    expect(html).toContain('logs you out everywhere else');
  });

  it('/login/magic asks before using the link, with the button focused for Enter', async () => {
    const html = await render('/login/magic?token=abc');
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>(<span[^>]*>)?Log in/);
    expect(html).not.toContain(INCOMPLETE_LINK);
  });

  it.each(['/reset', '/login/magic?token='])(
    '%s without a token says the link is incomplete',
    async (path) => {
      const html = await render(path);
      expect(html).toContain(INCOMPLETE_LINK);
      expect(html).not.toContain('type="submit"');
    },
  );
});

describe('AccountSubmit', () => {
  const views = () => {
    const shown: FormView[] = [];
    return { shown, form: new AccountSubmit((view) => void shown.push(view)) };
  };

  it('shows a problem without sending', async () => {
    const { shown, form } = views();
    const send = vi.fn<() => Promise<AccountResult>>();
    await form.submit('Enter your email.', send);
    expect(send).not.toHaveBeenCalled();
    expect(shown).toEqual([{ error: 'Enter your email.', pending: false, done: false }]);
  });

  it('sends once while a request is in flight (a link works once)', async () => {
    const { shown, form } = views();
    let answer = (_: AccountResult) => undefined as void;
    const send = vi.fn(() => new Promise<AccountResult>((resolve) => (answer = resolve)));
    const first = form.submit(null, send);
    await form.submit(null, send);
    expect(send).toHaveBeenCalledTimes(1);
    answer({ ok: false, message: 'This login link has expired.' });
    await first;
    expect(shown.at(-1)).toEqual({
      error: 'This login link has expired.',
      pending: false,
      done: false,
    });
  });

  it('after a success, moves on and stays busy, or shows it is done', async () => {
    const moved = vi.fn<() => void>();
    const a = views();
    await a.form.submit(null, () => Promise.resolve({ ok: true }), moved);
    expect(moved).toHaveBeenCalledTimes(1);
    expect(a.shown.at(-1)).toEqual({ error: null, pending: true, done: false });
    const b = views();
    await b.form.submit(null, () => Promise.resolve({ ok: true }));
    expect(b.shown.at(-1)).toEqual({ error: null, pending: false, done: true });
  });
});

describe('newPasswordProblem', () => {
  it.each([
    ['', '', 'Enter a new password.'],
    ['short', 'short', 'Password must be at least 10 characters long.'],
    ['long enough pass', 'long enough typo', "The passwords don't match. Type the same one twice."],
    ['long enough pass', 'long enough pass', null],
  ])('%j / %j → %j', (password, again, problem) => {
    expect(newPasswordProblem(password, again)).toBe(problem);
  });
});

describe('httpAccountApi', () => {
  const api = (respond: () => Promise<Response>) => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchFn = (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return respond();
    };
    return { calls, api: httpAccountApi(fetchFn, () => `${CSRF_COOKIE}=tok`) };
  };
  const json = (status: number, body: unknown) =>
    Promise.resolve(new Response(JSON.stringify(body), { status }));

  it('posts to each route with the CSRF token, for a browser still signed in', async () => {
    const { calls, api: client } = api(() => json(200, { ok: true, result: {} }));
    await client.requestLink('magicLink', ' ada@example.com ');
    await client.requestLink('passwordReset', 'ada@example.com');
    await client.signInWithLink('t1');
    await client.resetPassword('t2', 'a new passphrase');
    expect(calls.map((c) => c.url)).toEqual([
      '/auth/magic-link',
      '/auth/forgot',
      '/auth/magic',
      '/auth/reset',
    ]);
    expect(calls.map((c) => c.init?.body)).toEqual([
      JSON.stringify({ email: 'ada@example.com' }),
      JSON.stringify({ email: 'ada@example.com' }),
      JSON.stringify({ token: 't1' }),
      JSON.stringify({ token: 't2', password: 'a new passphrase' }),
    ]);
    expect(new Headers(calls[0]?.init?.headers).get(CSRF_HEADER)).toBe('tok');
  });

  it("shows a refusal's message, and never a server failure's", async () => {
    const refused = api(() =>
      json(401, { ok: false, error: { code: 'UNAUTHENTICATED', message: 'Link used.' } }),
    );
    expect(await refused.api.signInWithLink('t')).toEqual({ ok: false, message: 'Link used.' });
    const failed = api(() =>
      json(500, { ok: false, error: { code: 'INTERNAL', message: 'pool exhausted' } }),
    );
    expect(await failed.api.signInWithLink('t')).toEqual({ ok: false, message: UNREACHABLE });
    const offline = api(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(await offline.api.resetPassword('t', 'p')).toEqual({ ok: false, message: UNREACHABLE });
  });
});
