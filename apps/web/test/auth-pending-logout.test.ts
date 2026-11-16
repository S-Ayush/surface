/**
 * @vitest-environment jsdom
 */
// SPEC-012 §3.12 item 2: a Log out that couldn't reach the server ends the session here and leaves
// a flag. The session cookie is HttpOnly, so until the server hears of the logout nothing may sign
// the old user back in: the next load, an `online` event and a sign-in send it first, and other
// tabs end their session when they see the flag.
import { describe, expect, it, vi } from 'vitest';
import {
  AuthState,
  browserStartMemory,
  LOGIN_FAILED,
  UnreachableError,
  type AuthClient,
  type Session,
  type StartMemory,
} from '../src/app/auth.js';

const ADA: Session = { userId: 'u1', workspaceId: 'w1' };

/** The flag in memory, shared by every `AuthState` of one "browser". */
function sharedFlag(): StartMemory {
  let pending = false;
  return {
    read: () => undefined,
    write: () => undefined,
    clear: () => undefined,
    logoutPending: () => pending,
    setLogoutPending: (on) => {
      pending = on;
    },
  };
}

/** A server that still has Ada's session until a logout reaches it, and that can be unplugged. */
function server() {
  const state = { session: ADA as Session | null, reachable: true, logouts: 0 };
  const client: AuthClient = {
    capabilities: () => Promise.resolve({ setupComplete: true, smtp: false }),
    session: () =>
      state.reachable ? Promise.resolve(state.session) : Promise.reject(new UnreachableError()),
    login: () => {
      state.session = ADA;
      return Promise.resolve({ ok: true });
    },
    logout: () => {
      if (!state.reachable) return Promise.reject(new TypeError('network'));
      state.logouts += 1;
      state.session = null;
      return Promise.resolve();
    },
  };
  return { state, client };
}

