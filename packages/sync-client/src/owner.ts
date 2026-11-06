/**
 * Which mutation queue this tab owns (SPEC-002 E5, PLAN-002 S8). Each tab
 * sends its own queue under its own `clientId`. A tab that closes or reloads
 * leaves its queue in storage, and the next tab to start adopts it, so its
 * mutations are sent, or resent with the same `(clientId, seq)`, exactly once.
 *
 * Ownership is marked two ways:
 * - **Web Locks** (secure origins): the owner holds `<replica>:queue:<id>`.
 *   The browser releases it when the tab closes or reloads, so the next start
 *   adopts the queue at once.
 * - **Lease** (plain-HTTP origins have no Web Locks): the owner renews
 *   `leaseUntil` every 5 s; a queue whose lease ran out (15 s) may be adopted.
 *   A reload there may take up to 15 s to pick its queue back up; until then
 *   it starts a new one.
 *
 * Either way the claim writes a per-tab `owner` token, and every queue write
 * checks it (`QueueFencedError`). So if a lease lapses while a tab is still
 * open (background timers are throttled) and another tab adopts the queue,
 * the first tab can no longer write it, and two tabs never assign the same seq.
 */
import type { ReplicaLocks } from './locks.js';
import { queueLockName, tryHold } from './locks.js';
import type { Persistence } from './persistence.js';
import type { Timers } from './socket.js';
import type { ClaimedQueue, PendingRecord } from './storage/types.js';
import { QueueFencedError } from './storage/types.js';

export const QUEUE_LEASE_MS = 15_000;
export const QUEUE_RENEW_MS = 5_000;
const HELD = Number.MAX_SAFE_INTEGER;

export interface QueueOwnership {
  readonly clientId: string;
  /** This tab's token, which every queue write must carry. */
  readonly owner: string;
  readonly nextSeq: number;
  /** The queue's pending mutations, in seq order. */
  readonly pending: readonly PendingRecord[];
  /** Give the queue up (close): release the lock or end the lease. */
  release(): Promise<void>;
}

export interface ClaimOptions {
  readonly persistence: Persistence;
  readonly replica: string;
  /** `undefined` where Web Locks are unavailable: use the lease. */
  readonly locks: ReplicaLocks | undefined;
  /** The id of a new queue, if no queue can be adopted. */
  readonly fresh: string;
  readonly owner: string;
  readonly clock: () => number;
  readonly timers: Timers;
  /** Another tab took the queue over, or forgot it (lease mode only). */
  readonly onLost: () => void;
  /** Whether this tab's queue is empty, so it may move to an orphaned one (lease mode). */
  readonly isIdle: () => boolean;
  /**
   * Lease mode: a queue left with work by a tab that is gone (its lease ran
   * out) was claimed for this tab. Return `true` to switch to it; `false`
   * hands it back. This tab's own (empty) queue is then let go.
   */
  readonly onAdopt: (ownership: QueueOwnership) => boolean;
}

export async function claimQueue(options: ClaimOptions): Promise<QueueOwnership> {
  const { persistence, owner } = options;
  const local = (clientId: string): QueueOwnership => ({
    clientId,
    owner,
    nextSeq: 1,
    pending: [],
    release: () => Promise.resolve(),
  });
  // The in-memory fallback is this tab's alone: nothing to adopt or share.
  if (persistence.storage.kind === 'memory') {
    const claim = await persistence.writeQueue((storage) =>
      storage.claimQueue({
        owner,
        now: 0,
        leaseUntil: 0,
        clientId: options.fresh,
        fresh: options.fresh,
      }),
    );
    return claim ? owned(claim, () => Promise.resolve()) : local(options.fresh);
  }

  if (options.locks) {
    const snapshot = await persistence.writeQueue((storage) => storage.readQueue());
    // Storage was lost on the way: carry on in memory.
    if (snapshot === undefined) return local(options.fresh);
    const waiting = new Set(snapshot.pending.map((record) => record.clientId));
    // Queues with work waiting first, so abandoned mutations go out soonest.
    const candidates = [...snapshot.clients].sort(
      (a, b) =>
        Number(waiting.has(b.clientId)) - Number(waiting.has(a.clientId)) ||
        (a.clientId < b.clientId ? -1 : 1),
    );
    for (const candidate of [...candidates.map((c) => c.clientId), options.fresh]) {
      const release = await tryHold(options.locks, queueLockName(options.replica, candidate));
      if (release === undefined) continue;
      const now = options.clock();
      const claim = await persistence.writeQueue((storage) =>
        // The lock marks ownership; a lease that never ends keeps lease-mode claims away.
        storage.claimQueue({ owner, now, leaseUntil: HELD, clientId: candidate, fresh: candidate }),
      );
      if (claim === undefined) {
        release();
        return local(options.fresh);
      }
      return owned(claim, () => {
        release();
        return Promise.resolve();
      });
    }
    // Every queue, even a brand-new id, is held: locks are misbehaving; use the lease.
  }

  const now = options.clock();
  const claim = await persistence.writeQueue((storage) =>
    storage.claimQueue({ owner, now, leaseUntil: now + QUEUE_LEASE_MS, fresh: options.fresh }),
  );
  if (claim === undefined) return local(options.fresh);
  return new Lease(options, claim.client.clientId).ownership(claim);
}

