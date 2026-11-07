// The web app's sign-in client against PLAN-001 S3's API (SPEC-001 §3.2, §6.1), and the auth
// state the guards read: signing in, signing out, and a session the server ended (E10, E14).
import { CSRF_HEADER } from '@surface/sync-protocol';
import { describe, expect, it } from 'vitest';
import { AuthState, httpAuthClient, type AuthClient, type Session } from '../src/app/auth.js';
import type { FetchLike } from '../src/app/http.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const failure = (status: number, code: string, message: string) =>
  json(status, { ok: false, error: { code, message, correlationId: 'c1' } });

type Sent = { readonly url: string; readonly init: RequestInit | undefined };

function server(answer: (url: string) => Response) {
  const sent: Sent[] = [];
  const fetchFn: FetchLike = (url, init) => {
    sent.push({ url, init });
    return Promise.resolve(answer(url));
  };
  return { sent, fetchFn };
}

const noCookies = () => '';
const SESSION: Session = { userId: 'u1', workspaceId: 'w1' };

describe('httpAuthClient', () => {
  it('reads capabilities and the session from their { ok, result } answers', async () => {
    const { fetchFn } = server((url) =>
      url === '/auth/capabilities'
        ? json(200, { ok: true, result: { smtp: true, setupComplete: true } })
        : json(200, { ok: true, result: SESSION }),
    );
    const client = httpAuthClient(fetchFn, noCookies);
    await expect(client.capabilities()).resolves.toEqual({ smtp: true, setupComplete: true });
    await expect(client.session()).resolves.toEqual(SESSION);
  });

  it('reads no session when signed out, or before setup (nobody can be signed in yet)', async () => {
    const signedOut = server(() => failure(401, 'UNAUTHENTICATED', 'Sign in to continue.'));
    await expect(httpAuthClient(signedOut.fetchFn, noCookies).session()).resolves.toBeNull();
    const beforeSetup = server(() => failure(503, 'SETUP_REQUIRED', 'Finish setup first.'));
    await expect(httpAuthClient(beforeSetup.fetchFn, noCookies).session()).resolves.toBeNull();
  });

  it('fails on any other answer, so the app says the server is unreachable', async () => {
    const starting = server(() => failure(503, 'UNAVAILABLE', 'Starting'));
    await expect(httpAuthClient(starting.fetchFn, noCookies).session()).rejects.toThrow();
    const odd = server(() => json(200, { ok: true, result: { done: 1 } }));
    const auth = new AuthState(httpAuthClient(odd.fetchFn, noCookies));
    expect((await auth.ready()).status).toBe('failed');
  });

  it('signs in with the email and password as JSON', async () => {
    const { sent, fetchFn } = server(() => json(200, { ok: true, result: { userId: 'u1' } }));
    const result = await httpAuthClient(fetchFn, noCookies).login('ada@example.com', 'secret pw');
    expect(result).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request?.url).toBe('/auth/login');
    expect(request?.init?.method).toBe('POST');
    expect(new Headers(request?.init?.headers).get('content-type')).toBe('application/json');
    expect(request?.init?.body).toBe(
      JSON.stringify({ email: 'ada@example.com', password: 'secret pw' }),
    );
  });

  it("shows the server's message for a refused sign-in, a 429 included, as it is", async () => {
    const messages = {
      401: 'Email or password is incorrect',
      429: 'Too many sign-in attempts. Try again in 12 minutes.',
      400: 'Enter your email and password.',
      403: 'Sign in at https://surface.example.',
    };
    for (const [status, message] of Object.entries(messages)) {
      const { fetchFn } = server(() => failure(Number(status), 'ANY', message));
      await expect(httpAuthClient(fetchFn, noCookies).login('a@b.c', 'x')).resolves.toEqual({
        ok: false,
        message,
      });
    }
  });

  it('says to try again when the server cannot be reached or fails', async () => {
    const offline = httpAuthClient(() => Promise.reject(new TypeError('offline')), noCookies);
    const proxyPage = server(() => new Response('<html>', { status: 502 }));
    const internal = server(() => failure(500, 'INTERNAL', 'Internal error'));
    for (const client of [
      offline,
      httpAuthClient(proxyPage.fetchFn, noCookies),
      httpAuthClient(internal.fetchFn, noCookies),
    ]) {
      const result = await client.login('a@b.c', 'x');
      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.message).toMatch(/try again/i);
    }
  });

  it('signs out with the CSRF token', async () => {
    const { sent, fetchFn } = server(() => json(200, { ok: true, result: {} }));
    await httpAuthClient(fetchFn, () => 'surface_csrf=t1').logout();
    expect(
      sent.map((r) => [r.url, r.init?.method, new Headers(r.init?.headers).get(CSRF_HEADER)]),
    ).toEqual([['/auth/logout', 'POST', 't1']]);
  });

  it('fails a sign-out the server refused, so the avatar menu says so', async () => {
    const { fetchFn } = server(() => failure(500, 'INTERNAL', 'Internal error'));
    await expect(httpAuthClient(fetchFn, noCookies).logout()).rejects.toThrow();
  });
});

