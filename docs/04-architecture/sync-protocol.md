# Surface: Sync Protocol (v1)

Status: **Draft v0.1** · Date: 2026-11-06 · Decision: [ADR-0002](adr/0002-sync-strategy.md)

This is the contract between `packages/sync-client` and `apps/server`. Every wire type here lives in `packages/sync-protocol`.

---

## 1. Model

| Concept | Definition |
|---|---|
| **Base state** | The rows the client has received from the server, up to `lastSyncId` |
| **Pending mutations** | Operations applied locally that the server has not yet confirmed |
| **View state** | Base state with the optimistic effects of pending mutations layered on top. The UI renders the view state. |
| **Authority** | The server. The client never writes base state except from server data. |

Mutations are sent as **operations (intent)**, not row diffs. The server re-executes them against current data, so concurrent edits merge naturally at the field level: `issue.update({priority})` touches only `priority`.

---

## 2. Load strategies

| Strategy | Models | Loaded |
|---|---|---|
| **eager** | Workspace, User, Team, TeamMembership, WorkflowStatus, Label, Issue (*without* description), IssueLabel, IssueRelation, Attachment (metadata), Cycle (without snapshot), Project (without description), ProjectTeam, ProjectMember, ProjectMilestone, Initiative, InitiativeProject, Document (title and metadata only), Template, CustomView, ViewDefault, plus user-scoped: ViewPreference, Favorite, Subscription, Notification, ApiKey (metadata), Preferences | At bootstrap, kept live by deltas |
| **content** | IssueContent (`description`), Comment, Reaction, IssueHistory, ProjectContent (`description`), ProjectUpdate, DocumentContent, CycleSnapshot | On demand, **per parent**. Cached in IDB, and kept live by deltas *once the parent is hydrated* |

Content is split into separate tables or models on the server (e.g. `issue_content`), so eager rows stay small.

**Size budget at the reference scale** (100k issues, NFR-10): about 35 MB of eager rows uncompressed (≈ 6 MB gzipped). This must be measured and asserted in the perf suite.

---

## 3. Server ordering: `lastSyncId`

- `sync_log.sync_id` is a **gap-free, strictly commit-ordered** sequence.
- To guarantee that no transaction with a lower `sync_id` commits *after* a higher one, every mutating transaction takes `pg_advisory_xact_lock(SYNC_LOCK)` immediately before it appends to `sync_log`, and holds it until commit. Sync-log appends are therefore **serialised**.
  - This is intentionally simple. At small-team write rates (≪ 100 mutations/s) the lock is held for about 1 ms per transaction. It is revisited only if metrics show contention.
- One operation can produce several sync-log rows (e.g. a status change plus an auto-added cycle plus a parent auto-complete). They all share the transaction and get consecutive ids.

---

## 4. Wire formats

### 4.1 Bootstrap: `GET /sync/bootstrap` → `application/x-ndjson` (gzip)
```jsonc
{"t":"meta","schemaHash":"9f2c…","lastSyncId":18234,"groups":["workspace","team:0192…","user:0193…"],"serverTime":"…"}
{"t":"row","m":"Team","d":{"id":"…","key":"ENG", …}}
{"t":"row","m":"Issue","d":{"id":"…","teamId":"…","number":42, …}}
…
{"t":"end","rows":151234}
```
- Rows are read inside one `REPEATABLE READ` snapshot, which includes `max(sync_id)`. That makes the snapshot consistent with `lastSyncId`.
- Optional `?groups=team:<id>` gives a **partial bootstrap** for groups added later (see §6).
- The client writes rows to IDB in chunks (worker) and becomes interactive once the `end` frame arrives.

### 4.2 Content: `GET /sync/content?parent=issue:<id>[,issue:<id>…]`
Returns the content rows for the given parents (max 50 per request) plus the `lastSyncId` they are consistent with. The client marks those parents **hydrated**.

### 4.3 WebSocket: `GET /sync/ws?since=<lastSyncId>&clientId=<uuid>`
Authenticated by the session cookie.

