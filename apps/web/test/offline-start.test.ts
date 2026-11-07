// SPEC-002 AC-6 (unit part; the e2e is held) and ADR-0018: a reload while the server can't be
// reached opens the replica of the session this device last had, then checks that session again
// once the server answers. Without a remembered session the app still says it can't reach the
// server (SPEC-005 §3).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthState,
  UnreachableError,
  RETRY_MS,
  browserStartMemory,
  httpAuthClient,
  waitToRetry,
  type AuthClient,
  type RememberedStart,
  type Session,
  type StartMemory,
} from '../src/app/auth.js';
import type { FetchLike } from '../src/app/http.js';

const ADA: Session = { userId: 'u1', workspaceId: 'w1' };
const BOB: Session = { userId: 'u2', workspaceId: 'w1' };

/** Memory in a variable, so a test can see what was kept. */
function memory(initial?: RememberedStart) {
  const kept: { value: RememberedStart | undefined } = { value: initial };
  const store: StartMemory = {
    read: () => kept.value,
    write: (start) => {
      kept.value = start;
    },
    clear: () => {
      kept.value = undefined;
    },
  };
  return { kept, store };
}

/** A server that may be down: `down` makes every check fail as unreachable. */
function flakyServer(session: Session | null, smtp = true) {
  const state = { down: false, session, checks: 0 };
  const unreachable = () => Promise.reject(new UnreachableError());
  const client: AuthClient = {
    capabilities: () =>
      state.down ? unreachable() : Promise.resolve({ setupComplete: true, smtp }),
    session: () => {
      state.checks += 1;
      return state.down ? unreachable() : Promise.resolve(state.session);
    },
    login: () => Promise.resolve({ ok: false, message: 'unused' }),
    logout: () => {
      state.session = null;
      return Promise.resolve();
    },
  };
  return { state, client };
}

/** Retries the test lets through one at a time. */
function retries() {
  let release: (() => void) | undefined;
  const waiting: number[] = [];
  return {
    retry: (attempt: number) =>
      new Promise<void>((resolve) => {
        waiting.push(attempt);
        release = resolve;
      }),
    waiting,
    /** Lets the next check run and waits for it to finish. */
    async next(): Promise<void> {
      const go = release;
      release = undefined;
      go?.();
      await vi.waitFor(() => {
        expect(release).toBeDefined();
      });
    },
    /** Lets the last check run when it ends the loop (no further retry). */
    async last(settled: () => boolean): Promise<void> {
      release?.();
      await vi.waitFor(() => {
        expect(settled()).toBe(true);
      });
    },
  };
}

describe('remembering the session on this device', () => {
  it('keeps the session and capabilities it loaded, and forgets them on logout', async () => {
    const { kept, store } = memory();
    const { client } = flakyServer(ADA);
    const auth = new AuthState(client, { memory: store });
    await auth.ready();
    expect(kept.value).toEqual({ session: ADA, smtp: true });
    await auth.logout();
    expect(kept.value).toBeUndefined();
  });

  it('forgets it when the server says nobody is signed in', async () => {
    const { kept, store } = memory({ session: ADA, smtp: true });
    const auth = new AuthState(flakyServer(null).client, { memory: store });
    await auth.ready();
    expect(kept.value).toBeUndefined();
  });
});

describe('a reload while the server is unreachable', () => {
  it('opens the remembered session, marked offline', async () => {
    const { store } = memory({ session: ADA, smtp: false });
    const server = flakyServer(ADA);
    server.state.down = true;
    const auth = new AuthState(server.client, { memory: store, retry: retries().retry });
    await expect(auth.ready()).resolves.toEqual({
      status: 'ready',
      capabilities: { setupComplete: true, smtp: false },
      session: ADA,
      epoch: 0,
      offline: true,
    });
  });

  it('still says the server is unreachable when nothing is remembered', async () => {
    const server = flakyServer(ADA);
    server.state.down = true;
    const auth = new AuthState(server.client, { memory: memory().store, retry: retries().retry });
    expect((await auth.ready()).status).toBe('failed');
  });

  it('still fails on an answer that is wrong rather than missing', async () => {
    const { store } = memory({ session: ADA, smtp: true });
    const client: AuthClient = {
      ...flakyServer(ADA).client,
      session: () => Promise.reject(new Error('session 400')),
    };
    const auth = new AuthState(client, { memory: store, retry: retries().retry });
    expect((await auth.ready()).status).toBe('failed');
  });
});

