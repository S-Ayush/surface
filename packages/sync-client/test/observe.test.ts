/**
 * `observe` (ADR-0017): a read of observables as `subscribe`/`getSnapshot`,
 * the contract React's `useSyncExternalStore` relies on. The snapshot keeps
 * its identity until the value changes, subscribers hear of each change once,
 * and nothing is watched once the last subscriber leaves.
 */
import fc from 'fast-check';
import {
  compareStructural,
  observable,
  onBecomeObserved,
  onBecomeUnobserved,
  runInAction,
} from 'mobx';
import { describe, expect, it, vi } from 'vitest';
import { observe } from '../src/observe.js';

function counters() {
  const a = observable.box(0);
  const b = observable.box(0);
  const set = (box: typeof a, value: number) => runInAction(() => box.set(value));
  // A new object at every read, as the store's selectors build.
  const source = observe(() => ({ sum: a.get() + b.get(), even: (a.get() + b.get()) % 2 === 0 }));
  return { a, b, set, source };
}

describe('the snapshot', () => {
  it('keeps its identity until the value changes, subscribed or not', () => {
    const { a, b, set, source } = counters();
    const first = source.getSnapshot();
    expect(source.getSnapshot()).toBe(first);
    set(a, 1);
    set(b, -1); // the sum is 0 again: an equal value keeps the old snapshot
    expect(source.getSnapshot()).toBe(first);
    const stop = source.subscribe(() => undefined);
    expect(source.getSnapshot()).toBe(first);
    set(a, 2);
    const second = source.getSnapshot();
    expect(second).toEqual({ sum: 1, even: false });
    expect(source.getSnapshot()).toBe(second);
    stop();
    expect(source.getSnapshot()).toBe(second);
  });

  it('is read from the store once per change while subscribed, not at every call', () => {
    const a = observable.box(0);
    let reads = 0;
    const source = observe(() => {
      reads += 1;
      return { value: a.get() };
    });
    source.subscribe(() => undefined);
    const before = reads;
    for (let n = 0; n < 5; n += 1) source.getSnapshot();
    expect(reads).toBe(before);
    runInAction(() => a.set(1));
    expect(source.getSnapshot()).toEqual({ value: 1 });
    expect(reads).toBe(before + 1);
  });

  it('catches up at subscribe with a change made since the last read', () => {
    const { a, set, source } = counters();
    expect(source.getSnapshot().sum).toBe(0);
    set(a, 5);
    const listener = vi.fn();
    source.subscribe(listener);
    expect(source.getSnapshot().sum).toBe(5);
    // React compares the snapshot after subscribing; the listener is for later changes.
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('subscribers', () => {
  it('hear of each change once, after it is made, and not of an equal value', () => {
    const { a, b, set, source } = counters();
    const seen: number[] = [];
    source.subscribe(() => seen.push(source.getSnapshot().sum));
    set(a, 1);
    set(a, 1);
    runInAction(() => {
      a.set(3);
      b.set(-2); // one action, one change
    });
    set(b, 0);
    expect(seen).toEqual([1, 3]);
  });

  it('can leave independently; the last to leave stops the watching', () => {
    const { a, set, source } = counters();
    const watched = vi.fn();
    const unwatched = vi.fn();
    onBecomeObserved(a, watched);
    onBecomeUnobserved(a, unwatched);
    const first = vi.fn();
    const second = vi.fn();
    const leaveFirst = source.subscribe(first);
    const leaveSecond = source.subscribe(second);
    expect(watched).toHaveBeenCalledTimes(1);
    set(a, 1);
    leaveFirst();
    leaveFirst(); // twice is harmless
    set(a, 2);
    expect([first.mock.calls.length, second.mock.calls.length]).toEqual([1, 2]);
    expect(unwatched).not.toHaveBeenCalled();
    leaveSecond();
    expect(unwatched).toHaveBeenCalledTimes(1);
    set(a, 3);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('may leave from inside a notification without others missing it', () => {
    const { a, set, source } = counters();
    const later = vi.fn();
    const leave = source.subscribe(() => leave());
    source.subscribe(later);
    set(a, 1);
    expect(later).toHaveBeenCalledTimes(1);
  });
});

type Step =
  | { readonly t: 'set'; readonly box: 'a' | 'b'; readonly value: number }
  | { readonly t: 'subscribe' }
  | { readonly t: 'leave'; readonly which: number }
  | { readonly t: 'read' };

const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      t: fc.constant('set'),
      box: fc.constantFrom('a', 'b'),
      value: fc.integer({ min: -2, max: 2 }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('subscribe') }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('leave'), which: fc.nat(7) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('read') }) },
);

it('matches a reference model under any interleaving of changes, reads and subscriptions', () => {
  fc.assert(
    fc.property(fc.array(step, { maxLength: 60 }), (steps) => {
      const { a, b, set, source } = counters();
      const value = () => ({ sum: a.get() + b.get(), even: (a.get() + b.get()) % 2 === 0 });
      // The model: the value subscribers last heard of, and each one's call count.
      let known = value();
      const subscribers: { calls: number; expected: number; leave: () => void }[] = [];
      let previous = source.getSnapshot();
      for (const s of steps) {
        switch (s.t) {
          case 'set': {
            set(s.box === 'a' ? a : b, s.value);
            const next = value();
            if (subscribers.length > 0 && !compareStructural(known, next)) {
              known = next;
              for (const sub of subscribers) sub.expected += 1;
            }
            break;
          }
          case 'subscribe': {
            const sub: (typeof subscribers)[number] = {
              calls: 0,
              expected: 0,
              leave: () => undefined,
            };
            if (subscribers.length === 0) known = value();
            sub.leave = source.subscribe(() => {
              sub.calls += 1;
            });
            subscribers.push(sub);
            break;
          }
          case 'leave': {
            const [sub] = subscribers.splice(s.which % Math.max(1, subscribers.length), 1);
            sub?.leave();
            break;
          }
          case 'read':
            break;
        }
        const snapshot = source.getSnapshot();
        expect(snapshot).toEqual(value());
        if (compareStructural(snapshot, previous)) expect(snapshot).toBe(previous);
        previous = snapshot;
        for (const sub of subscribers) expect(sub.calls).toBe(sub.expected);
      }
    }),
    { seed: 20261107, numRuns: 300 },
  );
});