/** An auth server in memory: who is signed in, and what sign-in answers. */
function fakeClient(initial: Session | null = null) {
  const state: { session: Session | null } = { session: initial };
  const client: AuthClient = {
    capabilities: () => Promise.resolve({ setupComplete: true, smtp: false }),
    session: () => Promise.resolve(state.session),
    login: (email, password) => {
      if (password !== 'right') {
        return Promise.resolve({ ok: false, message: 'Email or password is incorrect' });
      }
      state.session = { userId: email, workspaceId: 'w1' };
      return Promise.resolve({ ok: true });
    },
    logout: () => {
      state.session = null;
      return Promise.resolve();
    },
  };
  return { state, client };
}

/** The second look after a 4001 (AuthState.recheck), without a real wait. */
const noWait = () => Promise.resolve();
const sessionOf = (auth: AuthState) =>
  auth.snapshot.status === 'ready' ? auth.snapshot.session : 'not ready';
const epochOf = (auth: AuthState) => (auth.snapshot.status === 'ready' ? auth.snapshot.epoch : -1);

describe('AuthState', () => {
  it('signs in: the session is read back, so the guards follow `next`', async () => {
    const { client } = fakeClient();
    const auth = new AuthState(client);
    await auth.ready();
    await expect(auth.login('u2', 'wrong')).resolves.toEqual({
      ok: false,
      message: 'Email or password is incorrect',
    });
    expect(sessionOf(auth)).toBeNull();
    await expect(auth.login('u2', 'right')).resolves.toEqual({ ok: true });
    expect(sessionOf(auth)).toEqual({ userId: 'u2', workspaceId: 'w1' });
  });

  it('signs in after a logout without carrying the logout over', async () => {
    const { client } = fakeClient(SESSION);
    const auth = new AuthState(client);
    await auth.ready();
    await auth.logout();
    expect(auth.snapshot).toMatchObject({ loggedOut: true });
    await auth.login('u1', 'right');
    expect(auth.snapshot).toMatchObject({ loggedOut: false });
  });

  it('after a 4001 close, keeps a session still there under a new epoch (a new store)', async () => {
    // SPEC-001 Q11: signing in again in another tab ends this tab's session, and the cookie now
    // carries the new one, so the shell reopens instead of going to /login.
    const { state, client } = fakeClient(SESSION);
    const auth = new AuthState(client);
    await auth.ready();
    const before = epochOf(auth);
    await auth.recheck();
    expect(sessionOf(auth)).toEqual(SESSION);
    expect(epochOf(auth)).toBeGreaterThan(before);

    state.session = { userId: 'u9', workspaceId: 'w1' }; // someone else signed in
    await auth.recheck();
    expect(sessionOf(auth)).toEqual({ userId: 'u9', workspaceId: 'w1' });
  });

  it('after a 4001 close with nobody signed in, signs out keeping `next` (not a logout)', async () => {
    const { state, client } = fakeClient(SESSION);
    const auth = new AuthState(client, { wait: noWait });
    await auth.ready();
    state.session = null;
    await auth.recheck();
    expect(auth.snapshot).toMatchObject({ status: 'ready', session: null, loggedOut: false });
  });

  it('treats a failed check after a 4001 close as signed out', async () => {
    const { client } = fakeClient(SESSION);
    let reachable = true;
    const auth = new AuthState(
      {
        ...client,
        session: () => (reachable ? client.session() : Promise.reject(new Error('offline'))),
      },
      { wait: noWait },
    );
    await auth.ready();
    reachable = false;
    await auth.recheck();
    expect(sessionOf(auth)).toBeNull();
  });
});