describe('checking the remembered session once the server answers', () => {
  async function offline(session: Session) {
    const { kept, store } = memory({ session, smtp: false });
    const server = flakyServer(session);
    server.state.down = true;
    const gate = retries();
    const auth = new AuthState(server.client, { memory: store, retry: gate.retry });
    await auth.ready();
    await vi.waitFor(() => {
      expect(gate.waiting).toEqual([0]);
    });
    return { auth, server, gate, kept };
  }

  it('keeps trying, with a longer wait each time, while the server is still unreachable', async () => {
    const { auth, gate } = await offline(ADA);
    await gate.next();
    await gate.next();
    expect(gate.waiting).toEqual([0, 1, 2]);
    expect(auth.snapshot).toMatchObject({ offline: true, session: ADA });
  });

  it('confirms the same session without a new epoch, so the shell keeps its store', async () => {
    const { auth, server, gate, kept } = await offline(ADA);
    server.state.down = false;
    await gate.last(() => auth.snapshot.status === 'ready' && auth.snapshot.offline !== true);
    expect(auth.snapshot).toMatchObject({
      session: ADA,
      epoch: 0,
      capabilities: { setupComplete: true, smtp: true },
    });
    expect(kept.value).toEqual({ session: ADA, smtp: true });
    expect(gate.waiting).toEqual([0]);
  });

  it('signs out, keeping `next`, when the session has ended meanwhile', async () => {
    const { auth, server, gate, kept } = await offline(ADA);
    server.state.down = false;
    server.state.session = null;
    await gate.last(() => auth.snapshot.status === 'ready' && auth.snapshot.session === null);
    expect(auth.snapshot).toMatchObject({ session: null, loggedOut: false });
    expect(auth.snapshot).not.toMatchObject({ offline: true });
    expect(kept.value).toBeUndefined();
  });

  it('opens the session the server has now, under a new epoch, when it is someone else', async () => {
    const { auth, server, gate, kept } = await offline(ADA);
    server.state.down = false;
    server.state.session = BOB;
    await gate.last(() => auth.snapshot.status === 'ready' && auth.snapshot.offline !== true);
    expect(auth.snapshot).toMatchObject({ session: BOB, epoch: 1 });
    expect(kept.value).toEqual({ session: BOB, smtp: true });
  });

  it('shows the error page when the server answers, but not with a session', async () => {
    // As a reload would: an answer that is wrong, not missing, isn't worth retrying.
    const { auth, server, gate } = await offline(ADA);
    server.client.session = () => Promise.reject(new Error('session 400'));
    server.state.down = false;
    await gate.last(() => auth.snapshot.status === 'failed');
    expect(gate.waiting).toEqual([0]);
  });

  it('stops checking once the user logs out', async () => {
    const { auth, server, gate } = await offline(ADA);
    server.state.down = false;
    await auth.logout();
    const checks = server.state.checks;
    await gate.last(() => true);
    await Promise.resolve();
    expect(server.state.checks).toBe(checks);
    expect(auth.snapshot).toMatchObject({ session: null, loggedOut: true });
  });
});

