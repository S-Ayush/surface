/**
 * The simulation's clock. Timers, intervals and `Date` are Vitest fakes, so
 * hours of backoff, leases and pings pass in milliseconds. IndexedDB is not
 * on that clock: fake-indexeddb runs on the real `setImmediate`, which is
 * counted here, and the clock moves to its next timer only once every
 * immediate (and the microtasks they start) has run. So storage work takes
 * no virtual time, as it effectively does between network events, and a run
 * is still one fixed order of events: the same seed replays it exactly.
 *
 * (Faking `setImmediate` too does not work: each fake advance runs only one
 * more level of nested immediates, so storage would crawl through virtual
 * time and a crash would land mid-write far more often than it can.)
 *
 * The real server (`real-server.ts`) does real I/O the counter cannot see.
 * Its adapter reports it: work it awaits (`trackRealWork`), which holds the
 * clock until done, and events that arrived on real sockets (`RealEvents`),
 * which it hands to the tabs in a fixed order when the loop is otherwise
 * quiet. Virtual time stands still while the server works.
 */
import { vi } from 'vitest';

/**
 * Immediates scheduled since the current install and not yet run. Each install
 * gets its own set: one left over from the last case only touches its own.
 */
let outstanding = new Set<NodeJS.Immediate>();
let realSetImmediate: typeof setImmediate | undefined;
let realClearImmediate: typeof clearImmediate | undefined;
/** Real work the clock waits for (`trackRealWork`). */
const realWork = new Set<Promise<unknown>>();
/** Sources of real events (`addRealEvents`). */
const realSources = new Set<RealEvents>();

/** Events that arrive on real sockets, held until the clock hands them over. */
export interface RealEvents {
  /** Deliver what has arrived, in a fixed order; true if anything was. */
  flush(): boolean;
  /** Quiet turns of the real event loop before nothing more is on its way. */
  readonly quietTurns: number;
}

/** Hold the clock until `work` settles. Returns `work`. */
export function trackRealWork<T>(work: Promise<T>): Promise<T> {
  realWork.add(work);
  const done = () => realWork.delete(work);
  work.then(done, done);
  return work;
}

/** Let the clock hand `source`'s events over; returns a function that stops it. */
export function addRealEvents(source: RealEvents): () => void {
  realSources.add(source);
  return () => realSources.delete(source);
}

export const EPOCH = Date.UTC(2026, 10, 7);

/** Fake the clock and start counting immediates. */
export function installClock(): void {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    now: EPOCH,
  });
  const set = (realSetImmediate = globalThis.setImmediate);
  const clear = (realClearImmediate = globalThis.clearImmediate);
  const live = (outstanding = new Set<NodeJS.Immediate>());
  globalThis.setImmediate = Object.assign(
    <A extends unknown[]>(callback: (...args: A) => void, ...args: A): NodeJS.Immediate => {
      const handle = set(() => {
        live.delete(handle);
        callback(...args);
      });
      live.add(handle);
      return handle;
    },
    { __promisify__: set.__promisify__ },
  );
  globalThis.clearImmediate = (handle) => {
    if (handle !== undefined) live.delete(handle);
    clear(handle);
  };
}

export function uninstallClock(): void {
  if (realSetImmediate) globalThis.setImmediate = realSetImmediate;
  if (realClearImmediate) globalThis.clearImmediate = realClearImmediate;
  realSetImmediate = undefined;
  realClearImmediate = undefined;
  vi.useRealTimers();
}

/** One real turn of the event loop: queued immediates and microtasks run. */
function turn(): Promise<void> {
  const set = realSetImmediate ?? setImmediate;
  return new Promise((resolve) => set(() => resolve()));
}

/**
 * Run every immediate, and every one they schedule, until none is left. Two
 * quiet turns in a row, so microtasks queued behind the check also run.
 */
export async function settle(): Promise<void> {
  const needed = Math.max(2, ...[...realSources].map((source) => source.quietTurns));
  for (let quiet = 0, turns = 0; quiet < needed; turns += 1) {
    if (turns > 100_000) throw new Error('Storage never went quiet (an IndexedDB loop?)');
    if (realWork.size > 0) {
      // The real server is working: wait for it, however many turns it takes.
      await Promise.allSettled([...realWork]);
      quiet = 0;
      continue;
    }
    await turn();
    let delivered = false;
    for (const source of realSources) delivered = source.flush() || delivered;
    quiet = outstanding.size === 0 && realWork.size === 0 && !delivered ? quiet + 1 : 0;
  }
}

/** Let `ms` of virtual time pass, one timer at a time, settling between timers. */
export async function advance(ms: number): Promise<void> {
  await settle();
  if (ms <= 0) return;
  const target = Date.now() + ms;
  // A timer at the target, so the next timer is never past it.
  const stop = setTimeout(() => undefined, ms);
  try {
    while (Date.now() < target) {
      await vi.advanceTimersToNextTimerAsync();
      await settle();
    }
  } finally {
    clearTimeout(stop);
  }
}
