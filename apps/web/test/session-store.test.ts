// How the shell wires a session's client store to auth (review m1): the sync client's fetch and
// its 4001 both check the session they were opened for (E10, E14, SPEC-001 Q11), and stores open
// one at a time (SPEC-002 E5).
import { describe, expect, it } from 'vitest';
import { AuthState, type AuthClient, type Session } from '../src/app/auth.js';
import type { FetchLike } from '../src/app/http.js';
import { runStore, sessionAuthHooks } from '../src/app/session-store.js';
import { StoreSequence } from '../src/app/stores.js';

const SESSION: Session = { userId: 'u1', workspaceId: 'w1' };

/** Auth whose server says `now()` is signed in; counts the session checks after the first load. */
async function signedIn(now: () => Session | null) {
  let checks = -1;
  const client: AuthClient = {
    capabilities: () => Promise.resolve({ setupComplete: true, smtp: false }),
    session: () => {
      checks += 1;
      return Promise.resolve(checks === 0 ? SESSION : now());
    },
    login: () => Promise.resolve({ ok: true }),
    logout: () => Promise.resolve(),
  };
  const auth = new AuthState(client, { wait: () => Promise.resolve() });
  const snapshot = await auth.ready();
  const epoch = snapshot.status === 'ready' ? snapshot.epoch : -1;
  return { auth, epoch, checks: () => checks };
}

const answering =
  (status: number): FetchLike =>
  () =>
    Promise.resolve(new Response('{}', { status }));

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const sessionOf = (auth: AuthState) =>
  auth.snapshot.status === 'ready' ? auth.snapshot.session : 'not ready';
const epochOf = (auth: AuthState) => (auth.snapshot.status === 'ready' ? auth.snapshot.epoch : -1);

describe('sessionAuthHooks', () => {
  it("checks the session when the sync client's request gets 401, and ends it if gone", async () => {
    const { auth, epoch } = await signedIn(() => null);
    const hooks = sessionAuthHooks(auth, epoch, answering(401));
    expect((await hooks.fetch('/sync/mutate')).status).toBe(401);
    await settle();
    expect(auth.snapshot).toMatchObject({ session: null, loggedOut: false });
  });

  it('opens a new store at a bootstrap 401 the same session answers (signed in again, Q11)', async () => {
    // A store whose first bootstrap fails stops there (no socket, so no 4001 follows): only a new
    // store, under the browser's new cookie, recovers. Only a mutate 401 keeps the store.
    const { auth, epoch, checks } = await signedIn(() => SESSION);
    await sessionAuthHooks(auth, epoch, answering(401)).fetch('/sync/bootstrap?userId=u1');
    await settle();
    expect(sessionOf(auth)).toEqual(SESSION);
    expect(epochOf(auth)).toBeGreaterThan(epoch);
    expect(checks()).toBe(1);
  });

  it('checks the session on a 4001, rather than signing out', async () => {
    const { auth, epoch, checks } = await signedIn(() => SESSION);
    sessionAuthHooks(auth, epoch, answering(200)).onSessionRevoked();
    await settle();
    expect(checks()).toBe(1);
    expect(sessionOf(auth)).toEqual(SESSION);
    expect(epochOf(auth)).toBeGreaterThan(epoch); // that socket is closed for good: a new store
  });

  it("keeps the store at a 401 the same session answers, so the sync client's backoff applies (E14)", async () => {
    // A 401 the session check contradicts (a proxy dropping the cookie on POST, say): a new store
    // would resend at once and loop. The socket is still the session's; a 4001 would close it.
    const { auth, epoch } = await signedIn(() => SESSION);
    await sessionAuthHooks(auth, epoch, answering(401)).fetch('https://surface.test/sync/mutate');
    await settle();
    expect(auth.snapshot).toMatchObject({ session: SESSION, epoch });
  });

  it('opens a new store at a 401 when another user is signed in now (Q11)', async () => {
    const other: Session = { userId: 'u9', workspaceId: 'w1' };
    const { auth, epoch } = await signedIn(() => other);
    await sessionAuthHooks(auth, epoch, answering(401)).fetch('/sync/mutate');
    await settle();
    expect(sessionOf(auth)).toEqual(other);
    expect(auth.snapshot).not.toMatchObject({ epoch });
  });

  it("passes other answers through without a check, and ignores an old store's 401", async () => {
    const { auth, epoch, checks } = await signedIn(() => null);
    await sessionAuthHooks(auth, epoch, answering(500)).fetch('/sync/mutate');
    await sessionAuthHooks(auth, epoch - 1, answering(401)).fetch('/sync/mutate');
    await settle();
    expect(checks()).toBe(0);
    expect(sessionOf(auth)).toEqual(SESSION);
  });
});

describe('runStore', () => {
  it("starts a session's store only after the previous one has closed", async () => {
    const events: string[] = [];
    let finishClose: () => void = () => undefined;
    const store = (name: string, close: () => Promise<void>) => ({
      start: () => {
        events.push(`start ${name}`);
        return Promise.reject(new Error('shown by the store status'));
      },
      close: () => {
        events.push(`close ${name}`);
        return close();
      },
    });
    const stores = new StoreSequence();
    const closeFirst = runStore(
      stores,
      store('1', () => new Promise<void>((resolve) => (finishClose = resolve))),
    );
    await settle();
    closeFirst();
    runStore(
      stores,
      store('2', () => Promise.resolve()),
    );
    await settle();
    expect(events).toEqual(['start 1', 'close 1']);
    finishClose();
    await settle();
    expect(events).toEqual(['start 1', 'close 1', 'start 2']);
  });
});
