/**
 * CSRF on mutate requests (SPEC-001 §6.1, Q7; sync-protocol.md §4.4): every
 * `POST /sync/mutate` carries the `surface_csrf` cookie's value in
 * `X-CSRF-Token`. A `403 CSRF_INVALID` renews the cookie through
 * `GET /auth/session` and resends once; a second refusal backs off like any
 * failure, so a token that stays wrong never makes a request loop.
 */
import { CSRF_COOKIE } from '@surface/sync-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserCsrfToken, cookieValue } from '../src/csrf.js';
import { FakeHub } from './support/hub.js';
import { eventually, liveStore, until } from './support/live.js';
import { id } from './support/models.js';
import { debugTouch } from './support/ops.js';

function csrfHub(token: string): FakeHub {
  const hub = new FakeHub();
  for (const n of [1, 2]) hub.upsert(n);
  hub.csrfToken = token;
  return hub;
}

describe('the CSRF token on mutate requests', () => {
  it('sends the cookie’s token with every mutate request', async () => {
    const hub = csrfHub('token-1');
    hub.cookies.set(CSRF_COOKIE, 'token-1');
    const { store } = liveStore(hub, { csrfToken: () => hub.cookies.get(CSRF_COOKIE) });
    await store.start();
    await until(() => store.connection === 'online');

    const outcomes = [
      store.dispatch(debugTouch, { id: id(1) }),
      store.dispatch(debugTouch, { id: id(2) }),
    ];
    await eventually(() => hub.executed() === 2, 2000);
    expect(await Promise.all(outcomes)).toEqual([{ status: 'confirmed' }, { status: 'confirmed' }]);
    expect([hub.csrfRefusals, hub.sessionRequests]).toEqual([0, 0]);
    await store.close();
  });

  it('renews a stale token through GET /auth/session and resends at once', async () => {
    const hub = csrfHub('token-2');
    hub.cookies.set(CSRF_COOKIE, 'token-from-an-old-session');
    const { store, timers } = liveStore(hub, { csrfToken: () => hub.cookies.get(CSRF_COOKIE) });
    await store.start();
    await until(() => store.connection === 'online');

    // No timer runs: the resend follows the renewal without a backoff.
    const outcome = store.dispatch(debugTouch, { id: id(1) });
    await eventually(() => hub.executed() === 1, 2000);
    expect(await outcome).toEqual({ status: 'confirmed' });
    expect([hub.csrfRefusals, hub.sessionRequests, hub.executed()]).toEqual([1, 1, 1]);
    expect(timers.pending).not.toContain(500);
    await store.close();
  });

  it('backs off, instead of renewing again and again, when the renewed token is refused too', async () => {
    const hub = csrfHub('token-3');
    let token = 'wrong';
    const { store, timers } = liveStore(hub, { csrfToken: () => token });
    await store.start();
    await until(() => store.connection === 'online');

    const outcome = store.dispatch(debugTouch, { id: id(1) });
    await eventually(() => timers.pending.includes(500), 2000);
    expect([hub.csrfRefusals, hub.sessionRequests, hub.executed()]).toEqual([2, 1, 0]);

    token = 'token-3';
    timers.runNext();
    await eventually(() => hub.executed() === 1, 2000);
    expect(await outcome).toEqual({ status: 'confirmed' });
    expect(hub.executed()).toBe(1);
    await store.close();
  });

  it('sends no header at all when there is no cookie, and the server decides', async () => {
    const hub = new FakeHub();
    hub.upsert(1);
    const { store } = liveStore(hub, { csrfToken: () => undefined });
    await store.start();
    await until(() => store.connection === 'online');
    const outcome = store.dispatch(debugTouch, { id: id(1) });
    await eventually(() => hub.executed() === 1, 2000);
    expect(await outcome).toEqual({ status: 'confirmed' });
    expect(hub.mutateHeaders.map((headers) => headers.has('x-csrf-token'))).toEqual([false]);
    await store.close();
  });

  it('does not renew on a 403 that is not about the token, and backs off', async () => {
    const hub = csrfHub('token-4');
    hub.cookies.set(CSRF_COOKIE, 'token-4');
    hub.forbidMutate = true;
    const { store, timers } = liveStore(hub, { csrfToken: () => hub.cookies.get(CSRF_COOKIE) });
    await store.start();
    await until(() => store.connection === 'online');

    void store.dispatch(debugTouch, { id: id(1) });
    await eventually(() => timers.pending.includes(500), 2000);
    expect([hub.mutateHeaders.length, hub.sessionRequests]).toEqual([1, 0]);
    await store.close();
  });

  it('backs off without resending when the session is gone (401 on renewal)', async () => {
    const hub = csrfHub('token-5');
    hub.sessionStatus = 401;
    const { store, timers } = liveStore(hub, { csrfToken: () => hub.cookies.get(CSRF_COOKIE) });
    await store.start();
    await until(() => store.connection === 'online');

    void store.dispatch(debugTouch, { id: id(1) });
    await eventually(() => timers.pending.includes(500), 2000);
    expect([hub.csrfRefusals, hub.sessionRequests, hub.mutateHeaders.length]).toEqual([1, 1, 1]);
    await store.close();
  });
});

describe('the default token source: the page’s cookie (review M1)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the surface_csrf cookie when the store is given no token source', async () => {
    vi.stubGlobal('document', { cookie: 'theme=dark; surface_csrf=token-6' });
    const hub = csrfHub('token-6');
    const { store } = liveStore(hub);
    await store.start();
    await until(() => store.connection === 'online');

    const outcome = store.dispatch(debugTouch, { id: id(1) });
    await eventually(() => hub.executed() === 1, 2000);
    expect(await outcome).toEqual({ status: 'confirmed' });
    expect(hub.csrfRefusals).toBe(0);
    await store.close();
  });

  it('has no token outside a browser', () => {
    expect(typeof document).toBe('undefined');
    expect(browserCsrfToken()).toBeUndefined();
  });
});

describe('reading the CSRF cookie', () => {
  it('finds the cookie among others', () => {
    expect(cookieValue('theme=dark; surface_csrf=abc123; other=1', CSRF_COOKIE)).toBe('abc123');
  });

  it('decodes a percent-encoded value and keeps an "=" inside it', () => {
    expect(cookieValue('surface_csrf=a%2Bb=c', CSRF_COOKIE)).toBe('a+b=c');
  });

  it('returns undefined when the cookie is missing or empty', () => {
    expect(cookieValue('theme=dark', CSRF_COOKIE)).toBeUndefined();
    expect(cookieValue('', CSRF_COOKIE)).toBeUndefined();
    expect(cookieValue('surface_csrf=', CSRF_COOKIE)).toBeUndefined();
  });

  it('does not match a cookie whose name only ends with the name', () => {
    expect(cookieValue('old_surface_csrf=x', CSRF_COOKIE)).toBeUndefined();
  });

  it('keeps a value that is not valid percent-encoding as it is', () => {
    expect(cookieValue('surface_csrf=100%', CSRF_COOKIE)).toBe('100%');
  });
});