/** `online` events, fired by hand. */
function network() {
  const target = new EventTarget();
  return { target, fire: () => target.dispatchEvent(new Event('online')) };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function loggedOutOffline(memory: StartMemory, srv = server(), net = network()) {
  const auth = new AuthState(srv.client, { memory, network: net.target });
  await auth.ready();
  srv.state.reachable = false;
  await auth.logout();
  return { auth, srv, net };
}

describe('a logout the server has not heard of', () => {
  it('ends the session here and leaves the flag', async () => {
    const memory = sharedFlag();
    const { auth } = await loggedOutOffline(memory);
    expect(auth.snapshot).toMatchObject({ session: null, loggedOut: true });
    expect(memory.logoutPending?.()).toBe(true);
  });

  it('is sent before the next load signs the old user back in, exactly once', async () => {
    const memory = sharedFlag();
    const { srv } = await loggedOutOffline(memory);
    // The next page load: the server is back and its session is still alive.
    srv.state.reachable = true;
    expect(srv.state.session).toEqual(ADA);
    const reloaded = new AuthState(srv.client, { memory, network: network().target });
    await reloaded.ready();
    expect(reloaded.snapshot).toMatchObject({ session: null, loggedOut: true });
    expect(srv.state.logouts).toBe(1);
    expect(memory.logoutPending?.()).toBe(false);
    // Nothing is left to send.
    const again = new AuthState(srv.client, { memory, network: network().target });
    await again.ready();
    expect(srv.state.logouts).toBe(1);
  });

  it('keeps the user signed out while the server is still unreachable at load', async () => {
    const memory = sharedFlag();
    const { srv } = await loggedOutOffline(memory);
    const reloaded = new AuthState(srv.client, { memory, network: network().target });
    await reloaded.ready();
    expect(reloaded.snapshot).toMatchObject({ status: 'ready', session: null });
    expect(memory.logoutPending?.()).toBe(true);
  });

  it('is flushed by an online event', async () => {
    const memory = sharedFlag();
    const { srv, net } = await loggedOutOffline(memory);
    expect(srv.state.logouts).toBe(0);
    srv.state.reachable = true;
    net.fire();
    await settle();
    expect(srv.state.logouts).toBe(1);
    expect(srv.state.session).toBeNull();
    expect(memory.logoutPending?.()).toBe(false);
  });

  it('is sent before a sign-in, and a sign-in that can’t send it fails', async () => {
    const memory = sharedFlag();
    const { auth, srv } = await loggedOutOffline(memory);
    await expect(auth.login('ada@example.com', 'pw')).resolves.toEqual({
      ok: false,
      message: LOGIN_FAILED,
    });
    srv.state.reachable = true;
    const order: string[] = [];
    const logout = vi.spyOn(srv.client, 'logout');
    const login = vi.spyOn(srv.client, 'login');
    logout.mockImplementationOnce(() => {
      order.push('logout');
      return Promise.resolve();
    });
    login.mockImplementationOnce(() => {
      order.push('login');
      return Promise.resolve({ ok: true });
    });
    await auth.login('ada@example.com', 'pw');
    expect(order).toEqual(['logout', 'login']);
  });

  it('is sent by the check of a remembered session too, which then ends it', async () => {
    const srv = server();
    const memory: StartMemory = {
      ...sharedFlag(),
      read: () => ({ session: ADA, smtp: false }),
    };
    // The load can't reach the server and opens the remembered session; the flag is already set.
    srv.state.reachable = false;
    const auth = new AuthState(srv.client, {
      memory: {
        ...memory,
        logoutPending: (() => {
          let calls = 0;
          // Not set at load (so the remembered session opens), set by the time the check runs.
          return () => ++calls > 1;
        })(),
      },
      retry: () => Promise.resolve(),
      network: network().target,
    });
    await auth.ready();
    expect(auth.snapshot).toMatchObject({ session: ADA, offline: true });
    srv.state.reachable = true;
    await vi.waitFor(() => {
      expect(auth.snapshot).toMatchObject({ session: null, loggedOut: true });
    });
    expect(srv.state.logouts).toBe(1);
  });
});

describe('another tab (the storage event)', () => {
  const KEY = 'surface.logout-pending';

  function browser() {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
    const events = new EventTarget();
    return { storage, events, memory: browserStartMemory(() => storage, events) };
  }

  it('reads and writes the flag in storage, and never throws when storage does', () => {
    const { memory } = browser();
    expect(memory.logoutPending?.()).toBe(false);
    memory.setLogoutPending?.(true);
    expect(memory.logoutPending?.()).toBe(true);
    memory.setLogoutPending?.(false);
    expect(memory.logoutPending?.()).toBe(false);
    const broken = browserStartMemory(() => {
      throw new Error('blocked');
    }, new EventTarget());
    expect(broken.logoutPending?.()).toBe(false);
    expect(() => broken.setLogoutPending?.(true)).not.toThrow();
  });

  it('ends this tab’s session when another tab sets the flag', async () => {
    const { storage, events, memory } = browser();
    const srv = server();
    const auth = new AuthState(srv.client, { memory, network: network().target });
    await auth.ready();
    expect(auth.snapshot).toMatchObject({ session: ADA });
    srv.state.reachable = false;
    // The other tab logged out offline: it set the flag, and the browser told this tab.
    storage.setItem(KEY, '1');
    events.dispatchEvent(new StorageEvent('storage', { key: KEY }));
    expect(auth.snapshot).toMatchObject({ session: null, loggedOut: true });
  });

  it('ignores another key, and the flag being cleared', async () => {
    const { events, memory } = browser();
    const srv = server();
    const auth = new AuthState(srv.client, { memory, network: network().target });
    await auth.ready();
    events.dispatchEvent(new StorageEvent('storage', { key: 'something-else' }));
    events.dispatchEvent(new StorageEvent('storage', { key: KEY }));
    expect(auth.snapshot).toMatchObject({ session: ADA });
  });
});
