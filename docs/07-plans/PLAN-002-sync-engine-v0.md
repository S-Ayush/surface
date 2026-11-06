# PLAN-002: Sync engine v0

Implements: [SPEC-002](../06-specs/SPEC-002-sync-engine-v0.md) · Protocol: [sync-protocol.md](../04-architecture/sync-protocol.md) · Status: **Ready** · Order: **3rd** · Depends on: PLAN-003 S4 (executor), PLAN-004 S3 (DB)

> **Engine fixture:** until real models exist (PLAN-001), the engine is built and tested against an internal **`DebugItem`** model (`id`, `title`, `counter`, `groups`) with ops `debug.create`, `debug.rename`, `debug.touch`, `debug.delete` (all `internal`, dev/test builds only). The M0 demo ACs (team rename) are verified in S10 after PLAN-001 S8.

---

## 1. Slices

### S1: `packages/sync-protocol` · S
- Wire types and Zod codecs: bootstrap frames (`meta`, `row`, `end`), WebSocket messages (`deltas` with `prev` and `ack`, `resync`, `ping`/`pong`), mutate request and response.
- NDJSON stream encoder/decoder (works in a worker and in Node).
- `computeSchemaHash(modelDefs)`: a stable hash of the synced model names, fields, and types.
- **Tests:** round-trip codecs, a partial-chunk NDJSON decoder, schemaHash stability.

### S2: Sync tables & repo layer (server) · L
- Migrations: `sync_log`, `sync_state` (seeded with 0), `client_mutations`. The `sync_groups text[] NOT NULL` convention is documented in `db/README.md`.
- `apps/server/src/sync/repo.ts`: `insert`, `update` (reads back the full row), `archive`, `unarchive`, `purge`. Each computes `groups` with a per-model `groupsOf(row, tx)` function and buffers changes.
- `flushSyncLog(tx, origin)`: `pg_advisory_xact_lock(SYNC_LOCK)`, bump `sync_state`, bulk-insert into `sync_log`. Wired into the executor (it replaces the PLAN-003 passthrough repo).
- **Lint rule:** a custom ESLint rule (`no-synced-table-writes`) that bans `db.insert/update/delete` on tables tagged `synced` outside `sync/repo.ts`. There is also a runtime guard in tests (AC-12).
- `DebugItem` schema plus ops.
- **Tests:** an ordering stress test with 20 workers × 500 mutations, replaying `sync_log` to verify the IDs are gap-free and in commit order (AC-1); lock hold-time metric < 2 ms.

### S3: Bootstrap endpoint · M
- `GET /sync/bootstrap`: a `REPEATABLE READ` transaction that reads `max(sync_id)` and streams `meta`, then the rows of every **eager** model filtered by `sync_groups && userGroups` (server-side cursors, 1,000 rows per fetch), then `end`. gzip via `@fastify/compress`.
- The server-side model registry maps synced models to their table, columns, and eager or content strategy. It is generated from the shared model definitions, to avoid duplicating them.
- **Tests:** snapshot consistency under concurrent writes (no row newer than `lastSyncId`), group filtering (AC-11, bootstrap part), throughput with 150k fixture rows.

### S4: Sync hub & WebSocket · L
- `LISTEN sync` on a dedicated connection. On notify, read new `sync_log` rows after `broadcastedUpTo` in order.
- Connection registry: `{ userId, clientId, groups, lastSentId, catchingUp, buffer }`.
- **Catch-up:** stream from `since` to the current `broadcastedUpTo` in pages of 500, buffering live packets for that connection, then flush the buffer and go live.
- Per-connection `prev` tracking. `ack` entries for the connection's own `clientId`. `resync` when `since` is outside retention or `schemaHash` differs. Ping every 25 s with a 10 s timeout. Close code `4001` on session revoke (exposed as `hub.closeSessions(sessionIds)` for PLAN-001).
- **Shutdown:** close all connections with `1012`.
- `synclog.prune` job (pg-boss, daily, 30-day retention).
- **Tests:** catch-up after 1,000 changes (AC-9), live-during-catch-up race, too-old and schema `resync` (AC-10, server part), group filtering on live and catch-up (AC-11), broadcast lag metric.

