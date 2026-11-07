// SPEC-005 AC-15 (unit part; the e2e is held): incomplete setup → /setup; signed out →
// /login?next=, and back to `next` after login; a Member on an admin route sees not-found.
import { describe, expect, it } from 'vitest';
import { adminAccess, guard, loginFor, safeNext, type GuardState } from '../src/app/guards.js';

const state = (overrides: Partial<GuardState> = {}): GuardState => ({
  setupComplete: true,
  signedIn: true,
  ...overrides,
});

describe('AC-15: route guards', () => {
  it('sends everything to /setup until setup is complete, and /setup away afterwards', () => {
    const fresh = state({ setupComplete: false, signedIn: false });
    for (const access of ['public', 'signed-in'] as const) {
      expect(guard(access, { path: '/my-issues' }, fresh)).toEqual({
        kind: 'redirect',
        to: '/setup',
      });
    }
    expect(guard('setup', { path: '/setup' }, fresh)).toEqual({ kind: 'allow' });
    expect(guard('setup', { path: '/setup' }, state())).toEqual({ kind: 'redirect', to: '/' });
    expect(guard('setup', { path: '/setup' }, state({ signedIn: false }))).toEqual({
      kind: 'redirect',
      to: '/login',
    });
  });

  it('sends a signed-out user to /login with the page to return to', () => {
    const out = state({ signedIn: false });
    expect(guard('signed-in', { path: '/team/ENG?tab=1' }, out)).toEqual({
      kind: 'redirect',
      to: '/login?next=%2Fteam%2FENG%3Ftab%3D1',
    });
    expect(guard('signed-in', { path: '/' }, out)).toEqual({ kind: 'redirect', to: '/login' });
    expect(guard('public', { path: '/login' }, out)).toEqual({ kind: 'allow' });
  });

  it('after an explicit logout, sends the user to /login without `next`', () => {
    // The next person to sign in on this browser starts at home, not on the last user's page.
    const loggedOut = state({ signedIn: false, loggedOut: true });
    expect(guard('signed-in', { path: '/team/ENG?tab=1' }, loggedOut)).toEqual({
      kind: 'redirect',
      to: '/login',
    });
  });

  it('after login, the login page sends the user on to `next`, or home', () => {
    expect(guard('public', { path: '/login', next: '/team/ENG' }, state())).toEqual({
      kind: 'redirect',
      to: '/team/ENG',
    });
    expect(guard('public', { path: '/login', next: 'https://evil.example' }, state())).toEqual({
      kind: 'redirect',
      to: '/',
    });
    // The router passes the whole address, query included.
    const login = { path: '/login?next=%2Fteam%2FENG', next: '/team/ENG' };
    expect(guard('public', login, state())).toEqual({ kind: 'redirect', to: '/team/ENG' });
    // Routes match whatever the case, so the login page does too.
    const upper = { path: '/LOGIN?next=%2Fteam%2FENG', next: '/team/ENG' };
    expect(guard('public', upper, state())).toEqual({ kind: 'redirect', to: '/team/ENG' });
    // Other public pages (an invite) stay reachable while signed in.
    expect(guard('public', { path: '/invite/abc' }, state())).toEqual({ kind: 'allow' });
  });

  it('shows a Member not-found on an admin route, and waits for the role from the store', () => {
    expect(adminAccess(false)).toEqual({ kind: 'not-found' });
    expect(adminAccess(true)).toEqual({ kind: 'allow' });
    expect(adminAccess(undefined)).toEqual({ kind: 'wait' });
  });
});

describe('next targets stay in the app', () => {
  it('accepts app paths and rejects other origins, control characters and the login page', () => {
    expect(safeNext('/team/ENG?x=1#y')).toBe('/team/ENG?x=1#y');
    for (const bad of [
      null,
      undefined,
      '',
      'team/ENG',
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '/team\n/x',
      '/login',
      '/LOGIN',
      '/Login?next=/x',
      '/login?next=/x',
      '/login/check-email',
      `/${'a'.repeat(2048)}`,
    ]) {
      expect(safeNext(bad)).toBeNull();
    }
    expect(loginFor('//evil.example')).toBe('/login');
  });
});