Server → client messages:
```jsonc
{"t":"deltas","packets":[
  {"id":18235,"a":"I","m":"Issue","d":{…}},          // insert (full row)
  {"id":18236,"a":"U","m":"Issue","d":{…}},          // update (full row → idempotent upsert)
  {"id":18237,"a":"A","m":"Issue","mid":"…"},        // archive
  {"id":18238,"a":"V","m":"Issue","mid":"…"},        // unarchive
  {"id":18239,"a":"D","m":"Comment","mid":"…"},      // hard delete (purge)
  {"id":18240,"a":"G","added":["team:…"],"removed":[]} // sync-group change for this user
], "ack":[{"clientId":"…","seq":57}]}               // mutations confirmed in these packets
{"t":"resync","reason":"schema|too_old|groups"}     // client must re-bootstrap
{"t":"presence","subject":"issue:…","users":["…"]}  // ephemeral, not in sync_log
{"t":"ping"}
```
Client → server messages: `{"t":"presence","subject":"issue:…","state":"viewing|editing"}` and `{"t":"pong"}`.

**Catch-up:** on connect, the server streams `sync_log` rows with `sync_id > since` filtered by the user's groups, then switches to live mode. If `since` is older than the retention window (30 days), or `schemaHash` differs, the server sends `resync`.