### S5: Mutate endpoint · M
- `POST /sync/mutate`: auth, `clientId` registration and ownership check, `schemaHash` check (`CLIENT_OUTDATED`), seq dedupe and `SEQ_GAP`. Each mutation runs through the executor with `origin = {clientId, seq}`, and the `client_mutations` row is updated **inside the same transaction**.
- Stored results for idempotent replay (last batch).
- **Tests:** replayed batches return the stored results without re-executing, gap detection, a crash between commit and response (simulated), and an outdated schema.

### S6: Client store: models, pool, IDB · L
- `packages/sync-client`: `defineModel()` (fields, refs, indexes, load strategy), and the **object pool** with MobX observable instances (strict mode; writes only through the store).
- Incremental **secondary indexes** (declared per model; updated on base and overlay changes).
- **IDB worker** (`idb` library): object store per model, `meta`, `pending`. Chunked bulk puts, and transfer of hydrated rows in chunks.
- **Bootstrap reader:** fetch stream, NDJSON decode, worker writes, pool populate, progress events. **Warm start:** hydrate from IDB, then re-apply the overlay.
- Client-side **ref resolvers** (the PLAN-003 S2 interface) over the pool.
- The DB name is `surface-<workspaceId>-<userId>`. It is cleared on `resync`. If IDB is unavailable, fall back to memory-only (E6).
- **Tests:** pool and index unit tests, IDB round trip (fake-indexeddb), warm start of 10k rows < 1.5 s in a browser benchmark (part of AC-8).

### S7: Socket client & delta apply · M
- WebSocket lifecycle with backoff (0.5 s to 30 s, jitter), the `online` event, and ping/pong.
- **Delta apply:** strict order, `prev` gap check that triggers a reconnect (E1), ignore `id ≤ lastSyncId` (E2), upsert/archive/delete into base, IDB persist (batched per message), and a `lastSyncId` update.
- Handling of `resync` (re-bootstrap while keeping the pending queue) and close code `4001` (emit `session-revoked`).
- **Tests:** a gap triggers a reconnect, duplicates are ignored, resync keeps pending mutations (AC-10, client part).

### S8: Mutation queue, overlay & dispatch · L
- `dispatch(op, input)`: client Zod validation, `seq` (persisted counter), IDB-persisted pending entry, `optimistic()` against the overlay, and a flusher with one batch in flight.
- **Overlay engine:** a draft-based overlay over the base. It recomputes touched IDs when pending mutations change or deltas touch them.
- Results handling: acked → wait for `lastSyncId ≥ N` → confirmed and removed. Rejected → removed, overlay recomputed, `onRejected` event (toast). `CLIENT_OUTDATED` → `onOutdated` event.
- **Offline:** queue during disconnect. On reconnect, catch-up first, then flush.
- **Tests:** an optimistic update renders in the same frame (AC-5, unit-level with a MobX reaction timing check), rejection rollback (AC-7, unit), offline queue persisted across a simulated reload.

### S9: Simulation harness & property tests · L
- `packages/sync-client/test/sim/`: an in-process server (real executor and Postgres via Testcontainers, or a template DB) and N clients using the real `sync-client` with fake-indexeddb, connected by a **controllable network** (delay, drop, reorder, disconnect, server restart).
- **Property 1, convergence (AC-2):** random sequences of `debug.*` ops across clients plus random faults. After quiescence, every client's base equals the DB and every overlay is empty.
- **Property 2, exactly-once (AC-3):** each client increments its own `debug.touch` counters. Random crashes and reloads. The final counters equal the number of dispatches.
- CI runs 200 cases on PRs and 1,000 on main. Failing seeds are printed, and `pnpm sim --seed <n>` replays one.