describe('AuthState: answers that arrive late', () => {
  /** A client whose session checks the test answers one at a time, in any order. */
  function slowClient() {
    const pending: ((session: Session | null) => void)[] = [];
    let first = true;
    const client: AuthClient = {
      capabilities: () => Promise.resolve({ setupComplete: true, smtp: false }),
      session: () => {
        if (first) {
          first = false;
          return Promise.resolve(SESSION);
        }
        return new Promise((resolve) => pending.push(resolve));
      },
      login: () => Promise.resolve({ ok: true }),
      logout: () => Promise.resolve(),
    };
    /** Answers the `index`th check sent after the first load. */
    const answer = (index: number, session: Session | null) => pending[index]?.(session);
    return { client, answer };
  }

  it("keeps a logout a logout when the socket's 4001 check answers after it", async () => {
    // Logging out closes this tab's socket with 4001 too, so a check runs alongside (E10).
    const { client, answer } = slowClient();
    const auth = new AuthState(client);
    await auth.ready();
    const check = auth.recheck();
    await auth.logout();
    answer(0, null);
    await check;
    expect(auth.snapshot).toMatchObject({ session: null, loggedOut: true });
  });

  it('keeps a logout a logout when the 4001 check answers during it', async () => {
    const { client, answer } = slowClient();
    let finishLogout: () => void = () => undefined;
    const auth = new AuthState({
      ...client,
      logout: () =>
        new Promise<void>((resolve) => {
          finishLogout = resolve;
        }),
    });
    await auth.ready();
    const loggingOut = auth.logout();
    const check = auth.recheck();
    answer(0, null);
    await check;
    // Not a revoked session: that would send the user to /login?next= (SPEC-005 §3).
    expect(auth.snapshot).toMatchObject({ session: SESSION });
    finishLogout();
    await loggingOut;
    expect(auth.snapshot).toMatchObject({ session: null, loggedOut: true });
  });

  it('does not end a session that began after the check was sent', async () => {
    const { client, answer } = slowClient();
    const auth = new AuthState(client);
    await auth.ready();
    const stale = auth.recheck(); // sent with the old cookie
    const login = auth.login('u1', 'right');
    await new Promise<void>((resolve) => setImmediate(resolve)); // the sign-in reads its session
    answer(1, SESSION);
    await login;
    const signedIn = epochOf(auth);
    answer(0, null); // the old cookie's answer, late
    await stale;
    expect(sessionOf(auth)).toEqual(SESSION);
    expect(epochOf(auth)).toBe(signedIn);
  });
});

describe('AuthState: one more look after a 4001', () => {
  // Signing in again ends the previous session at once, so a tab's check can still carry the old
  // cookie (or a late answer can bring it back, SPEC-001 Q11). A 401 gets a second check after a
  // short wait before the user is sent to /login.
  function checks(...answers: (Session | null)[]) {
    let calls = 0;
    const waits: (() => void)[] = [];
    const client: AuthClient = {
      capabilities: () => Promise.resolve({ setupComplete: true, smtp: false }),
      session: () => {
        calls += 1;
        // The first load is signed in; then the scripted answers.
        return Promise.resolve(calls === 1 ? SESSION : (answers[calls - 2] ?? null));
      },
      login: () => Promise.resolve({ ok: true }),
      logout: () => Promise.resolve(),
    };
    const wait = () => new Promise<void>((resolve) => waits.push(resolve));
    return { client, wait, waits, checksMade: () => calls - 1 };
  }
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

  it('stays signed in when the second check finds the new session', async () => {
    const { client, wait, waits, checksMade } = checks(null, SESSION);
    const auth = new AuthState(client, { wait });
    await auth.ready();
    const check = auth.recheck();
    await tick();
    expect(sessionOf(auth)).toEqual(SESSION); // not sent to /login while it waits
    waits.shift()?.();
    await check;
    expect(sessionOf(auth)).toEqual(SESSION);
    expect(checksMade()).toBe(2);
  });

  it('signs out when the second check finds nobody either', async () => {
    const { client, wait, waits } = checks(null, null);
    const auth = new AuthState(client, { wait });
    await auth.ready();
    const check = auth.recheck();
    await tick();
    waits.shift()?.();
    await check;
    expect(auth.snapshot).toMatchObject({ session: null, loggedOut: false });
  });

  it('checks once when the first answer is a session', async () => {
    const { client, wait, waits, checksMade } = checks(SESSION);
    const auth = new AuthState(client, { wait });
    await auth.ready();
    await auth.recheck();
    expect(checksMade()).toBe(1);
    expect(waits).toHaveLength(0);
  });
});

