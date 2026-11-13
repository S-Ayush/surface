/**
 * Cross-tab locks on the replica (SPEC-002 E5). A bootstrap holds the lock
 * exclusively and a warm start holds it shared, so a tab never reads a replica
 * that another tab is still writing, and two tabs never both bootstrap.
 *
 * Web Locks exist only in secure contexts (HTTPS or localhost). On a plain
 * HTTP origin tabs start unlocked: the generation fence still keeps the
 * replica consistent, but two tabs starting together may both bootstrap, and
 * the first then stops persisting rows (it keeps working from memory).
 */
export type LockMode = 'shared' | 'exclusive';

/** The part of the Web Locks `LockManager` used here. */
export interface ReplicaLocks {
  /**
   * With `ifAvailable`, the callback gets `null` instead of waiting when the
   * lock is taken. Otherwise it gets the lock (any non-null value).
   */
  request<T>(
    name: string,
    options: { mode: LockMode; signal?: AbortSignal; ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<T>,
  ): Promise<T>;
}

/** `navigator.locks`, or `undefined` where Web Locks are unavailable. */
export function webLocks(): ReplicaLocks | undefined {
  const nav: { readonly locks?: ReplicaLocks } | undefined = globalThis.navigator;
  return nav?.locks;
}

export function replicaLockName(replica: string): string {
  return `${replica}:replica`;
}

/** Name of the lock a tab holds while it owns a mutation queue (PLAN-002 S8). */
export function queueLockName(replica: string, clientId: string): string {
  return `${replica}:queue:${clientId}`;
}

/**
 * The lock of team `teamId`'s rows in a replica (SPEC-011 §5.7 `surface-team:<id>`, scoped to
 * the replica like the other locks): every tab that follows the team holds it shared, and
 * removing the team's rows takes it exclusively with `ifAvailable`.
 */
export function teamLockName(replica: string, teamId: string): string {
  return `${replica}:team:${teamId}`;
}

/**
 * Hold `name` shared until the returned function is called. Resolves once granted. The release
 * resolves once the lock is let go: locks are released asynchronously, so a request made right
 * after `release()`, without awaiting it, would still find this tab holding the lock.
 */
export function holdShared(
  locks: ReplicaLocks,
  name: string,
  signal?: AbortSignal,
): Promise<() => Promise<void>> {
  return new Promise((resolve, reject) => {
    let done: () => void = () => undefined;
    const held = new Promise<void>((resolveHeld) => {
      done = resolveHeld;
    });
    // `signal` gives up a request still waiting (the store closed); a granted lock is let go
    // through the release.
    const request = locks.request(name, { mode: 'shared', signal }, () => {
      resolve(() => {
        done();
        return released;
      });
      return held;
    });
    const released = request.then(
      () => undefined,
      () => undefined,
    );
    request.catch((error: unknown) =>
      reject(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

/**
 * Take `name` if no one holds it, and keep it until the returned function is
 * called. `undefined` when another tab holds it.
 */
export function tryHold(locks: ReplicaLocks, name: string): Promise<(() => void) | undefined> {
  return new Promise((resolve) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((done) => {
      release = done;
    });
    locks
      .request(name, { mode: 'exclusive', ifAvailable: true }, (lock) => {
        if (lock === null) {
          resolve(undefined);
          return Promise.resolve();
        }
        resolve(release);
        return held;
      })
      .catch(() => resolve(undefined));
  });
}