describe('the wait between checks', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Resolves to how long `waitToRetry(attempt)` waited under fake timers. */
  async function waited(attempt: number): Promise<number> {
    const start = Date.now();
    let done = false;
    void waitToRetry(attempt, new EventTarget()).then(() => (done = true));
    while (!done) await vi.advanceTimersByTimeAsync(500);
    return Date.now() - start;
  }

  it('is 2, 5 and 10 s, then 30 s for every later check', async () => {
    vi.useFakeTimers();
    expect(RETRY_MS).toEqual([2000, 5000, 10_000, 30_000]);
    const waits = [];
    for (const attempt of [0, 1, 2, 3, 4, 9]) waits.push(await waited(attempt));
    expect(waits).toEqual([2000, 5000, 10_000, 30_000, 30_000, 30_000]);
  });

  it('ends early when the browser says it is online again, and stops listening', async () => {
    vi.useFakeTimers();
    const browser = new EventTarget();
    const removed = vi.spyOn(browser, 'removeEventListener');
    let done = false;
    void waitToRetry(3, browser).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(1000);
    expect(done).toBe(false);
    browser.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    expect(removed).toHaveBeenCalledWith('online', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('telling unreachable from a wrong answer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const answering =
    (status: number): FetchLike =>
    () =>
      Promise.resolve(new Response('{}', { status }));

  it('calls a network failure or a 5xx unreachable', async () => {
    const refused: FetchLike = () => Promise.reject(new TypeError('Failed to fetch'));
    await expect(httpAuthClient(refused, () => '').session()).rejects.toBeInstanceOf(
      UnreachableError,
    );
    for (const status of [500, 502, 503, 504]) {
      const client = httpAuthClient(answering(status), () => '');
      await expect(client.session()).rejects.toBeInstanceOf(UnreachableError);
      await expect(client.capabilities()).rejects.toBeInstanceOf(UnreachableError);
    }
  });

  it('calls a 4xx other than 401 a wrong answer, not unreachable', async () => {
    const client = httpAuthClient(answering(400), () => '');
    const error: unknown = await client.session().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UnreachableError);
  });

  it('gives up on a check the server never answers after 10 seconds', async () => {
    vi.useFakeTimers();
    const hung: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    const check = httpAuthClient(hung, () => '')
      .session()
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(9_999);
    let settled = false;
    void check.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await check).toBeInstanceOf(UnreachableError);
  });
});

describe('the memory in the browser', () => {
  function storage() {
    const items = new Map<string, string>();
    const value: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
      getItem: (key) => items.get(key) ?? null,
      setItem: (key, item) => items.set(key, item),
      removeItem: (key) => items.delete(key),
    };
    return { items, value };
  }

  it('keeps the ids and the SMTP flag, and nothing else', () => {
    const { items, value } = storage();
    const kept = browserStartMemory(() => value);
    kept.write({ session: ADA, smtp: true });
    expect([...items.values()]).toEqual([JSON.stringify({ session: ADA, smtp: true })]);
    expect(kept.read()).toEqual({ session: ADA, smtp: true });
    kept.clear();
    expect(kept.read()).toBeUndefined();
  });

  it('reads nothing from a value it did not write, after a write that failed, or from storage it cannot use', () => {
    const { items, value } = storage();
    const kept = browserStartMemory(() => value);
    kept.write({ session: ADA, smtp: true });
    const [key] = [...items.keys()];
    items.set(key ?? '', '{"session":{"userId":1}}');
    expect(kept.read()).toBeUndefined();
    items.set(key ?? '', 'not json');
    expect(kept.read()).toBeUndefined();
    const full = storage();
    const kept2 = browserStartMemory(() => full.value);
    kept2.write({ session: ADA, smtp: true });
    full.value.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
    kept2.write({ session: BOB, smtp: true });
    // A failed write forgets the last session rather than keep someone else's.
    expect(kept2.read()).toBeUndefined();
    const blocked = browserStartMemory(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(blocked.read()).toBeUndefined();
    expect(() => {
      blocked.write({ session: ADA, smtp: true });
      blocked.clear();
    }).not.toThrow();
  });
});
