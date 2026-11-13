// Which groups of an issue list the user collapsed or expanded (SPEC-012 §3.3 item 3, D16): kept
// per list and device in `localStorage`. Storage can be missing or throw (a private window,
// blocked site data), so every access is wrapped and the list works without it.
import { z } from 'zod';
import type { CollapseState } from './list-model.js';

const stored = z.record(z.string(), z.boolean());

/** The part of `Storage` used, so tests pass a fake. */
export type CollapseStorage = Pick<Storage, 'getItem' | 'setItem'>;

const storageKey = (listKey: string) => `surface:list-collapse:${listKey}`;

export function browserStorage(): CollapseStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readCollapse(storage: CollapseStorage | undefined, listKey: string): CollapseState {
  try {
    const raw = storage?.getItem(storageKey(listKey));
    if (raw === null || raw === undefined) return {};
    const parsed = stored.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function writeCollapse(
  storage: CollapseStorage | undefined,
  listKey: string,
  state: CollapseState,
): void {
  try {
    storage?.setItem(storageKey(listKey), JSON.stringify(state));
  } catch {
    // Not kept: the list still works for this visit.
  }
}
