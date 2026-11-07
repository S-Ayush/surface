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
- On reconnect: `since = lastSyncId` → catch-up, and the queue flushes as soon as the socket is open. A mutation is confirmed only once the replica reaches its commit (or its `ack` arrives), so sending during catch-up is safe.

## 4. Server design

### 4.1 Tables
```sql
CREATE TABLE sync_log (
  sync_id     bigint PRIMARY KEY,           -- assigned under SYNC_LOCK, gap-free
  model       text   NOT NULL,
  model_id    uuid   NOT NULL,
  action      char(1) NOT NULL CHECK (action IN ('I','U','A','V','D')),
  data        jsonb,                        -- full row for I/U/A/V; null for D (Q4)
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
- `flush` with nothing buffered takes no lock and writes nothing, so queries and no-op mutations never wait on `SYNC_LOCK`.
- When an update changes a row's groups, the repo logs `D` with the **old** groups, then `U` with the new ones, under consecutive ids (Q5). Clients filter packets by `groups && clientGroups` only, so that is how users who lose sight of the row drop it and users who gain it get it.
- The lock is held from `pg_advisory_xact_lock` to commit. The executor records the hold time as `surface_sync_lock_hold_seconds` (§10).

A lint rule (`surface/no-synced-table-writes`) forbids direct `db.insert/update/delete` and raw SQL writes on synced tables outside `repo`, and in tests a write audit fails any mutation that wrote a synced row it didn't log (AC-12).

### 4.3 Broadcast hub
- After commit, `NOTIFY sync, '<last_sync_id>'` reaches the hub. `flush` queues it in the writing transaction (`pg_notify`), and Postgres sends it at commit and drops it on rollback, so the hub never reads ahead of the log.
- The hub keeps `broadcastedUpTo`. On notify, it reads `sync_log` from `broadcastedUpTo` up to `sync_state.last_sync_id`, so each delivery ends at a transaction boundary. For each connection it filters by `groups && connection.groups`, batches up to 500 packets, and attaches `ack` entries for that connection's `clientId` to the last message of the delivery, after all of its packets.
- A batch (and a catch-up page) never separates a `D` from the packet for the same row that directly follows it, so a groups change (Q5) reaches users who keep the row in one batch.
- Rows go out with `syncGroups` intersected with the connection's groups, in bootstrap and in deltas (Q6).
- **Catch-up for a new connection:** stream from `since` to the current `broadcastedUpTo` (with the same filter, plus the connection's own mutations for their acks, read without their data or groups), a page at a time, then join live delivery. Each page is its own short read, so a slow client holds no database connection; every row up to `broadcastedUpTo` is committed, so no snapshot needs to span the pages. After each page the hub checks that the log still holds the next row (a prune that overtook it → `resync(too_old)`). Live packets that arrive during catch-up are buffered for that connection to avoid races. Catch-up goes at the client's pace: it waits while more than 1 MiB is queued on the socket.
- If `since + 1` < the oldest retained `sync_id`, or `since` is ahead of the server's head (Q10) → `resync(too_old)`. If the client's `schemaHash` ≠ the server's → `resync(schema)`. After a `resync` the hub sends nothing more on that connection but pings; the client closes it.
- **Who:** as bootstrap (Q9). While the server starts or stops → `503` with `Retry-After`; an `Origin` header other than `SURFACE_URL`'s origin → `403` (browsers don't apply CORS to WebSockets, so this stops another site from opening the socket with the user's cookie; clients that send no `Origin` are judged by their credentials alone); an API key → `403`; invalid connect parameters → `400`, all before the upgrade. Nobody signed in → the upgrade is accepted and closed with `4001` (E10).
- **Liveness and limits:** a `ping` every 25 s; no `pong` within 10 s ends the connection. Each ping round also reads the log, so a lost notification (or a failed read) delays delivery by at most 25 s. A live client with more than 8 MiB queued on its socket is ended without a closing handshake (the client sees `1006`); a client whose live backlog passes 50,000 rows while it catches up is closed with `1013`. Both reconnect and catch up. On shutdown every connection is closed with `1012`.
- **Retention:** the daily `synclog-prune` job deletes the oldest rows, up to the first row younger than 30 days. It deletes a prefix of the log, never rows in between (row times are not strictly in id order), so catch-up never skips a hole. It always keeps the newest row, whose id tells the hub how far back catch-up can reach.

### 4.4 Mutate endpoint
- Authenticate the session, verify that `clientId` belongs to the user (the first use registers it), and check that `schemaHash` matches (`CLIENT_OUTDATED` if not).
- A signed-in browser sends the CSRF token in `X-CSRF-Token` (SPEC-001 §6.1, Q7; pending until PLAN-001 S3 is on `main`). `403 CSRF_INVALID` makes the client renew the cookie through `GET /auth/session` and resend once; refused again, or with no session to renew, it backs off like any failure (sync-protocol.md §4.4).
- Mutations with `seq ≤ last_seq` get their stored result (idempotent). Processing starts at `last_seq + 1`. A gap (`seq > last_seq + 1`) → `400 SEQ_GAP`, and the client resends from `last_seq + 1`.
- Each mutation runs in its own executor transaction. `client_mutations` is updated in the **same transaction** as the mutation, so the dedupe record is never out of step with the data.

### 4.5 Bootstrap endpoint (PLAN-002 S3)
- **Who:** signed-in users only. Nobody signed in → `401`; while the server starts → `503` with `Retry-After`; an API key → `403`, because its team limits (permissions.md §3.5) are not sync groups (Q7). `?groups=` (partial bootstrap) → `400` until group changes arrive in M7.
- **Snapshot:** one `REPEATABLE READ READ ONLY` transaction. `lastSyncId` is `sync_state.last_sync_id`, which equals `max(sync_id)` in the snapshot because both change in every writing transaction. The rows are counted (`meta.rows`), then streamed through a server-side cursor, 1,000 per fetch, as fast as the response is written. A client that hangs up ends the transaction.
- **Rows:** the eager models of the sync registry, filtered by `sync_groups && actorGroups` in SQL. Each row is projected to the client model: its declared fields only, instants as ISO strings with milliseconds, and the declared `groups` field cut to the actor's groups (Q6). Archived rows carry `"archived": true`.
- **Registry:** built from the shared definitions in `@surface/domain/model`, so the server's `schemaHash` is the client's. Engine fixtures (`DebugItem`) are left out in production, as internal operations are (Q8). A declared field without a column fails at startup.
- **Encoding:** gzip when `Accept-Encoding` allows it (`node:zlib`), `Cache-Control: no-store`.

## 5. Client design

### 5.1 Packages and modules
```
packages/domain/src/model/   defineModel(name, {load, fields, refs, indexes}): shared with the server registry
packages/sync-protocol/      computeSchemaHash(models), wire codecs
packages/sync-client/
  pool.ts, instance.ts  Map<model, Map<id, ModelInstance>>; per-field observable, frozen instances, base + overlay (ADR-0015)
  indexes.ts            incremental secondary indexes (declared per model, or implied by a backRef)
  storage/              SyncStorage: IndexedDB (worker.ts, rpc.ts), memory fallback; stores: rows per model, meta, pending
  bootstrap.ts          NDJSON stream reader → storage chunks → pool
  hydrate.ts, store.ts  warm start; start-up sequence and status
  persistence.ts        storage failure handling: fenced generation vs lost storage (E5, E6)
  locks.ts              cross-tab replica lock (Web Locks: shared to hydrate, exclusive to bootstrap; E5)
  socket.ts             WS lifecycle, ping/pong, silence watchdog, backoff, online event, close codes
  deltas.ts             delta apply plan: gap (E1), duplicates (E2), G → resync; rows validated first
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
| E1 | A delta gap is detected (packet id ≠ last + 1 for the user's filtered stream) | Filtered streams legitimately skip IDs, so the hub sends `prev` (the previous id *for this connection*) on each batch. If `prev > lastSyncId`, the client missed packets: it applies nothing from that message, closes, and reconnects with `since = lastSyncId`. If `prev ≤ lastSyncId`, the message overlaps what the client has: it skips packets with `id ≤ lastSyncId` (E2) and applies the rest (sync-protocol.md §4.3). |
| E2 | Duplicate packet after reconnect | Ignored (`id ≤ lastSyncId`) |
| E3 | Server restart while a batch is in flight | The client retries the same batch. The server dedupes by seq. |
| E4 | The client crashes after sending but before the ack is persisted | On restart the pending mutations are resent and deduped, and the stored results are returned |
| E5 | Two tabs of the same user | Separate `clientId`s and queues. Both receive all deltas. A queue outlives its tab: another tab adopts a queue no open tab owns, so a reload resends under the same `clientId` (E4). With Web Locks (a lock per queue) the next tab to start adopts it at once. Without them (plain-HTTP origins) the owner renews a lease every 5 s; a queue whose lease lapsed (15 s) is adopted only if it still has pending mutations, at start or on a later renewal by a tab whose own queue is empty, so a reload picks its queue up within 15 s. A tab whose queue was adopted while it was still open (its timers were frozen) starts a new queue if it had nothing pending, and otherwise stops and asks for a reload. |
| E6 | IDB quota exceeded or IDB unavailable (private mode) | Fall back to a memory-only store, with a warning banner. Offline persistence is disabled. |
| E7 | `schemaHash` changes on deploy | Connected clients get `resync(schema)`, show the "reload" banner, and on reload the IDB is cleared and bootstrapped again |
| E8 | A very long offline period (> 30 days) | `resync(too_old)` → re-bootstrap, then **flush the queue**. Pending mutations survive the re-bootstrap. |
| E9 | A mutation references a row deleted by the server meanwhile | Rejected with `NOT_FOUND` → rollback and toast |
| E10 | A session is revoked mid-session, or while the client is offline | Socket closed with `4001` → redirect to login. On reconnect without a valid session the hub accepts the upgrade and closes with `4001` too (sync-protocol.md §4.3). The queue is kept (keyed by user). |
| E11 | Clock skew on the client | Irrelevant: ordering comes only from the server's `sync_id`, and `at` is informational |
| E12 | A row fails client validation although `schemaHash` matches (a server/client disagreement) | Nothing from that message is applied, and the client reconnects. After 3 rejections at the same `lastSyncId` it re-bootstraps. If the snapshot has the bad row too, the store goes `failed`, keeps the error for the inspector, and stops retrying until a reload. |
| E13 | The server accepts the bootstrap request but never answers (a hung proxy, a stalled server) | After 30 s without a response the client gives up (sync-protocol.md §4.1). A cold start fails with "The server did not answer within 30 seconds. Check your connection and try again.", and the app offers to try again; a resync retries once the socket reconnects. Rows that have started streaming have no deadline. |

## 9. Acceptance criteria

> **Held (2026-11-06): tests that need a browser, a running stack or Postgres are not written for now** (D1 in §11): criteria whose test is `e2e`, `e2e perf`, `perf`, `smoke`, `manual / e2e` or `integration` are held until the hold is lifted. Still written: unit and property tests, the sync property suite (SPEC-002 AC-2/AC-3) and private-team leak tests (SPEC-002 AC-11, `permissions.md` §5).

| AC | Criterion | Test |
|---|---|---|
| AC-1 | **Ordering:** 20 concurrent writers × 500 mutations each produce `sync_id`s that are gap-free and in commit order (verified by replaying `sync_log`). | integration (stress) |
| AC-2 | **Convergence property:** fast-check with 3–6 simulated clients, random ops, and random network faults (delay, drop, reorder, disconnect, server restart). After quiescence, every client's base state equals the server DB, and its overlay is empty. Runs 1,000 cases in CI. | simulation |
| AC-3 | **Exactly-once:** across random client crashes and resends, every dispatched mutation that was stored in the replica (§3.3 step 2) is applied exactly once (verified via the `debug.touch` counter). A crash before that may lose it. | simulation |
| AC-4 | **Real time:** a rename in tab A is visible in tab B in **< 150 ms p95** (LAN, 100 trials). | e2e perf |
| AC-5 | **Optimistic:** the UI reflects a local rename in **< 16 ms** (the same frame) after dispatch. | e2e perf |
| AC-6 | **Offline persistence:** offline, then rename, then reload while still offline: the rename is shown (on plain-HTTP origins, without Web Locks, within 15 s of the reload; E5). Online again: the server gets it and tab B updates. | e2e |
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
| Commit → broadcast lag | p95 < 20 ms | Server metric `surface_sync_broadcast_lag_seconds` (notification received → rows handed to every connection) |
| `/sync/mutate` server time | p95 < 30 ms per mutation | Server metric |
| Delta apply (100 packets) on the client | < 5 ms | Client perf mark |
| Sync-log lock hold time | p95 < 2 ms | Server metric `surface_sync_lock_hold_seconds`; no automated test (D2) |
| Bootstrap throughput | ≥ 20k rows/s on the client | Perf suite |

## 11. Decisions (open questions resolved with the proposed defaults, 2026-11-06)

| # | Question | Decision |
|---|---|---|
| Q1 | Should mutations go over the WebSocket instead of HTTP POST? | HTTP in v0 (simpler retries and debugging). Revisit if latency matters. |
| Q2 | Should the sync-log `data` column hold full rows or diffs? | Full rows (idempotent upserts). Revisit if log size becomes a problem. |
| Q3 | Should the hub run per process or as a dedicated role? | Per process, with NOTIFY fan-out, so a multi-process setup works too |
| Q4 | (2026-11-06, PLAN-002 S2) What does `data` hold for archive and unarchive? | The full row, like I and U. An unarchive must be able to re-insert a row a client dropped (archived rows need not be in the eager set), and full rows keep every non-delete packet an idempotent upsert. |
| Q5 | (2026-11-06, PLAN-002 S2) How does a change of a row's groups reach clients? | Two packets with consecutive ids: `D` with the old groups, then `U` with the new ones. Users who see both delete and re-insert (one batch); users who only saw the old groups delete; users who only see the new groups upsert. This keeps the hub's filter a plain `groups && clientGroups`. |
| Q6 | (2026-11-06, PLAN-002 S2 review) Which of a row's groups does a client receive? | Only the ones it is in: bootstrap and the hub send `syncGroups` intersected with the connection's groups. The client needs a row's groups to purge it when it leaves a team (sync-protocol §6) and for `p.canSee`, and the intersection answers both. The full list could name a private team the user isn't in (a project shared by several private teams). `sync_log.data` keeps the full list: it is server-only. |
| Q7 | (2026-11-07, PLAN-002 S3) Who may bootstrap? | Signed-in users only; an API key gets `403`. Sync filters by sync groups, and an API key limited to some teams sees public teams' rows through `workspace`, so a bootstrap would hand it rows outside its teams (permissions.md §3.5, §5 item 8). Keys read through the operations API, which applies the team limit. |
| Q8 | (2026-11-07, PLAN-002 S3) How does a row's visibility reach the client, and which models count in the schema hash? | A model that declares a `groups` field receives the row's `sync_groups` there, cut to the connection's groups (Q6); other models get no groups. The registry, and so the hash, includes engine fixtures (`DebugItem`) only outside production, matching `allowInternal`, so a production client's model list never needs the fixture. |
| Q9 | (2026-11-07, PLAN-002 S4) Who may open the WebSocket? | The same actors as bootstrap (Q7): signed-in users. An API key gets `403` before the upgrade, because its team limits are not sync groups. Only a missing session is answered after the upgrade, with `4001` (E10), because a browser can't read a refused upgrade's status. |
| Q10 | (2026-11-07, PLAN-002 S4) What if a client's `since` is ahead of the server's head? | `resync(too_old)`. It happens after the database is restored from a backup, when the client holds rows the server no longer has; a full bootstrap makes it match the server again. A `since` ahead of `broadcastedUpTo` but not of the head is normal (the bootstrap read a newer head than the hub has delivered) and is not a resync. The check is best effort: once the restored database has written past the client's `since`, the ids overlap and it can't tell. A database epoch id in `sync_state`, checked on connect, would close that gap (Later). |
| D1 | (2026-11-06) Write e2e (Playwright), smoke and integration tests now? | No, by decision of the user, for faster development; they are added later. Tests that need a browser, a running stack or Postgres (`e2e`, `e2e perf`, `perf`, `smoke`, `manual / e2e`, `integration`) are **held**: no test is written for them yet, and the slice notes in "As built" whether the behaviour was checked by hand. Not held: unit and property tests (including the unit parts listed for held criteria), the sync property suite (SPEC-002 AC-2/AC-3) and private-team leak tests (SPEC-002 AC-11, `permissions.md` §5), which may use Postgres. Existing integration tests are kept. See [plans README §6](../07-plans/README.md#6-testing-hold-e2e-smoke-and-integration). |
| D2 | (2026-11-07, by decision of the user) Keep the test that asserts the sync-lock budget (`sync-lock.perf.int.test.ts`)? | No, it was removed. It failed in a full `pnpm test:int` while several sessions shared the machine (0–55 % of holds under 2 ms) and passed when run alone. The budget in §10 stands and is read from the server metric. |

### Changes after acceptance

| Date | Change | Why |
|---|---|---|
| 2026-11-06 | **E1:** `prev > lastSyncId` is a gap (reconnect); `prev ≤ lastSyncId` skips packets with `id ≤ lastSyncId` and applies the rest. It used to say `prev ≠ lastSyncId` means reconnect. **E10:** also covers a session revoked while offline: the hub accepts the upgrade and closes with `4001`. **E12** added. | PLAN-002 S7 reviews. An overlapping or resent message is harmless, so reconnecting on it only adds churn. A browser cannot see a refused upgrade's status, so a `401` would make the client retry forever. A bad row used to make the client reconnect forever with no visible error. Protocol side: [sync-protocol.md](../04-architecture/sync-protocol.md) v0.4. Approved by the user. |
| 2026-11-06 | **§3.6:** the queue flushes once the socket is open, not after catch-up. **E5:** queues are adopted by the next tab (Web Lock, or a 15 s lease). | PLAN-002 S8. The protocol has no "caught up" signal, and confirmation already waits for the replica to reach each commit, so the order does not matter. Without adoption, a reload would leave its queue behind, and E4's resend under the same `clientId` could not happen. Decided at the start of S8 (the user chose Web Locks + lease). Approved by the user after the S8 review. |
| 2026-11-06 | **E5:** without Web Locks, only queues with pending mutations are adopted, also on later lease renewals; a tab whose empty queue was taken carries on with a new one. **AC-6:** qualified for plain-HTTP origins (within 15 s). | PLAN-002 S8 review (M1). A reload there may not end its lease, so the reloaded tab first starts a new queue; adopting on renewal makes the offline rename reappear within 15 s instead of never in that session. Adopting empty queues fenced frozen tabs for nothing. Approved by the user after merge (2026-11-07). |
| 2026-11-07 | **§4.5** (bootstrap) added; decisions **Q7** (API keys get `403` on bootstrap) and **Q8** (a row's groups travel in the model's `groups` field; engine fixtures count in the registry and schema hash only outside production). | PLAN-002 S3. §4 did not say who may bootstrap or how a row's visibility reaches the client, and the hash had to match a client whose model list leaves the fixture out in production. Approved by the user after the S3 review (2026-11-07). |
| 2026-11-07 | **AC-3:** qualified to mutations stored in the replica. | PLAN-002 S9 review (m1). The simulation now crashes tabs between storage calls, also after a dispatch but before its mutation is stored; no engine can keep a mutation it never wrote down. A stored mutation is never lost or applied twice. Approved by the user (2026-11-07). |
| 2026-11-07 | **E13** added: a bootstrap with no response within 30 s is abandoned. | PLAN-002 S9 second review. The sync simulation found a hung bootstrap leaving a tab loading for good: a cold start never failed, so the app's "Try again" never showed, and a stuck resync blocked every later start and resync. Same deadline as a mutate request. Approved by the user (2026-11-07). |
| 2026-11-07 | **§4.4:** the mutate request carries the CSRF token; `403 CSRF_INVALID` renews it once. | PLAN-001 S3 adds CSRF to every cookie-authenticated unsafe request (SPEC-001 §6.1, Q7, proposed by session A). Without the header every mutation would be refused and retried forever once S3 and S5 are on `main`. Client side in the PLAN-002 S8 follow-up (CSRF). Approved by the user (2026-11-07). |
