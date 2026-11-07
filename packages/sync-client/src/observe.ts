/**
 * Framework-free bindings (ADR-0017): any read of the store's observables
 * becomes a `subscribe`/`getSnapshot` pair, the shape React's
 * `useSyncExternalStore` takes. The snapshot keeps its identity until the
 * value changes, which `useSyncExternalStore` requires: a fresh object on
 * every call would render forever.
 */
import { compareStructural, reaction, untracked } from 'mobx';

export interface ExternalSource<T> {
  /** Calls `onChange` after each change of the value; returns the unsubscribe. */
  readonly subscribe: (onChange: () => void) => () => void;
  /** The current value: the same reference until the value changes. */
  readonly getSnapshot: () => T;
}

/**
 * Watch `read` (which reads store observables). `equals` decides when the
 * value changed; structural by default, so selectors may build new objects.
 * While nothing is subscribed, no MobX reaction is kept alive.
 */
export function observe<T>(
  read: () => T,
  equals: (a: T, b: T) => boolean = compareStructural,
): ExternalSource<T> {
  let current: { readonly value: T } | undefined;
  let stop: (() => void) | undefined;
  const listeners = new Set<() => void>();

  const update = (next: T): T => {
    if (current === undefined || !equals(current.value, next)) current = { value: next };
    return current.value;
  };

  return {
    getSnapshot: () =>
      // Subscribed: the reaction keeps `current` up to date. Otherwise read now.
      stop !== undefined && current !== undefined ? current.value : update(untracked(read)),
    subscribe: (onChange) => {
      listeners.add(onChange);
      if (stop === undefined) {
        stop = reaction(read, (next) => {
          if (current !== undefined && equals(current.value, next)) return;
          current = { value: next };
          for (const listener of [...listeners]) listener();
        });
        // Catch up with changes made between the last read and now.
        update(untracked(read));
      }
      return () => {
        listeners.delete(onChange);
        if (listeners.size > 0) return;
        stop?.();
        stop = undefined;
      };
    },
  };
}
