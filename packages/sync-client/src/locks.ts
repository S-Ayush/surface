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
  request<T>(
    name: string,
    options: { mode: LockMode; signal?: AbortSignal },
    callback: () => Promise<T>,
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