describe('AuthState: checks tied to the session that asked (review M1)', () => {
  it("ignores a check from an earlier session's store", async () => {
    // A late 401 or 4001 from a store already closed must not end the session now open.
    const { state, client } = fakeClient(SESSION);
    const auth = new AuthState(client, { wait: noWait });
    await auth.ready();
    const oldEpoch = epochOf(auth);
    await auth.login('u1', 'right'); // a new session, a new store
    state.session = null; // whatever the server says now, the old store's check is stale
    await auth.recheck(oldEpoch);
    expect(sessionOf(auth)).toEqual({ userId: 'u1', workspaceId: 'w1' });
  });

  it("checks the session it was given, and ends it when it's gone", async () => {
    const { state, client } = fakeClient(SESSION);
    const auth = new AuthState(client, { wait: noWait });
    await auth.ready();
    state.session = null;
    await auth.recheck(epochOf(auth));
    expect(auth.snapshot).toMatchObject({ session: null, loggedOut: false });
  });

  it('lets a 401 during a 4001 check reach the same answer, not end the session first', async () => {
    // Q11: an old-cookie request's 401 and the socket's 4001 arrive together; both are checks,
    // so the session the browser holds now survives.
    const { state, client } = fakeClient(SESSION);
    const auth = new AuthState(client, { wait: noWait });
    await auth.ready();
    const epoch = epochOf(auth);
    state.session = { userId: 'u1', workspaceId: 'w1' }; // signed in again elsewhere
    await Promise.all([auth.recheck(epoch), auth.recheck(epoch)]);
    expect(sessionOf(auth)).toEqual({ userId: 'u1', workspaceId: 'w1' });
  });
});

describe('AuthState: a logout whose answer is lost (review m3)', () => {
  it('counts as done when the server has ended the session anyway', async () => {
    const { state, client } = fakeClient(SESSION);
    const auth = new AuthState({
      ...client,
      logout: () => {
        state.session = null; // the server acted; the answer never arrived
        return Promise.reject(new TypeError('network'));
      },
    });
    await auth.ready();
    await expect(auth.logout()).resolves.toBeUndefined();
    expect(auth.snapshot).toMatchObject({ session: null, loggedOut: true });
  });

  it('fails, keeping the session, when the server still has it', async () => {
    const { client } = fakeClient(SESSION);
    const auth = new AuthState({ ...client, logout: () => Promise.reject(new Error('500')) });
    await auth.ready();
    await expect(auth.logout()).rejects.toThrow();
    expect(sessionOf(auth)).toEqual(SESSION);
  });

  it('keeps ignoring 4001 checks while a second logout is still in flight', async () => {
    // The first logout fails (the server keeps the session); the second is still going when its
    // own 4001 arrives. That check must not turn the user's logout into a revoked session.
    const { state, client } = fakeClient(SESSION);
    const logouts: { resolve: () => void; reject: (error: Error) => void }[] = [];
    const auth = new AuthState(
      {
        ...client,
        logout: () => new Promise<void>((resolve, reject) => logouts.push({ resolve, reject })),
      },
      { wait: noWait },
    );
    await auth.ready();
    const first = auth.logout();
    const second = auth.logout();
    logouts[0]?.reject(new Error('500'));
    await expect(first).rejects.toThrow();
    state.session = null; // the second logout reached the server
    await auth.recheck();
    expect(sessionOf(auth)).toEqual(SESSION); // left to the logout in flight
    logouts[1]?.resolve();
    await second;
    expect(auth.snapshot).toMatchObject({ session: null, loggedOut: true });
  });
});
