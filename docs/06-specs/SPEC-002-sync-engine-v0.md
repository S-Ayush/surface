# SPEC-002: Sync engine v0

Status: **Accepted** (2026-11-06) · Milestone: **M0** · Date: 2026-11-06
Implements: ADR-0002 · [sync-protocol.md](../04-architecture/sync-protocol.md) §1–5, 7–10 · NFR-01, 02, 03, 06, 07, 08, 09
Depends on: SPEC-003 (Operation Registry & executor), SPEC-004 (repo and DB skeleton)
Unblocks: SPEC-001 and every later feature

---

## 1. Problem & goal

Every Surface feature assumes data is **local, live, and offline-tolerant**. v0 delivers the engine end to end for **eager models**, with the M0 demo as the bar:

> Rename a team in tab A, and tab B shows it in under 150 ms. Go offline, rename it again, reload the page (still offline), and the change persists. Come back online, and the change reaches the server and tab B.

## 2. Scope

**In scope (v0)**
- Server: `sync_log` with commit-ordered `sync_id`, the repo write layer, `client_mutations` idempotency, NOTIFY-driven hub
- `GET /sync/bootstrap` (full, NDJSON, eager models)
- `GET /sync/ws`: catch-up, live deltas, ping/pong, `resync`
- `POST /sync/mutate`: ordered, idempotent batches
- Sync groups `workspace` and `user:<id>` (the `team:<id>` plumbing is present and unit-tested; it is exercised in M7)
- Client: object pool (MobX), model registry and schema hash, IndexedDB persistence (worker), mutation queue, optimistic overlay and rebase, reconnect with backoff, offline mode, rejection handling
- **Sync inspector** dev panel
- **Simulation test harness** and the convergence property test

**Out of scope (later)**
| Item | Arrives in |
|---|---|
| Lazy **content** models (`/sync/content`, prefetch) | M1 (SPEC-011/013) |
| Undo / redo | M2 |
| Presence messages | M4 |
| `G` packets and partial bootstrap on group change | M7 (private teams) |
| BroadcastChannel cross-tab notifications | M1 (an optimisation; each tab has its own socket in v0) |

## 3. Flows

### 3.1 Cold start
1. Open IndexedDB `surface-<workspaceId>-<userId>`. It is missing or `schemaHash` differs.
2. `GET /sync/bootstrap` streams rows to the IDB worker in chunks of 1,000 rows, and populates the object pool.
3. On `end`, mark the store `ready`, then connect the WebSocket with `since = meta.lastSyncId`.

### 3.2 Warm start
1. IDB exists and `schemaHash` matches. Hydrate the object pool from IDB (in the worker; objects are transferred in chunks).
2. Re-apply the overlay from persisted pending mutations.
3. The UI becomes interactive, then the WebSocket connects with `since`. Catch-up deltas arrive, then the queue is flushed.

### 3.3 Local mutation
`dispatch(op, input)`:
1. Validate the input with the operation's Zod schema (client-side, fast fail).
2. Assign `seq = ++clientSeq` (persisted) and store the pending mutation in IDB.
3. Run `optimistic(store, input)` to update the overlay. MobX re-renders.
4. The flusher sends batches, one in flight at a time, in seq order.

### 3.4 Delta received
Apply packets in strict `id` order (detect gaps; see §8) → upsert/archive/delete into base and IDB → confirm the acked pending mutations → recompute the overlay for the affected models → update `meta.lastSyncId`.

### 3.5 Rejection
The mutation result has `status = error`. Remove it from the queue, recompute the overlay (the optimistic effect disappears), show a toast with `error.message`, and log it in the inspector.

### 3.6 Offline and reconnect
- The socket closes or pings fail, so the state becomes `offline`. Mutations keep queueing (state `queued`).
- Reconnect uses backoff from 0.5 s to 30 s with jitter, and retries immediately on the `online` event.
- On reconnect: `since = lastSyncId` → catch-up → flush the queue.

## 4. Server design

### 4.1 Tables
```sql
CREATE TABLE sync_log (
  sync_id     bigint PRIMARY KEY,           -- assigned under SYNC_LOCK, gap-free
  model       text   NOT NULL,
  model_id    uuid   NOT NULL,
  action      char(1) NOT NULL CHECK (action IN ('I','U','A','V','D')),
  data        jsonb,                        -- full row for I/U; null otherwise
  groups      text[] NOT NULL,
  client_id   uuid,                         -- origin, for acks
  client_seq  bigint,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sync_log_groups_gin ON sync_log USING gin (groups);

CREATE TABLE sync_state (id int PRIMARY KEY DEFAULT 1, last_sync_id bigint NOT NULL);  -- single row

CREATE TABLE client_mutations (
  client_id   uuid PRIMARY KEY,
  user_id     uuid NOT NULL,
  last_seq    bigint NOT NULL,
  last_results jsonb NOT NULL,              -- results of the last batch, for idempotent replay
  updated_at  timestamptz NOT NULL
);
```
Every synced domain table has a `sync_groups text[] NOT NULL` column.

