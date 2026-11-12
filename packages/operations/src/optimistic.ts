/** A row in the client store, as `optimistic()` sees it. */
export type StoreRow = Readonly<Record<string, unknown>>;

/**
 * What `optimistic(store, input)` may touch (SPEC-003 §8). The client store implements it
 * over the overlay (PLAN-002 S8): reads (`get`, `find`) see base + overlay, and writes go to the
 * overlay only.
 * `ref` is any form the model's reference type accepts (an id, `ENG`, `me`, …); the store
 * resolves it with the client resolvers.
 */
export interface OptimisticStore {
  /** Fixed for the whole mutation. Use it instead of `Date.now()` so replays are deterministic. */
  readonly now: Date;
  get(model: string, ref: string): StoreRow | undefined;
  /**
   * The rows of `model` whose fields equal every value in `fields` (strict equality), for rows
   * that neither an id nor a reference names, e.g. a membership by team and user:
   * `store.find('TeamMembership', { teamId, userId })`. Sees what `get` sees: base plus the
   * pending mutations so far, archived rows included, deleted ones not. Empty for a model the
   * client doesn't hold.
   */
  find(model: string, fields: StoreRow): readonly StoreRow[];
  patch(model: string, ref: string, changes: StoreRow): void;
  /** New rows carry a client-generated UUIDv7 `id` (SPEC-003 §8). */
  insert(model: string, row: StoreRow & { readonly id: string }): void;
  archive(model: string, ref: string): void;
  remove(model: string, ref: string): void;
}
