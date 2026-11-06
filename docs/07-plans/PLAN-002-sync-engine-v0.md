# PLAN-002: Sync engine v0

Implements: [SPEC-002](../06-specs/SPEC-002-sync-engine-v0.md) · Protocol: [sync-protocol.md](../04-architecture/sync-protocol.md) · Status: **Ready** · Order: **3rd** · Depends on: PLAN-003 S4 (executor), PLAN-004 S3 (DB)

> **Engine fixture:** until real models exist (PLAN-001), the engine is built and tested against an internal **`DebugItem`** model (`id`, `title`, `counter`, `groups`) with ops `debug.create`, `debug.rename`, `debug.touch`, `debug.delete` (all `internal`, dev/test builds only). The M0 demo ACs (team rename) are verified in S10 after PLAN-001 S8.

---

## 1. Slices

### S1: `packages/sync-protocol` · S · ✅ Done 2026-11-06
- Wire types and Zod codecs: bootstrap frames (`meta`, `row`, `end`), WebSocket messages (`deltas` with `prev` and `ack`, `resync`, `ping`/`pong`), mutate request and response.
- NDJSON stream encoder/decoder (works in a worker and in Node).
- `computeSchemaHash(modelDefs)`: a stable hash of the synced model names, fields, and types.
- **Tests:** round-trip codecs, a partial-chunk NDJSON decoder, schemaHash stability.