### 4.4 Mutations: `POST /sync/mutate`
```jsonc
// request
{"clientId":"…","schemaHash":"9f2c…","mutations":[
  {"seq":57,"op":"issue.update","input":{"id":"…","priority":1},"at":"2026-11-06T10:00:00Z"},
  {"seq":58,"op":"comment.create","input":{"id":"<uuidv7>","issueId":"…","body":{…}}}
]}
// response
{"results":[
  {"seq":57,"status":"ok","lastSyncId":18236},
  {"seq":58,"status":"error","error":{"code":"NOT_FOUND","message":"Issue was deleted"}}
]}
```
- The server processes a batch **in seq order**, with **one DB transaction per mutation** (one failure doesn't block the others).
- **Idempotency:** the server stores `(clientId → lastProcessedSeq)`. Re-sent mutations with `seq ≤ lastProcessedSeq` return their stored result without being re-executed.
- **Ordering across reconnects:** the client never sends seq N+1 before N has been sent. Batches are sent one at a time per client.

---

## 5. Client algorithm

### 5.1 Pending mutation lifecycle
```
created ─► queued (persisted in IDB) ─► sent ─► acked(lastSyncId=N) ─► confirmed (client lastSyncId ≥ N) ─► removed
                                          └──► rejected ─► removed + rebase + user-visible toast
```

### 5.2 Applying deltas (rebase)
1. Apply each packet to the **base state** (upsert, archive, delete) and persist it to IDB.
2. Remove pending mutations that are now **confirmed**.
3. **Recompute the overlay:** re-run `optimistic()` for the remaining pending mutations, in seq order, on top of the new base. Only models touched by the delta or by pending mutations are recomputed.
4. MobX notifies the affected components.

`optimistic(store, input)` is defined next to each operation in `packages/operations`. It must be **deterministic and side-effect free** apart from the store. Server-computed values (issue `number`, timestamps, automation side effects) are left as placeholders until the delta arrives; for example the identifier renders as `ENG-…`.

### 5.3 Offline
- Offline is detected by WebSocket close plus failed pings. The UI shows an offline badge, and all eager data remains usable.
- Mutations queue in IDB and survive reloads. On reconnect: **catch-up deltas first, then flush the queue** in seq order.
- Content that was never hydrated shows "Available when online".

### 5.4 Conflicts
| Case | Resolution |
|---|---|
| Two users change *different* fields | Both apply, because operations are field-level |
| Two users change the *same* scalar field | Server order wins (last write wins), and both changes are visible in history |
| Edit to a deleted or invisible record | Rejected with `NOT_FOUND` / `FORBIDDEN`. The overlay is dropped and the user sees a toast. |
| Invariant violated by concurrent change (e.g. a status deleted meanwhile) | Rejected with `CONFLICT` plus a message |
| **Rich text** (description, document) | `issue.updateDescription({id, baseVersion, doc})`. The server rejects it with `CONFLICT` if `baseVersion ≠ current`, and the client opens the merge UI (FR-COL-10). Real-time CRDT editing is v2. |

### 5.5 Undo / redo
At dispatch time the runner records the **inverse operation**, computed from the view state (e.g. `issue.update({id, priority: <old>})`). Undo dispatches the inverse as a *new* mutation, so it goes through the same pipeline. The stack is per tab, in memory only, holds 100 entries, and is cleared on `resync`.

---

## 6. Sync groups at runtime

- A user's groups = `workspace` + `user:<id>` + `team:<id>` for each private team they belong to.
- When membership changes, the server emits a `G` packet **to that user only**:
  - **added:** the client calls `GET /sync/bootstrap?groups=<added>`, then continues with deltas.
  - **removed:** the client deletes every row whose groups are now all invisible, from memory and from IDB.
- A row's `groups` can change (e.g. a project loses its last public team). The repo logs `D` with the old groups, then `U` (the full row) with the new ones, under consecutive ids: users who lose visibility get only the `D`, users who gain it only the `U` (an upsert), and users who keep it get both in one batch, because the hub never splits that pair across batches or pages (SPEC-002 Q5).
- A row reaches a client with `syncGroups` cut down to the groups that client is in, so it never learns the id of a private team it isn't a member of (SPEC-002 Q6).

---

## 7. Server algorithm (executor)

```
handle(op, input, actor):
  def = registry.get(op)                         → UNKNOWN_OPERATION
  checkScope(actor, def)                         → FORBIDDEN
  input = def.input.parse(input)                 → INVALID_INPUT
  BEGIN
    refs = resolve(input, actor)                 → NOT_FOUND (also when invisible)
    authorize(actor, def.permission, refs)       → FORBIDDEN
    changes = def.handler(ctx, input)            // writes rows via repo layer
    automations(changes)                         // same transaction (state-machines.md)
    assertInvariants(changes)                    → CONFLICT
    lock(SYNC_LOCK); appendSyncLog(changes); appendOutbox(events)
  COMMIT
  NOTIFY 'sync', lastSyncId
  return { lastSyncId, result }
```

The repo layer is the **only** code allowed to write synced tables. It computes the changed rows and their `groups`, so handlers cannot forget to log a change.

---

## 8. Schema evolution

- `schemaHash` = a hash of the synced model definitions. When it changes, clients receive `resync` and do a full bootstrap.
- Operation inputs evolve **additively** (optional fields only). A removed or renamed operation makes the server reply `CLIENT_OUTDATED`, and the client reloads.
- DB migrations run at server start, guarded by an advisory lock, before the server accepts connections.

---

## 9. Limits & tuning (initial values)

| Parameter | Value |
|---|---|
| Mutation batch size | ≤ 100 mutations or 1 MB |
| Delta packet batch | ≤ 500 packets per message |
| Content fetch | ≤ 50 parents per request |
| Prefetch | Issues assigned to me, issues in the current cycle, and the first 50 visible rows of the active list |
| `sync_log` retention | 30 days |
| Ping interval / timeout | 25 s / 10 s |
| Reconnect backoff | 0.5 s → 30 s with jitter |

---

## 10. Test obligations

1. **Convergence property:** with random operations from N clients and random network faults, all clients equal the server state once the system is quiescent.
2. **Exactly-once:** a mutation is never lost and never applied twice across crashes, reloads, and resends.
3. **Ordering:** deltas are applied strictly in `sync_id` order with no gaps. A gap triggers a reconnect.
4. **Group change:** visibility is gained and lost correctly, with purging on removal.
5. **Rejection:** the overlay rolls back cleanly and the UI state matches the base state.
6. **Performance:** bootstrap, warm start, and delta apply stay within the NFR budgets at the reference scale.
