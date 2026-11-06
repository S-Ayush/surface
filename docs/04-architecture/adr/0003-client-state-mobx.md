# ADR-0003: Client state with MobX

Status: **Accepted (draft)** · Date: 2026-11-06

## Context
The client holds about 150k observable records and must re-render only what changes, with fine-grained reactivity and cheap computed indexes.

## Options
1. **MobX** observable models + computed values
2. Zustand / Redux with normalised state and selectors
3. Signals (Preact signals / Solid)
4. TanStack Query cache

## Decision
MobX. Models are classes with observable fields, registered in an object pool (`Map<id, model>`), with computed back-references and incrementally maintained secondary indexes. React components use `observer`.

## Consequences
+ Precise re-renders without hand-written selectors. This approach is proven by Linear at a much larger scale.
+ Computed indexes (e.g. issues by status) update incrementally.
− Mutable-model discipline is required: all writes go through the store's apply functions, enforced by MobX strict mode.