> **As built (2026-11-06, session D):**
> - **Deps:** `zod` ^4.6.7 (same range as the server); dev: `fast-check` ^4.10.2, `@types/node` (tests only).
> - **Structure:** `src/scalars.ts` (sync id, UUID, seq, sync group, model and op names, row), `bootstrap.ts`, `socket.ts`, `mutate.ts`, `ndjson.ts`, `schema-hash.ts`, `sha256.ts`, `errors.ts`. Each message has a Zod schema, an inferred type, and a `decode*` helper that throws `ProtocolError`. Error messages name the path and rule, never the payload, so row data can't reach logs.
> - **Portability:** `src` builds with `lib: ES2023 + WebWorker` and no Node types (`tsconfig.build.json` sets `types: []`), so a Node-only API in `src` fails `pnpm build`. Only `TextEncoder`/`TextDecoder` are used.
> - **Deviations and additions** (all in sync-protocol.md §4 and §11, handed off to A):
>   - `deltas.packets` may be empty when `ack` is non-empty. A mutation can write rows its own client cannot see, and the client must still confirm it.
>   - The WebSocket URL carries `schemaHash`, so the hub can answer `resync(schema)` (S4 needs it; the doc's URL lacked it).
>   - `SEQ_GAP` error bodies carry `lastSeq`, so the client knows where to resend from.
>   - Decoders enforce ordering: packet ids strictly increasing and > `prev`, mutation and result seqs consecutive.
>   - `presence` is left out of the codecs (M4). A message with an unknown `t` fails to decode.
> - **NDJSON:** `NdjsonDecoder` is push-based (`push(chunk)` → values, `end()`), accepts byte or string chunks (not mixed), reassembles UTF-8 split across chunks (`fatal: true`, so malformed bytes throw), tolerates CRLF and blank lines, and caps a line at 8 Mi chars. `decodeNdjson(asyncIterable)` wraps it. A push API avoids depending on `ReadableStream` async iteration in browsers.
> - **`computeSchemaHash(models: Iterable<SchemaHashModel>)`:** the input is structural: `{ name, load, fields: { [name]: { type, nullable } } }`. S6's `defineModel` output must provide these keys (extra keys such as refs and indexes are ignored). The hash is SHA-256 hex of the canonical form, using a pure-TS SHA-256 because `crypto.subtle` is missing on plain-HTTP origins. It is cross-checked against `node:crypto`. `SYNC_PROTOCOL_VERSION` (now exported from `schema-hash.ts`) is part of every hash.
> - **Tests (99):** fast-check round trips for every message type, connect params and NDJSON (byte and text chunking at arbitrary cut points), rejection cases per codec, a pinned golden hash, order independence, per-field sensitivity, FIPS vectors plus padding boundaries. Property tests use the fixed seed `PROPERTY_SEED` in `test/support/arbitraries.ts`, and fast-check prints the seed and path on failure.
> - **For later slices:** S3/S4/S5 import the schemas from `@surface/sync-protocol` (server code reads `dist/`, which the build produces). Use `decodeSocketConnectParams(request.query)`, `decodeMutateRequest(body)` and `encodeNdjsonLine(frame)`. S6 must define the canonical field `type` strings (e.g. `uuid`, `string`, `int`, `enum:a|b`), because they feed the hash.

### S2: Sync tables & repo layer (server) · L · ✅ Done 2026-11-06
- Migrations: `sync_log`, `sync_state` (seeded with 0), `client_mutations`. The `sync_groups text[] NOT NULL` convention is documented in `db/README.md`.
- `apps/server/src/sync/repo.ts`: `insert`, `update` (reads back the full row), `archive`, `unarchive`, `purge`. Each computes `groups` with a per-model `groupsOf(row, tx)` function and buffers changes.
- `flushSyncLog(tx, origin)`: `pg_advisory_xact_lock(SYNC_LOCK)`, bump `sync_state`, bulk-insert into `sync_log`. Wired into the executor (it replaces the PLAN-003 passthrough repo).
- **Lint rule:** a custom ESLint rule (`no-synced-table-writes`) that bans `db.insert/update/delete` on tables tagged `synced` outside `sync/repo.ts`. There is also a runtime guard in tests (AC-12).
- `DebugItem` schema plus ops.
- **Tests:** an ordering stress test with 20 workers × 500 mutations, replaying `sync_log` to verify the IDs are gap-free and in commit order (AC-1); lock hold-time metric < 2 ms.

> **As built (2026-11-06).**
> - **Versions:** no new packages.
> - **Migrations:** `0004_sync_tables` (`sync_log` with the action CHECK and a GIN index on `groups`, `sync_state` with a single-row CHECK, `client_mutations`, and `debug_items.archived_at`), `0005_seed_sync_state` (custom: the `sync_state` row at 0). All instants are `timestamptz(3)`. Sync scope per table and the `sync_groups` convention: `apps/server/src/db/README.md`.
> - **Repo (`apps/server/src/sync/repo.ts`)** replaces the PLAN-003 passthrough, which is deleted (it wrote synced tables without logging them):
>   - `insert`, `update`, `archive`, `unarchive`, `purge`, `changes()`, and `flush(origin)` → `{ lastSyncId?, lockedAt? }`. `update`/`archive`/`unarchive` lock the row and read its old groups first (`SELECT … FOR UPDATE`), write, then recompute groups with `groupsOf(row, tx)` (now async-capable, with the transaction) and store them if they changed.
>   - A groups change logs `D` (old groups) then `U` (new groups); `A`/`V` carry the full row. Both are new spec decisions (SPEC-002 Q4, Q5; sync-protocol §6 updated).
>   - `flush` with nothing buffered takes no lock. Otherwise: `pg_advisory_xact_lock(LOCKS.sync)`, `UPDATE sync_state … RETURNING`, one multi-row `INSERT INTO sync_log`. `data` is the row as JSON (camelCase keys, ISO timestamps with milliseconds, the full `syncGroups`). It is server-only; what clients receive is cut down per connection (SPEC-002 Q6).
>   - The executor uses `syncRepo` by default and records `surface_sync_lock_hold_seconds` (lock taken → commit) on the metrics registry.
> - **Operations:** `debug.create` (client-generated `id`, optional `groups`, default `workspace`), `debug.rename`, `debug.delete` (destructive), all internal, with handlers that check visibility first (invisible → `NOT_FOUND`). All four write ops, `debug.touch` included, now have `optimistic()` for session D's queue and overlay.
> - **AC-12:**
>   - **Static:** `surface/no-synced-table-writes` (`packages/config/eslint-rules/`, wired in `packages/config/eslint.js` for `apps/server/src/**` except `sync/repo.ts`) flags Drizzle `insert/update/delete` on a listed table, on anything taken from `SYNCED_MODELS` (also through a `const` alias or destructuring), and raw SQL that inserts into, updates, deletes from, merges into or truncates one. Raw SQL text is read from strings, `+` concatenations, templates (`${table}` counts as the table's name) and `sql.raw`/`sql.identifier`. A table passed in as a function parameter can't be seen statically; the runtime audit covers that. The table list `SYNCED_TABLES` lives in `packages/config/eslint.js`; `server/test/sync-lint.test.ts` (RuleTester) checks it equals `SYNCED_MODELS` plus `sync_log`/`sync_state`.
>   - **Runtime (tests):** `executorHarness()` installs an audit trigger on every synced table, and `testExecutor()` runs `repoWritesOnly` as a post-handler check, so **every executor integration test** fails a mutation that wrote a synced row its repo didn't log (`repo-guard.int.test.ts`). Queries are skipped (read-only). A test's own `checks` run after the audit, never instead of it. Gaps, documented in `test/executor.ts`: it matches by (table, id), and doesn't audit `sync_log`/`sync_state`.
> - **Tests:**
>   - `sync-ordering.stress.int.test.ts` (AC-1): 20 workers × 500 executor mutations (touch, rename, create on 8 contended rows, seeded PRNG). An observer polls during the run and checks every snapshot shows exactly ids `start+1 … max` (no hole); then ids are contiguous, `sync_state` agrees, every result's `lastSyncId` is its log row, and replaying the log reproduces the table. 15–25 s. A planted bug (ids from a sequence, no lock to commit) gave 1,348 holes and failed.
>   - `sync-lock.perf.int.test.ts` (§10 budget, run alone): 8 writers × 1,000 touches; ≥ 95 % of holds ≤ 2 ms, best of 3. Probe: ≥ 98 % ≤ 2 ms from 1 to 20 writers.
>   - `sync-repo.int.test.ts`: I/U/A/V/D in order with full rows and groups, groups change as D+U (and a reordered set is not a change), origin recorded, an empty flush takes no lock, `NOT_FOUND` logs nothing, the debug ops each return their change's sync id, a rolled-back mutation and a query log nothing, an invisible item is `NOT_FOUND` worded like a missing one.
> - **Review fixes (2026-11-06):** the lint rule now catches `${table}` in `sql` templates, tables from `SYNCED_MODELS` and their aliases, `MERGE INTO`, concatenated strings and `sql.raw`/`sql.identifier` (13 new RuleTester cases, all failing on the first version). `testExecutor({ checks })` adds to the write audit instead of replacing it. `debug.create` is commented as deliberately unsafe. New spec decision SPEC-002 Q6 (groups a client sees), and §4.3 keeps a groups-change pair in one batch. Notes below for S3/S4 and PLAN-001.
> - **Deviations:**
>   - §3 says `debug_items` exists only in dev and test. It has been in the main migrations since PLAN-003 S4: the table stays empty in production, and its operations are internal, which the executor refuses in production. Moving it would mean a migration split; not worth it for an empty table.
>   - `client_mutations` is created here but first written in S5.
>   - The `NOTIFY` after commit (§4.3) is S4's.
> - **Notes for later slices:**
>   - **S3/S4:** read `sync_log` with `groups && $groups`. Send every row (bootstrap and `data`) with `syncGroups` intersected with the connection's groups (SPEC-002 Q6). Never split a `D` from the packet for the same row that directly follows it across a batch or a catch-up page (§4.3, Q5). Apart from `syncGroups`, `data` is the client row shape; a model that gains a server-only column needs a projection here too.
  - **PLAN-001 handlers:** a handler's visibility read (`ctx.query.get`) doesn't lock the row, and `repo.update` locks it by id without a groups filter. Once operations can change a row's groups (moving an issue to another team), make the visibility read lock the row (`FOR UPDATE`), or have the repo re-check `sync_groups && actorGroups` under its lock, so a write can't land on a row the actor just lost sight of. The debug operations never change groups, so they are safe today.
>   - **S5:** write `client_mutations` in the mutation's transaction, and pass `{ clientId, seq }` to the executor (it reaches `flush`).
>   - **PLAN-001 S1:** each new synced model needs `SYNCED_MODELS` (`groupsOf` may query through the transaction) and a `SYNCED_TABLES` entry; the lint test fails until both exist.

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

### S6: Client store: models, pool, IDB · L · ✅ Done 2026-11-06
- `packages/sync-client`: `defineModel()` (fields, refs, indexes, load strategy), and the **object pool** with MobX observable instances (strict mode; writes only through the store).
- Incremental **secondary indexes** (declared per model; updated on base and overlay changes).
- **IDB worker** (`idb` library): object store per model, `meta`, `pending`. Chunked bulk puts, and transfer of hydrated rows in chunks.
- **Bootstrap reader:** fetch stream, NDJSON decode, worker writes, pool populate, progress events. **Warm start:** hydrate from IDB, then re-apply the overlay.
- Client-side **ref resolvers** (the PLAN-003 S2 interface) over the pool.
- The DB name is `surface-<workspaceId>-<userId>`. It is cleared on `resync`. If IDB is unavailable, fall back to memory-only (E6).
- **Tests:** pool and index unit tests, IDB round trip (fake-indexeddb), warm start of 10k rows < 1.5 s in a browser benchmark (part of AC-8).

> **As built (2026-11-06, session D):**
> - **Deps:** `mobx` ^7.1.4 and `idb` ^8.0.4 in sync-client; `zod` ^4.6.7 in domain (session A adds the same line); dev: `fake-indexeddb` ^6.2.7, `fast-check`, `@types/node`.
> - **Model definitions** live in `packages/domain/src/model/` and are exported as the subpath **`@surface/domain/model`** (so `domain/src/index.ts`, owned by A, is untouched). Builders `uuid() str() int() bool() timestamp() enumOf([...]) json() array(item)` plus `.nullable()`. `defineModel(name, { load, fields, refs, indexes })` adds the implicit `id`, validates names, refs and indexes, builds a Zod `rowSchema` (it strips undeclared columns such as `sync_groups`), and returns a `ModelDef` that `computeSchemaHash` accepts directly. The definition is frozen all the way down, except the Zod schemas. Field and ref names that would shadow instance members (`toJSON` and the `Object.prototype` names) are rejected. Canonical type names are part of the hash: `uuid`, `string`, `int`, `bool`, `timestamp`, `json`, `enum<a|b>` (members sorted; `|`, `<`, `>` and duplicates rejected), `array<string>`. Fixture: `DebugItem { title, counter, groups: string[] }`, indexed on `title`, in no production model list.
> - **Instances (deviation from "MobX observable instances"):** MobX 7 dropped `{ proxy: false }`, so `observable()` objects are always Proxies. Instead each model gets a generated prototype with one getter per field, backed by a MobX atom created on first read and released when unobserved. That gives per-field reactivity, no proxy traps, and near-zero cost for unobserved rows. **ADR-0015** (accepted 2026-11-06) supersedes ADR-0003's "enforced by MobX strict mode" clause. Instances are frozen and getter-only, rows are deep-frozen as they enter base or overlay, and views get a type-level `ReadonlyPool` (`SyncStore.pool`). The package exports only `SyncStore`, `rowOf`, the errors and types, pinned by `test/public-api.test.ts`. No global `configure()` is set. Fields are not own properties: use `toJSON()` / `JSON.stringify`, not `Object.keys` or spread. Instance identity is stable across updates. `$model` and `$archived` are meta getters.
> - **Pool (`ObjectPool`):** each entry holds `base` (server only), `overlay` (`undefined` = none, `null` = optimistically deleted), and the visible instance. The API: `applyBase(changes)` (upsert, archive, unarchive, delete), `loadBase`, `sweepBase`, `setOverlay` (for S8), plus reactive reads `get`, `all`, `count`, `findBy(model, field, value)`, `ref`, `backRef`. Passing a definition (`pool.get(DebugItem, id)`) types the result. Each write is one `runInAction` batch. Archive and delete of unknown ids are ignored, and an upsert keeps the archived flag.
> - **Indexes:** `Map<value, Set<id>>` per field with a lazy atom per value, so a lookup re-runs only when its own bucket changes. A `backRef` auto-indexes the target field. Only scalar fields are indexable, and `null` is a key.
> - **Storage (`SyncStorage`):** `IndexedDbStorage` (stores `meta`, `pending` and `row:<Model>`; a model-list change bumps the DB version and rebuilds row stores, keeping `pending`; an upgrade blocked by a stubborn old tab rejects with "Close other Surface tabs and reload" instead of hanging; a connection closed by another tab's upgrade or by the browser fails with `StorageClosedError` saying to reload; `readRows` pages on keys, so an unreadable record doesn't end paging), `MemoryStorage` (E6 fallback), and `serveStorage` / `connectStorage` RPC over any message port, with `storage/worker.ts` as the module worker entry. The RPC never hangs. The worker gets 10 s to open (then start-up falls back to memory) and 30 s per call. Worker `error` and `messageerror` events and `close()` fail pending and later calls with `StorageUnavailableError`. `close()` terminates the worker. `openStorage` tries worker → same-thread IDB → memory: a worker that cannot be created or fails (CSP, load error, open timeout) falls back to IndexedDB on the main thread (`connectWithFallback`), and only a missing or failing IndexedDB means memory. **Multi-tab safety (E5), not in the plan:** a per-bootstrap *generation* fence (writes from a stale generation throw `StorageFencedError`), per-row *version* = the sync id that wrote it (older deltas are skipped), *tombstones* for deletes, and `lastSyncId = max(...)`. `applyChanges(generation, changes, lastSyncId)` is implemented and tested for S7 to call. Bootstrap writes use `durability: 'relaxed'`.
> - **Persistence:** two kinds of failure are kept apart. A *fenced* generation (another tab re-bootstrapped) ends only this tab's row writes for that generation, via `writeReplica(generation, …)` and `isCurrent(generation)`. Storage stays usable for pending mutations and no warning shows, because the other tab persists the same data. Any other failure (quota, closed DB, dead worker) *loses* storage and shows an observable `storageWarning`. The memory fallback is written to like any storage (so S8's pending queue works there) but is never `persistent`. Rendering is unaffected either way.
> - **Bootstrap / warm start / store:** `bootstrap()` reads the body with the S1 `NdjsonDecoder` and validates frame order, `schemaHash` (`ClientOutdatedError`), every row against `rowSchema` (errors name the field, never the value), and `rows` counts. It writes chunks of 1,000 to storage and the pool, reports progress, and marks the replica `ready` only after `end`. On re-bootstrap it sweeps base rows the server no longer sent and keeps overlays. It cancels the download on abort or bad data. `hydrate()` pages 1,000 rows per model from storage, re-reads `meta` at the end and gives up if the generation changed meanwhile, then sweeps pool rows the replica lacks. `SyncStore` (`start()` → `'warm' | 'cold'`, `resync()`, `close()`, observable `status`, `progress`, `position {lastSyncId, groups, generation}`, `persistent`, `storageWarning`) uses `replicaName = surface-<workspaceId>-<userId>`. `start` and `resync` run one at a time. `close()` aborts whatever is running and waits for it to settle (a start never reports `ready` after close), then closes storage, resets `status` to `idle` and clears `position` and `progress`; the pool keeps its rows until the next `start` replaces them, and `start()` may be called again. **Cross-tab start-up (E5), not in the plan:** with Web Locks (`navigator.locks`, injectable as `locks`), a warm start holds the replica lock shared and a bootstrap holds it exclusive, re-checking the replica first. A second tab therefore waits for a bootstrapping tab and then warm-starts, and two fresh tabs bootstrap once. Web Locks need a secure context. On plain HTTP, tabs start unlocked: the fence keeps the replica consistent, but two tabs starting together may both bootstrap (documented in `locks.ts`).
> - **Protocol additions** (sync-protocol.md v0.3, handed off to A): `meta.rows` (required, exact count from the same snapshot, for the progress bar) and `row.archived` (optional boolean, `true` = archived; clients keep archived rows because `V` carries only an id; widened from `true`-only before release).
> - **Not done here:** client ref resolvers and re-applying the overlay on warm start moved to S8 as tracked bullets. PLAN-003 S2 landed on `main` after this slice branched, and the ref-bearing models arrive in PLAN-001. The Vite worker bundling (`new URL('./worker.ts', import.meta.url)`) isn't exercised yet because apps/web doesn't use the store.
> - **Tests (117 sync-client + 20 domain):** pool, reactivity, indexes and immutability (`pool.test.ts`). There are two **property tests** with a fixed seed: `pool.prop.test.ts` (model-based: base, overlay, tracked and untracked reads, and reactions starting and stopping must match a reference model and full index scans) and `storage.prop.test.ts` (two tabs applying one delta stream in arbitrary batches and interleavings converge on every backend). Both were mutation-checked. Also `storage.failure.test.ts` (worker silent, erroring or closed; blocked upgrade), `hydrate.test.ts`, `persistence.test.ts`, `public-api.test.ts`, and one storage contract suite run against memory, IndexedDB and IndexedDB-over-`MessageChannel` RPC (`storage.contract.test.ts`, including the lagging-tab and fence cases), IDB migration and fencing (`indexeddb.test.ts`), the bootstrap reader against chunked fake streams (`bootstrap.test.ts`), start-up, fallback, archived rows, resync, lifecycle and two-tab start-up over real `navigator.locks` (`store.test.ts`), and model definitions (`domain/src/model/define-model.test.ts`). **Warm start of 10k rows:** `warm-start.perf.test.ts` runs in Node with fake-indexeddb behind the RPC with a 1.5 s budget (the whole test, cold bootstrap included, takes about 0.3 s). The real-browser measurement for AC-8 stays with the S10 nightly perf suite.
> - **For S7:** after `pool.applyBase` (the store's private `ObjectPool`), call `persistence.writeReplica(generation, s => s.applyChanges(generation, changes, lastSyncId))` once per deltas message. Skip it when `position.generation` is `undefined` or `!persistence.isCurrent(generation)`. Run delta apply through the store's serial queue so it never interleaves with `resync`. Treat a `G` packet as `store.resync()`. **For S8:** pending entries go in the existing `pending` store (keyPath `key`), and the overlay uses `pool.setOverlay` / `pool.baseOf`.

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
- **Warm start re-applies the overlay (carried over from S6):** after `hydrate`, rebuild the overlay from the persisted `pending` entries before the store reports `ready` (SPEC-002 §3.2 step 2; `TODO(PLAN-002 S8)` in `store.ts`). AC-6 (a rename made offline survives a reload) depends on it.
- **Client ref resolvers (carried over from S6):** implement `ClientRefResolver` (`packages/domain/src/refs.ts`, PLAN-003 S2) over the `ReadonlyPool`, with `get` by id and `findBy` on indexed `key`, `email` and normalised-name fields. It is needed by `dispatch` input resolution. It waits for the ref-bearing models (Team, User, WorkflowStatus, Label) from PLAN-001. Until those exist, test it against fixture models.
- **Tests:** an optimistic update renders in the same frame (AC-5, unit-level with a MobX reaction timing check), rejection rollback (AC-7, unit), offline queue persisted across a simulated reload.

### S9: Simulation harness & property tests · L
- `packages/sync-client/test/sim/`: an in-process server (real executor and Postgres via Testcontainers, or a template DB) and N clients using the real `sync-client` with fake-indexeddb, connected by a **controllable network** (delay, drop, reorder, disconnect, server restart).
- **Property 1, convergence (AC-2):** random sequences of `debug.*` ops across clients plus random faults. After quiescence, every client's base equals the DB and every overlay is empty.
- **Property 2, exactly-once (AC-3):** each client increments its own `debug.touch` counters. Random crashes and reloads. The final counters equal the number of dispatches.
- CI runs 200 cases on PRs and 1,000 on main. Failing seeds are printed, and `pnpm sim --seed <n>` replays one.

### S10: Inspector, UI hooks, demo e2e & perf · M *(after PLAN-001 S8)*
- **Sync inspector panel** (dev builds, plus `?debug=sync` for Admins): state, `lastSyncId`, lag, queue, recent packets, rejections, row counts, IDB size, "Force resync".
- **UI hooks** consumed by PLAN-005: `useConnectionState()`, `usePendingCount()`, `onRejected`, `onOutdated`, `useBootstrapProgress()`.
- ⏸ **Held (SPEC-002 D1):** the e2e and perf bullets below wait for the e2e hold to lift; S10 now delivers the inspector and the UI hooks.
- **E2E with real models** (team rename): tab-to-tab < 150 ms p95 over 100 trials (AC-4), offline rename, reload, then online (AC-6), and server rejection via a team removed meanwhile (AC-7).
- **Perf suite:** a reference-scale seed (`scripts/seed-reference-scale.ts`, eager rows only, about 150k) with a cold bootstrap < 10 s and a warm start < 1.5 s (AC-8), plus delta apply < 5 ms per 100 packets. Wired into the nightly workflow.
- AC-13 is a manual check with the inspector during AC-6 (recorded in the PR).

## 2. Modules touched
`packages/sync-protocol/*`, `packages/sync-client/*`, `apps/server/src/sync/{repo,bootstrap,hub,mutate,registry}.ts`, the executor (repo wiring), migrations (`sync_log`, `sync_state`, `client_mutations`, `debug_items`), `scripts/seed-reference-scale.ts`, `e2e/sync-*.spec.ts`, `.github/workflows/nightly.yml`.

## 3. Migration & rollback
Additive tables. `debug_items` exists only in dev and test (the migration is guarded by `NODE_ENV`, or it lives in a separate test migration folder). Rollback = revert the code; clients that hit `resync` re-bootstrap automatically.

## 4. Test plan (AC → test)

> ⏸ **Tests that need a browser, a running stack or Postgres are held** since 2026-11-06 (SPEC-002 D1, [plans README §6](README.md#6-testing-hold-e2e-smoke-and-integration)): rows marked held get no test for now, and the markers override the slices' "Tests:" bullets. Unit and property tests in the same row are still written, and so are the sync property suite and private-team leak tests.

| AC | Test |
|---|---|
| AC-1 | `server/test/sync-ordering.stress.int.test.ts` (written in S2) |
| AC-2 | `sync-client/test/sim/convergence.prop.test.ts` (not held: real executor and Postgres, §6) |
| AC-3 | `sync-client/test/sim/exactly-once.prop.test.ts` (not held: real executor and Postgres, §6) |
| AC-4 | ⏸ held (e2e) `e2e/sync-realtime.spec.ts` (two browser contexts, 100 trials, p95 assertion) |
| AC-5 | `sync-client/test/optimistic-frame.test.ts` (+ `e2e/sync-optimistic.spec.ts`, ⏸ held) |
| AC-6 | ⏸ held (e2e) `e2e/sync-offline.spec.ts` (Playwright `context.setOffline`, reload) |
| AC-7 | `sync-client/test/rejection.test.ts` (+ `e2e/sync-rejection.spec.ts`, ⏸ held) |
| AC-8 | ⏸ held (perf) `e2e/perf/bootstrap.perf.ts` (nightly) |
| AC-9 | ⏸ held (integration) `server/test/sync-catchup.int.test.ts` |
| AC-10 | `sync-client/test/resync.test.ts` (+ `server/test/sync-resync.int.test.ts`, ⏸ held) |
| AC-11 | `server/test/sync-groups.int.test.ts` (bootstrap, catch-up, live; not held: leak test, §6) |
| AC-12 | `server/test/sync-lint.test.ts` (ESLint rule) + `server/test/repo-guard.int.test.ts` (both written in S2) |
| AC-13 | Manual check, recorded in the S10 PR |

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Overlay recomputation is too slow with many pending mutations offline | Recompute only touched IDs. Benchmark 1,000 pending mutations offline. Coalesce consecutive same-field updates in the queue (safe because they are idempotent intents). |
| A catch-up or live race causes missed packets | Per-connection buffer during catch-up, a `prev` check on the client, and dedicated tests with injected delays |
| IDB write throughput limits the cold bootstrap | Worker with large chunked transactions, a strict-durability flag off where supported, and the progress UI. Measured in the nightly perf run. |
| The serialized sync-log lock contends under bulk operations | A bulk op is one transaction with one lock. Hold time is a metric. Revisit only if p95 > 5 ms. |
| Simulation tests are flaky | Deterministic seeds, fake timers in the network layer, and no real sleeps |
