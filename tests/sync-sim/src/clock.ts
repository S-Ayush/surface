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
 */
import { vi } from 'vitest';

let outstanding = 0;
let realSetImmediate: typeof setImmediate | undefined;
let realClearImmediate: typeof clearImmediate | undefined;

export const EPOCH = Date.UTC(2026, 10, 7);

/** Fake the clock and start counting immediates. */
export function installClock(): void {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    now: EPOCH,
  });
  const set = (realSetImmediate = globalThis.setImmediate);
  const clear = (realClearImmediate = globalThis.clearImmediate);
  const live = new Set<NodeJS.Immediate>();
  outstanding = 0;
  globalThis.setImmediate = Object.assign(
    <A extends unknown[]>(callback: (...args: A) => void, ...args: A): NodeJS.Immediate => {
      outstanding += 1;
      const handle = set(() => {
        live.delete(handle);
        outstanding -= 1;
        callback(...args);
      });
      live.add(handle);
      return handle;
    },
    { __promisify__: set.__promisify__ },
  );
  globalThis.clearImmediate = (handle) => {
    if (handle !== undefined && live.delete(handle)) outstanding -= 1;
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
  for (let quiet = 0, turns = 0; quiet < 2; turns += 1) {
    if (turns > 100_000) throw new Error('Storage never went quiet (an IndexedDB loop?)');
    await turn();
    quiet = outstanding === 0 ? quiet + 1 : 0;
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
