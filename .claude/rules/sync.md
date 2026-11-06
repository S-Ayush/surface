---
paths:
  - 'packages/sync-client/**'
  - 'packages/sync-protocol/**'
  - 'apps/server/src/sync/**'
---

# Sync engine

Spec: `docs/06-specs/SPEC-002-sync-engine-v0.md`. Protocol: `docs/04-architecture/sync-protocol.md`. Decision: ADR-0002. This is the riskiest code in the product, so be conservative.

- **Ordering:** `lastSyncId` is global, gap-free and commit-ordered. It is allocated under `pg_advisory_xact_lock(SYNC_LOCK)` in the writing transaction. Don't introduce another way to allocate or write `sync_log` rows.
- **Server is authoritative:** the client writes base state only from server data (bootstrap, deltas). Optimistic state lives in the overlay, rebuilt from pending mutations.
- **Exactly-once:** every mutation carries `(clientId, seq)`. The server records it in `client_mutations` in the same transaction as the change. The client sends batches one at a time and never sends seq N+1 before N.
- **Deltas:** apply strictly in order. A `prev` mismatch means a gap, so reconnect and catch up. Never skip or reorder. Ignore any id ≤ `lastSyncId`.
- **Groups:** bootstrap, catch-up and live deltas are all filtered by the connection's sync groups. When a user's groups change, purge or resync per `permissions.md`. A leak across private teams is a severity-1 bug.
- **Protocol changes:** wire types live in `packages/sync-protocol` with Zod codecs, and `schemaHash` changes force a client resync. Update `sync-protocol.md` in the same change.
- **Tests are mandatory:** convergence and exactly-once property tests (fast-check, simulation harness) plus leak tests. Use deterministic seeds and fake timers, never real sleeps. Print failing seeds.
