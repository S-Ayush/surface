// What commands act on (SPEC-005 §6 "Focus / selection context: shell store, set by pages").
// A page or focused component declares its target with useCommandContext; the command menu reads
// it when it opens. Precedence is explicit, not mount order (as for command handlers in
// commands/registry.ts): React runs a child's effects before its parent's, so "newest wins" would
// let a team layout beat the issue view inside it on a reload, and lose to it after navigation.
import { createContext, use, useEffect, useRef, useSyncExternalStore } from 'react';
import { GLOBAL_TARGET, type CommandTarget } from './model.js';

/** Who sets the target: a page, a focused component in it, or a selection (most specific last). */
export const TARGET_LEVELS = ['page', 'focus', 'selection'] as const;
export type TargetLevel = (typeof TARGET_LEVELS)[number];

type Entry = { target: CommandTarget; readonly rank: number; readonly order: number };

export type TargetHandle = {
  /** Changes the target in place: a relabel ("3 selected issues") keeps its precedence. */
  update(target: CommandTarget): void;
  remove(): void;
};

export class TargetStore {
  #entries: Entry[] = [];
  #order = 0;
  readonly #listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** The highest level's target; within a level, the newest. */
  current = (): CommandTarget => {
    let best: Entry | undefined;
    for (const entry of this.#entries) {
      if (
        best === undefined ||
        entry.rank > best.rank ||
        (entry.rank === best.rank && entry.order > best.order)
      ) {
        best = entry;
      }
    }
    return best?.target ?? GLOBAL_TARGET;
  };

  push(target: CommandTarget, level: TargetLevel = 'page'): TargetHandle {
    const entry: Entry = { target, rank: TARGET_LEVELS.indexOf(level), order: ++this.#order };
    this.#entries = [...this.#entries, entry];
    this.#emit();
    return {
      update: (next) => {
        entry.target = next;
        this.#emit();
      },
      remove: () => {
        this.#entries = this.#entries.filter((other) => other !== entry);
        this.#emit();
      },
    };
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

export const TargetContext = createContext<TargetStore | null>(null);

function useTargets(): TargetStore {
  const store = use(TargetContext);
  if (store === null) throw new Error('Wrap the app in <CommandMenuProvider>');
  return store;
}

const targetKey = (target: CommandTarget) =>
  target.kind === 'global' ? 'global' : `${target.kind}|${target.ids.join(',')}|${target.label}`;

/**
 * Sets the command target while the calling page or component is mounted, at `level` (a page by
 * default). An inline object is fine: the target is updated only when its kind, ids or label
 * change, and an update never changes its precedence.
 */
export function useCommandContext(target: CommandTarget, level: TargetLevel = 'page'): void {
  const store = useTargets();
  const latest = useRef(target);
  const handle = useRef<TargetHandle | null>(null);
  useEffect(() => {
    latest.current = target;
  });
  // Registered once per store and level, so re-renders never reorder entries.
  useEffect(() => {
    const registered = store.push(latest.current, level);
    handle.current = registered;
    return () => {
      handle.current = null;
      registered.remove();
    };
  }, [store, level]);
  const key = targetKey(target);
  useEffect(() => {
    handle.current?.update(latest.current);
  }, [key]);
}

/** The current target, for the context chip. */
export function useCurrentTarget(): CommandTarget {
  const store = useTargets();
  return useSyncExternalStore(store.subscribe, store.current, store.current);
}
