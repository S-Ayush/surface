// Re-evaluating the menu when store data changes (SPEC-005 E4: a role change arriving as a delta
// removes a command while the menu is open). The store is MobX, so a reaction over the ranking
// sees every observable it reads: pool rows, the actor, teams.
import { reaction } from 'mobx';
import { useEffect, useMemo, useReducer, useRef } from 'react';

/** Calls `onChange` whenever an observable that `compute` read changes. Returns a disposer. */
export function watch(compute: () => unknown, onChange: () => void): () => void {
  return reaction(compute, onChange);
}

/**
 * Like `watch`, for a value already shown: if an observable changed between showing `shown` and
 * subscribing (render, then effect), the subscribing run already sees the new value without a
 * reaction firing, so `onChange` is called for it at once.
 */
export function track<T>(
  compute: () => T,
  shown: T,
  equals: (a: T, b: T) => boolean,
  onChange: () => void,
): () => void {
  let first = true;
  let stale = false;
  const stop = reaction(() => {
    const value = compute();
    if (first) {
      first = false;
      stale = !equals(shown, value);
    }
    return value;
  }, onChange);
  if (stale) onChange();
  return stop;
}

/**
 * The value of `compute`, recomputed when `compute` changes (memoise it with useCallback over its
 * inputs) and when an observable it read changes. Computed during render, so it always matches
 * the current inputs. The reaction runs `compute` once more when it subscribes, to learn what it
 * reads (the same work again: < 1 ms for 300 commands); `equals` tells whether that run saw a
 * change made in between.
 */
export function useReactive<T>(compute: () => T, equals: (a: T, b: T) => boolean = Object.is): T {
  const [version, bump] = useReducer((n: number) => n + 1, 0);
  const value = useMemo(() => {
    void version; // an observable read by `compute` changed: compute again
    return compute();
  }, [compute, version]);
  const shown = useRef(value);
  useEffect(() => {
    shown.current = value;
  });
  useEffect(() => track(compute, shown.current, equals, bump), [compute, equals]);
  return value;
}
