# ADR-0015: Client model immutability

Status: **Accepted (draft)** · Date: 2026-11-06 · Supersedes: the enforcement clause of [ADR-0003](0003-client-state-mobx.md)

## Context
ADR-0003 chose MobX for client state and said that the mutable-model discipline ("all writes go through the store's apply functions") is "enforced by MobX strict mode".

PLAN-002 S6 built the object pool differently. MobX 7 observable objects are always Proxy-backed, which adds a trap to every field read across about 150k rows. So instances are plain objects with one prototype getter per field, and each field is backed by a MobX atom that is created on first read. Instances are not MobX observables, so strict mode (`enforceActions`) never sees a write to them. The clause in ADR-0003 no longer describes what actually enforces the discipline.

Rule 3 in CLAUDE.md (the client writes base state only from server data; optimistic changes live in the overlay) still needs enforcing.

## Options
1. **Make instances MobX observables** so that strict mode applies. This costs a proxy on every read, and strict mode only warns at runtime.
2. **Rely on convention.** Document the rule and review for it. Nothing stops a component from mutating a row.
3. **Make writes impossible outside the pool**, at runtime and at the type level.

## Decision
Option 3. Reactivity stays MobX (atoms and `observer`), as ADR-0003 decided. Immutability is enforced by the pool, not by MobX strict mode:

- **Instances are frozen and getter-only.** Assigning a field throws a `TypeError` in strict-mode code, and nothing can be added to an instance.
- **Rows are deep-frozen** when they enter base or overlay (`applyBase`, `loadBase`, `setOverlay`). So are rows reached through `rowOf`, including `json` and `array` field values.
- **Views get a `ReadonlyPool`.** `SyncStore.pool` is typed as `ReadonlyPool` (`get`, `all`, `count`, `findBy`, `ref`, `backRef`). The writable `ObjectPool`, `updateInstance` and the storage classes are not exported from `@surface/sync-client`. Only the sync engine (bootstrap, delta apply in PLAN-002 S7, the overlay engine in S8) writes to the pool.
- **Every pool write runs in one MobX action**, so reactions see whole batches. This is the part of strict mode that mattered.

## Consequences
+ A stray write fails loudly at the point of the bug, in development and in production. Strict mode only warned.
+ Field reads stay proxy-free, which keeps warm start of 10k rows within budget (SPEC-002 AC-8).
+ The public surface of `@surface/sync-client` is small and pinned by a test (`test/public-api.test.ts`).
− Freezing costs one pass over each incoming row. The warm-start perf test guards that cost.
− Code that needs a modified row must copy it (`{ ...rowOf(item), title }`). Mutation-shaped code moves to operations (PLAN-002 S8), where it belongs anyway.
− `ReadonlyPool` is a type-level restriction: the runtime object is still the `ObjectPool`. A deliberate cast could reach the writers, and review must catch that.