/**
 * Lease mode: renew this tab's lease every 5 s. On each renewal, while this
 * tab's queue is empty, look for a queue left with work by a tab that is gone
 * (a reload within the lease starts a new queue; this picks the old one up
 * once its lease ends, review M1).
 */
class Lease {
  readonly #options: ClaimOptions;
  /** The queue whose lease this tab renews. */
  #clientId: string;
  #ended = false;
  #timer: unknown;

  constructor(options: ClaimOptions, clientId: string) {
    this.#options = options;
    this.#clientId = clientId;
    this.#schedule();
  }

  ownership(claim: ClaimedQueue): QueueOwnership {
    return owned(claim, () => this.#end());
  }

  #schedule(): void {
    this.#timer = this.#options.timers.setTimeout(() => void this.#tick(), QUEUE_RENEW_MS);
  }

  async #tick(): Promise<void> {
    const { persistence, owner, clock } = this.#options;
    try {
      await persistence.writeQueue((storage) =>
        storage.writeQueue({
          clientId: this.#clientId,
          owner,
          leaseUntil: clock() + QUEUE_LEASE_MS,
        }),
      );
    } catch (error) {
      if (!(error instanceof QueueFencedError) || this.#ended) return;
      this.#ended = true;
      this.#options.onLost();
      return;
    }
    if (this.#ended) return;
    if (this.#options.isIdle()) await this.#adoptOrphan();
    if (!this.#ended) this.#schedule();
  }

  async #adoptOrphan(): Promise<void> {
    const { persistence, owner, clock } = this.#options;
    const now = clock();
    // No `fresh`: adopt a queue with work, or claim nothing.
    const orphan = await persistence.writeQueue((storage) =>
      storage.claimQueue({ owner, now, leaseUntil: now + QUEUE_LEASE_MS }),
    );
    if (orphan === undefined) return;
    const previous = this.#clientId;
    const take = !this.#ended && this.#options.onAdopt(this.ownership(orphan));
    if (take) this.#clientId = orphan.client.clientId;
    // Let go of the queue not kept: an empty one is forgotten, one with work adopted again.
    const letGo = take ? previous : orphan.client.clientId;
    await persistence
      .writeQueue((storage) => storage.writeQueue({ clientId: letGo, owner, leaseUntil: 0 }))
      .catch(() => undefined);
  }

  async #end(): Promise<void> {
    if (this.#ended) return;
    this.#ended = true;
    this.#options.timers.clearTimeout(this.#timer);
    // End the lease so the next start (a reload) adopts the queue at once.
    const clientId = this.#clientId;
    await this.#options.persistence
      .writeQueue((storage) =>
        storage.writeQueue({ clientId, owner: this.#options.owner, leaseUntil: 0 }),
      )
      .catch(() => undefined);
  }
}

function owned({ client, pending }: ClaimedQueue, release: () => Promise<void>): QueueOwnership {
  return {
    clientId: client.clientId,
    owner: client.owner,
    nextSeq: Math.max(client.nextSeq, (pending.at(-1)?.seq ?? 0) + 1),
    pending,
    release,
  };
}
