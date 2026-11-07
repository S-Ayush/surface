// SPEC-001 §6.1 (CSRF) and E14 (401 → login), for the web app's own requests. The sync client
// does its own CSRF retry for /sync/* (session D), so the web app only watches those for a 401.
import { CSRF_HEADER, SESSION_PATH } from '@surface/sync-protocol';
import { describe, expect, it } from 'vitest';
import { cookieValue, csrfFetch, watchSession, type FetchLike } from '../src/app/http.js';

type Call = { readonly url: string; readonly method: string; readonly token: string | null };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const csrfRefusal = () =>
  json(403, {
    ok: false,
    error: { code: 'CSRF_INVALID', message: 'Missing token', correlationId: 'c1' },
  });

/** A server that answers from a script, recording each request and the token it carried. */
function server(answer: (call: Call, index: number) => Response) {
  const calls: Call[] = [];
  const fetchFn: FetchLike = (url, init) => {
    const call = {
      url,
      method: init?.method ?? 'GET',
      token: new Headers(init?.headers).get(CSRF_HEADER),
    };
    calls.push(call);
    return Promise.resolve(answer(call, calls.length - 1));
  };
  return { calls, fetchFn };
}

describe('reading the CSRF cookie', () => {
  it('finds the value among other cookies, decoded', () => {
    expect(cookieValue('a=1; surface_csrf=x%2By; b=2', 'surface_csrf')).toBe('x+y');
    expect(cookieValue('surface_csrf=', 'surface_csrf')).toBeUndefined();
    expect(cookieValue('other=1', 'surface_csrf')).toBeUndefined();
    expect(cookieValue('xsurface_csrf=1', 'surface_csrf')).toBeUndefined();
  });
});

describe("csrfFetch: the token on the web app's writes", () => {
  it("sends the cookie's token on a POST and not on a GET", async () => {
    const { calls, fetchFn } = server(() => json(200, { ok: true, result: {} }));
    const send = csrfFetch(fetchFn, () => 'surface_csrf=t1');
    await send('/api/ops/team.create', { method: 'POST', body: '{}' });
    await send('/auth/capabilities');
    expect(calls.map((c) => [c.method, c.token])).toEqual([
      ['POST', 't1'],
      ['GET', null],
    ]);
  });

  it('on CSRF_INVALID, gets the session (which sets the cookie again) and resends once', async () => {
    let cookie = 'surface_csrf=stale';
    const { calls, fetchFn } = server((call) => {
      if (call.url === SESSION_PATH) {
        cookie = 'surface_csrf=fresh';
        return json(200, { ok: true, result: { userId: 'u1', workspaceId: 'w1' } });
      }
      return call.token === 'fresh' ? json(200, { ok: true, result: {} }) : csrfRefusal();
    });
    const response = await csrfFetch(fetchFn, () => cookie)('/auth/logout', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(calls.map((c) => `${c.method} ${c.url} ${String(c.token)}`)).toEqual([
      'POST /auth/logout stale',
      `GET ${SESSION_PATH} null`,
      'POST /auth/logout fresh',
    ]);
  });

  it('resends only once: a second refusal is the answer', async () => {
    const { calls, fetchFn } = server((call) =>
      call.url === SESSION_PATH ? json(200, { ok: true, result: {} }) : csrfRefusal(),
    );
    const response = await csrfFetch(fetchFn, () => 'surface_csrf=t')('/api/ops/x', {
      method: 'POST',
    });
    expect(response.status).toBe(403);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);
  });

  it('does not resend after another 403, or when the session is gone', async () => {
    const forbidden = server(() =>
      json(403, { ok: false, error: { code: 'FORBIDDEN', message: 'No', correlationId: 'c' } }),
    );
    await csrfFetch(forbidden.fetchFn, () => '')('/api/ops/x', { method: 'POST' });
    expect(forbidden.calls).toHaveLength(1);

    const signedOut = server((call) =>
      call.url === SESSION_PATH
        ? json(401, { ok: false, error: { code: 'UNAUTHENTICATED', message: 'Sign in' } })
        : csrfRefusal(),
    );
    const response = await csrfFetch(signedOut.fetchFn, () => '')('/api/ops/x', {
      method: 'POST',
    });
    expect(response.status).toBe(403);
    expect(signedOut.calls.map((c) => c.url)).toEqual(['/api/ops/x', SESSION_PATH]);
  });

  it('can still read the body of the answer it returns', async () => {
    const { fetchFn } = server(csrfRefusal);
    const response = await csrfFetch(fetchFn, () => '')('/api/ops/x', { method: 'POST' });
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'CSRF_INVALID' } });
  });
});

describe('watchSession: E14, a 401 sends the user to sign in', () => {
  it('reports a 401 and passes every answer through unchanged', async () => {
    let ended = 0;
    const statuses = [200, 401, 403, 500];
    const { calls, fetchFn } = server((_call, index) => json(statuses[index] ?? 200, {}));
    const watched = watchSession(fetchFn, () => {
      ended += 1;
    });
    const seen: number[] = [];
    for (let i = 0; i < statuses.length; i += 1) seen.push((await watched('/sync/mutate')).status);
    expect(seen).toEqual(statuses);
    expect(ended).toBe(1);
    expect(calls).toHaveLength(4); // never resends: the sync client owns its retries
  });
});