### 4.2 Repo write layer (the only writer of synced tables)
```ts
repo.insert(tx, Model, row)    // computes groups, writes row, buffers ('I', row)
repo.update(tx, Model, id, patch)  // writes, reads back full row, buffers ('U', row)
repo.archive / unarchive / purge
// at end of executor transaction:
repo.flushSyncLog(tx, {clientId, seq})
  → SELECT pg_advisory_xact_lock(SYNC_LOCK)
  → UPDATE sync_state SET last_sync_id = last_sync_id + n RETURNING last_sync_id
  → INSERT INTO sync_log … (ids last-n+1 … last)
```
A lint rule and a test forbid direct `db.insert/update/delete` on synced tables outside `repo`.

### 4.3 Broadcast hub
- After commit, run `NOTIFY sync, '<last_sync_id>'`.
- The hub keeps `broadcastedUpTo`. On notify, it reads `sync_log WHERE sync_id > broadcastedUpTo ORDER BY sync_id`. For each connection it filters by `groups && connection.groups`, batches up to 500 packets, and attaches `ack` entries for that connection's `clientId`.
- **Catch-up for a new connection:** stream from `since` to the current `broadcastedUpTo` (with the same filter), then join live delivery. Live packets that arrive during catch-up are buffered for that connection to avoid races.
- If `since` < the oldest retained `sync_id` → `resync(too_old)`. If the client's `schemaHash` ≠ the server's → `resync(schema)`.

### 4.4 Mutate endpoint
- Authenticate the session, verify that `clientId` belongs to the user (the first use registers it), and check that `schemaHash` matches (`CLIENT_OUTDATED` if not).
- Mutations with `seq ≤ last_seq` get their stored result (idempotent). Processing starts at `last_seq + 1`. A gap (`seq > last_seq + 1`) → `400 SEQ_GAP`, and the client resends from `last_seq + 1`.
- Each mutation runs in its own executor transaction. `client_mutations` is updated in the **same transaction** as the mutation, so the dedupe record is never out of step with the data.

## 5. Client design

### 5.1 Packages and modules
```
packages/sync-client/
  model-registry.ts     defineModel(name, {fields, refs, load: 'eager'|'content'}) → schemaHash
  object-pool.ts        Map<model, Map<id, ModelInstance>>; observable instances
  indexes.ts            incremental secondary indexes (declared per model)
  idb/worker.ts         IndexedDB access off main thread (stores: rows per model, meta, pending)
  bootstrap.ts          NDJSON stream reader → worker chunks → pool
  socket.ts             WS lifecycle, ping/pong, backoff, gap detection
  queue.ts              pending mutations, seq, flusher, results handling
  overlay.ts            base ⊕ optimistic(pending) recomputation
  dispatch.ts           dispatch(op, input) entry point, typed from packages/operations
  inspector/            dev panel
```

### 5.2 Base vs overlay
- `base: Map<id, Row>` holds only server data. It is persisted to IDB.
- `overlay` is computed by running the pending mutations' `optimistic()` against a **draft** of the touched rows.
- Model instances read `overlay ?? base`. Recomputation is scoped to the IDs touched by the pending mutations and the incoming packets.

### 5.3 Model definition (example)
```ts
export const Team = defineModel("Team", {
  load: "eager",
  fields: { key: str(), name: str(), icon: str().nullable(), color: str(), timezone: str(), private: bool() },
  refs: { memberships: backRef("TeamMembership", "teamId") },
  indexes: ["key"],
});
```

### 5.4 Sync inspector (dev builds, plus `?debug=sync` in prod for Admins)
Shows connection state, `lastSyncId`, server lag, the pending queue (op, seq, state, age), recent packets, rejections, row counts per model, IDB size, and a "Force resync" button.

## 6. Operations used by v0 demos
`team.update` (rename) and `user.updateProfile`, with their `optimistic()` implementations. v0 includes a test-only operation `debug.touch` to drive the simulation.

## 7. UI
Minimal: an **offline indicator** (top bar pill "Offline · N changes pending"), a **rejection toast**, a **"Surface was updated, reload"** banner on `CLIENT_OUTDATED`, and a **bootstrap progress** bar on cold start (rows / total).

## 8. Edge cases

