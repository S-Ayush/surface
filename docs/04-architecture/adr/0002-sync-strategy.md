# ADR-0002: Sync strategy

Status: **Accepted (draft)** · Date: 2026-11-06

## Context
Speed is the product (VISION §4). The UI must read from local memory and never wait on the network. We need offline tolerance, real-time updates, private-team isolation, and one write path for the UI, API, and MCP.

## Options
1. **Build our own engine**, Linear-style but simplified
2. Zero (Rocicorp)
3. Replicache
4. ElectricSQL / PowerSync
5. A conventional REST/GraphQL API with cache and invalidation (TanStack Query)

## Decision
**Option 1**, a custom engine with these properties:
- **Server-authoritative.** Postgres is the source of truth, and a global, commit-ordered `lastSyncId` orders every change (sync-log appends are serialised with an advisory lock).
- **Intent-level mutations.** Clients send *operations* from the Operation Registry, not row diffs. The client applies them optimistically and rebases pending mutations when deltas arrive (a Replicache-style model).
- **Full-row deltas** over WebSocket, filtered by **sync groups** (`workspace`, `team:<id>`, `user:<id>`).
- **Full metadata replica + lazy content.** All metadata is loaded at bootstrap. Heavy content (descriptions, comments, history, document bodies) is fetched per parent on demand, cached in IndexedDB, and prefetched.

Full protocol: [`sync-protocol.md`](../sync-protocol.md).

## Why not the alternatives
- **Zero / Replicache / Electric / PowerSync:** each adds an extra service or a licence and imposes its own data model. None of them makes the Operation Registry the single write path for UI, API, and MCP. Owning the engine is also part of this project's learning goal.
- **Request/response with a cache:** it cannot meet the < 50 ms interaction budget or offline reads.

## Revision to VISION §4
VISION assumed *everything* on every client. At the reference scale (100k issues, 500k comments and history entries), full content would mean hundreds of MB in memory. We therefore replicate **all metadata** (≈ 35 MB raw, ≈ 6 MB gzipped) and load **content lazily**. Every list, board, filter, and title/ID search stays fully local. Only opening a not-yet-cached issue body may take one LAN request, and prefetching hides most of those.

## Consequences
+ Instant UI, offline reads of all metadata, real-time collaboration, one write path.
+ No extra infrastructure: just Postgres and the app.
− We own a complex subsystem. This is mitigated by building it first (M0), keeping the protocol small, and a property-based convergence test suite.
− Serialised sync-log appends cap write throughput. This is far above small-team needs and is monitored.
