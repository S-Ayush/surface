/** A row in the client store, as `optimistic()` sees it. */
export type StoreRow = Readonly<Record<string, unknown>>;

/**
 * What `optimistic(store, input)` may touch (SPEC-003 §8). The client store implements it
 * over the overlay (PLAN-002 S8): reads see base + overlay, and writes go to the overlay only.
 * `ref` is any form the model's reference type accepts (an id, `ENG`, `me`, …); the store
 * resolves it with the client resolvers.
 */
export interface OptimisticStore {
  /** Fixed for the whole mutation. Use it instead of `Date.now()` so replays are deterministic. */
  readonly now: Date;
  get(model: string, ref: string): StoreRow | undefined;
  patch(model: string, ref: string, changes: StoreRow): void;
  /** New rows carry a client-generated UUIDv7 `id` (SPEC-003 §8). */
  insert(model: string, row: StoreRow & { readonly id: string }): void;
  archive(model: string, ref: string): void;
  remove(model: string, ref: string): void;
}