| # | Case | Behaviour |
|---|---|---|
| E1 | A delta gap is detected (packet id ≠ last + 1 for the user's filtered stream) | Filtered streams legitimately skip IDs, so the hub sends `prev` (the previous id *for this connection*) on each batch. If `prev ≠ lastSyncId`, close and reconnect with `since = lastSyncId`. |
| E2 | Duplicate packet after reconnect | Ignored (`id ≤ lastSyncId`) |
| E3 | Server restart while a batch is in flight | The client retries the same batch. The server dedupes by seq. |
| E4 | The client crashes after sending but before the ack is persisted | On restart the pending mutations are resent and deduped, and the stored results are returned |
| E5 | Two tabs of the same user | Separate `clientId`s and queues. Both receive all deltas. |
| E6 | IDB quota exceeded or IDB unavailable (private mode) | Fall back to a memory-only store, with a warning banner. Offline persistence is disabled. |
| E7 | `schemaHash` changes on deploy | Connected clients get `resync(schema)`, show the "reload" banner, and on reload the IDB is cleared and bootstrapped again |
| E8 | A very long offline period (> 30 days) | `resync(too_old)` → re-bootstrap, then **flush the queue**. Pending mutations survive the re-bootstrap. |
| E9 | A mutation references a row deleted by the server meanwhile | Rejected with `NOT_FOUND` → rollback and toast |
| E10 | A session is revoked mid-session | Socket closed with `4001` → redirect to login. The queue is kept (keyed by user). |
| E11 | Clock skew on the client | Irrelevant: ordering comes only from the server's `sync_id`, and `at` is informational |

## 9. Acceptance criteria

| AC | Criterion | Test |
|---|---|---|
| AC-1 | **Ordering:** 20 concurrent writers × 500 mutations each produce `sync_id`s that are gap-free and in commit order (verified by replaying `sync_log`). | integration (stress) |
| AC-2 | **Convergence property:** fast-check with 3–6 simulated clients, random ops, and random network faults (delay, drop, reorder, disconnect, server restart). After quiescence, every client's base state equals the server DB, and its overlay is empty. Runs 1,000 cases in CI. | simulation |
| AC-3 | **Exactly-once:** across random client crashes and resends, every dispatched mutation is applied exactly once (verified via the `debug.touch` counter). | simulation |
| AC-4 | **Real time:** a rename in tab A is visible in tab B in **< 150 ms p95** (LAN, 100 trials). | e2e perf |
| AC-5 | **Optimistic:** the UI reflects a local rename in **< 16 ms** (the same frame) after dispatch. | e2e perf |
| AC-6 | **Offline persistence:** offline, then rename, then reload while still offline: the rename is shown. Online again: the server gets it and tab B updates. | e2e |
| AC-7 | **Rejection:** a mutation the server rejects reverts in the UI within one round-trip and shows a toast. The base state is unchanged. | e2e |
| AC-8 | **Warm start** with 10k rows is interactive in **< 1.5 s**. **Cold bootstrap** of the reference-scale eager data (≈ 150k rows) completes in **< 10 s** on a LAN. | perf |
| AC-9 | **Catch-up:** a client offline for 1,000 server changes catches up correctly on reconnect, with no duplicates and no gaps. | integration |
| AC-10 | **Resync:** a schema mismatch and a too-old `since` both trigger re-bootstrap, and pending mutations survive it. | integration |
| AC-11 | **Group filtering:** with a fixture that has rows in `team:X`, a client without that group receives none of them in bootstrap, catch-up, or live deltas. | integration |
| AC-12 | **Repo enforcement:** a CI test fails if any code writes to a synced table outside `repo`. | CI |
| AC-13 | The sync inspector shows the queue, `lastSyncId`, and connection state accurately during AC-6. | manual / e2e |

## 10. Metrics & performance

| Metric | Budget | Where |
|---|---|---|
| Commit → broadcast lag | p95 < 20 ms | Server metric `sync_broadcast_lag_ms` |
| `/sync/mutate` server time | p95 < 30 ms per mutation | Server metric |
| Delta apply (100 packets) on the client | < 5 ms | Client perf mark |
| Sync-log lock hold time | p95 < 2 ms | Server metric |
| Bootstrap throughput | ≥ 20k rows/s on the client | Perf suite |

## 11. Decisions (open questions resolved with the proposed defaults, 2026-11-06)

| # | Question | Decision |
|---|---|---|
| Q1 | Should mutations go over the WebSocket instead of HTTP POST? | HTTP in v0 (simpler retries and debugging). Revisit if latency matters. |
| Q2 | Should the sync-log `data` column hold full rows or diffs? | Full rows (idempotent upserts). Revisit if log size becomes a problem. |
| Q3 | Should the hub run per process or as a dedicated role? | Per process, with NOTIFY fan-out, so a multi-process setup works too |