### S10: Inspector, UI hooks, demo e2e & perf · M *(after PLAN-001 S8)*
- **Sync inspector panel** (dev builds, plus `?debug=sync` for Admins): state, `lastSyncId`, lag, queue, recent packets, rejections, row counts, IDB size, "Force resync".
- **UI hooks** consumed by PLAN-005: `useConnectionState()`, `usePendingCount()`, `onRejected`, `onOutdated`, `useBootstrapProgress()`.
- **E2E with real models** (team rename): tab-to-tab < 150 ms p95 over 100 trials (AC-4), offline rename, reload, then online (AC-6), and server rejection via a team removed meanwhile (AC-7).
- **Perf suite:** a reference-scale seed (`scripts/seed-reference-scale.ts`, eager rows only, about 150k) with a cold bootstrap < 10 s and a warm start < 1.5 s (AC-8), plus delta apply < 5 ms per 100 packets. Wired into the nightly workflow.
- AC-13 is a manual check with the inspector during AC-6 (recorded in the PR).

## 2. Modules touched
`packages/sync-protocol/*`, `packages/sync-client/*`, `apps/server/src/sync/{repo,bootstrap,hub,mutate,registry}.ts`, the executor (repo wiring), migrations (`sync_log`, `sync_state`, `client_mutations`, `debug_items`), `scripts/seed-reference-scale.ts`, `e2e/sync-*.spec.ts`, `.github/workflows/nightly.yml`.

## 3. Migration & rollback
Additive tables. `debug_items` exists only in dev and test (the migration is guarded by `NODE_ENV`, or it lives in a separate test migration folder). Rollback = revert the code; clients that hit `resync` re-bootstrap automatically.

## 4. Test plan (AC → test)

| AC | Test |
|---|---|
| AC-1 | `server/test/sync-ordering.stress.int.test.ts` |
| AC-2 | `sync-client/test/sim/convergence.prop.test.ts` |
| AC-3 | `sync-client/test/sim/exactly-once.prop.test.ts` |
| AC-4 | `e2e/sync-realtime.spec.ts` (two browser contexts, 100 trials, p95 assertion) |
| AC-5 | `sync-client/test/optimistic-frame.test.ts` + `e2e/sync-optimistic.spec.ts` |
| AC-6 | `e2e/sync-offline.spec.ts` (Playwright `context.setOffline`, reload) |
| AC-7 | `sync-client/test/rejection.test.ts` + `e2e/sync-rejection.spec.ts` |
| AC-8 | `e2e/perf/bootstrap.perf.ts` (nightly) |
| AC-9 | `server/test/sync-catchup.int.test.ts` |
| AC-10 | `server/test/sync-resync.int.test.ts` + `sync-client/test/resync.test.ts` |
| AC-11 | `server/test/sync-groups.int.test.ts` (bootstrap, catch-up, live) |
| AC-12 | ESLint rule test + `server/test/repo-guard.int.test.ts` |
| AC-13 | Manual check, recorded in the S10 PR |

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Overlay recomputation is too slow with many pending mutations offline | Recompute only touched IDs. Benchmark 1,000 pending mutations offline. Coalesce consecutive same-field updates in the queue (safe because they are idempotent intents). |
| A catch-up or live race causes missed packets | Per-connection buffer during catch-up, a `prev` check on the client, and dedicated tests with injected delays |
| IDB write throughput limits the cold bootstrap | Worker with large chunked transactions, a strict-durability flag off where supported, and the progress UI. Measured in the nightly perf run. |
| The serialized sync-log lock contends under bulk operations | A bulk op is one transaction with one lock. Hold time is a metric. Revisit only if p95 > 5 ms. |
| Simulation tests are flaky | Deterministic seeds, fake timers in the network layer, and no real sleeps |
