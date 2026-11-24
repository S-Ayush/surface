// This tab's own lifecycle changes (SPEC-015 §3.3 item 6, item 7; PLAN-015 S4): the archive page
// refreshes after the user's own delete, restore and purge confirmations, and drops a row at once
// when its restore is sent. The flows that dispatch them (`delete-flow.ts`, `restore-flow.ts`,
// `purge-flow.ts`) say so here; nothing waits for a packet, because a connection that doesn't
// subscribe to the issue's team may never get one.

export type LifecycleEvent =
  /** `issue.restore` was handed to the store: the row leaves the archive list at once. */
  | { readonly kind: 'restoring'; readonly issueId: string }
  /** The server confirmed the change. */
  | {
      readonly kind: 'confirmed';
      readonly op: 'delete' | 'restore' | 'purge';
      readonly issueId: string;
    }
  /** The server refused it, or the store didn't take it: the row comes back on a refresh. */
  | {
      readonly kind: 'refused';
      readonly op: 'delete' | 'restore' | 'purge';
      readonly issueId: string;
    };

export class LifecycleEvents {
  readonly #listeners = new Set<(event: LifecycleEvent) => void>();

  emit(event: LifecycleEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }

  subscribe(listener: (event: LifecycleEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}

/** The tab's one channel. */
export const lifecycleEvents = new LifecycleEvents();
