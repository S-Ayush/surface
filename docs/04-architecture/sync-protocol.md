# Surface: Sync Protocol (v1)

Status: **Draft v0.5** · Date: 2026-11-12 · Decision: [ADR-0002](adr/0002-sync-strategy.md)

This is the contract between `packages/sync-client` and `apps/server`. Every wire type here lives in `packages/sync-protocol`, as a Zod codec. Decoders strip unknown keys instead of rejecting them, so additive changes stay compatible. Changes are listed in §11.

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

### 4.1 Bootstrap: `GET /sync/bootstrap?userId=<uuid>` → `application/x-ndjson` (gzip)
```jsonc
{"t":"meta","schemaHash":"9f2c…","lastSyncId":18234,"groups":["workspace","team:0192…","user:0193…"],"serverTime":"…","rows":151234}
{"t":"row","m":"Team","d":{"id":"…","key":"ENG", …}}
{"t":"row","m":"Issue","d":{"id":"…","teamId":"…","number":42, …}}
…
{"t":"end","rows":151234}
```
- `schemaHash` is 64 lowercase hex characters (§8). `serverTime` is an ISO 8601 timestamp. `groups` are the connection's sync groups (§6).
- Every row `d` is a JSON object with a UUID `id`. Its other fields are checked by the client store against the model definition, not by the wire codec. Columns the model does not declare are dropped.
- Archived rows are sent with `"archived":true` on the frame. For live rows the server may omit the field or send `false`. Clients keep archived rows, because a later `V` packet carries only the id.
- `meta.rows` is the exact number of `row` frames that follow (counted in the same snapshot), so the client can show bootstrap progress. `end.rows` repeats it, so the client can detect a truncated stream.
- Rows are read inside one `REPEATABLE READ` snapshot, which includes `max(sync_id)`. That makes the snapshot consistent with `lastSyncId`.
- `userId` is the user the client's replica belongs to. The server compares it with the session's user before streaming anything: another user → `401`, so a replica never receives another user's rows (SPEC-002 E14). No `userId` (a client from before v0.5) → `426 CLIENT_OUTDATED`; a `userId` that is not a UUID → `400`. A v0.5 client treats `426` as "outdated" and shows the reload banner. An older client takes it for a failed load: on a cold start it shows the load-failure page, whose reload loads the new app; a running old tab learns it is outdated from the socket first (`resync(schema)`, §4.3).
- Optional `?groups=team:<id>` gives a **partial bootstrap** for groups added later (see §6). Until M7 the server answers it with `400`.
- A model's `groups` field, if it declares one, holds the row's sync groups cut to the receiving connection's groups (SPEC-002 Q6, Q8).
- The body is gzip-encoded when `Accept-Encoding` allows it. Errors before the first frame use the SPEC-003 body: `401` (not signed in, or signed in as a user other than `userId`), `403` (an API key), `426` (no `userId`), `400`, `503` (starting).
- The client writes rows to IDB in chunks (worker) and becomes interactive once the `end` frame arrives.
- The client abandons a bootstrap whose response has not started within 30 s, like a mutate request (§4.4): a cold start fails (the app offers to try again) and a resync retries once the socket reconnects. The rows that follow have no deadline, since a large workspace streams for seconds.

### 4.2 Content: `GET /sync/content?parent=issue:<id>[,issue:<id>…]`
Returns the content rows for the given parents (max 50 per request) plus the `lastSyncId` they are consistent with. The client marks those parents **hydrated**.

### 4.3 WebSocket: `GET /sync/ws?since=<lastSyncId>&clientId=<uuid>&userId=<uuid>&schemaHash=<hash>`
Authenticated by the session cookie. `since` is a non-negative decimal integer without leading zeros. `schemaHash` lets the hub answer `resync(schema)` before catch-up. `userId` is the user the client's replica belongs to (SPEC-002 E14). The hub checks, in this order: the session (none → `4001`, below); the connect parameters (a missing `userId` → `resync(schema)`, below; any other invalid parameter → `400`); `userId` against the session's user (another user → `4001`, as for no session); then the `clientId`'s owner (`403`). The `userId` check comes before the owner check, so a tab whose `clientId` its own user registered, opened under another user's cookie, gets `4001` and re-checks the session instead of a `403` it can't read. A socket closed or refused at any of these steps is never registered with the hub.

**No `userId`** (a client from before v0.5): the hub accepts the upgrade, sends `resync(schema)`, then only pings, as after a `schemaHash` mismatch. It keeps the socket as an idle connection with no user, groups or `clientId` (so it is pinged and closed on shutdown), never catches it up and never sends it a delta, and the `clientId` is neither checked nor registered. It still belongs to its session: a sign-out closes it with `4001` like any socket of that session. Old clients already turn `resync(schema)` into the reload banner (SPEC-002 E7); a refused upgrade would only be a `1006`, so an idle old tab would never learn it is outdated.

Server → client messages:
```jsonc
{"t":"deltas","prev":18234,"packets":[
  {"id":18235,"a":"I","m":"Issue","d":{…}},          // insert (full row)
  {"id":18236,"a":"U","m":"Issue","d":{…}},          // update (full row → idempotent upsert)
  {"id":18237,"a":"A","m":"Issue","mid":"…"},        // archive
  {"id":18238,"a":"V","m":"Issue","mid":"…"},        // unarchive
  {"id":18239,"a":"D","m":"Comment","mid":"…"},      // hard delete (purge)
  {"id":18240,"a":"G","added":["team:…"],"removed":[]} // sync-group change for this user
], "ack":[{"clientId":"…","seq":57}]}               // mutations confirmed in these packets
{"t":"resync","reason":"schema|too_old|groups"}     // client must re-bootstrap
{"t":"presence","subject":"issue:…","users":["…"]}  // ephemeral, not in sync_log (M4, not in v0)
{"t":"ping"}
```
Client → server messages: `{"t":"pong"}`, and from M4 `{"t":"presence","subject":"issue:…","state":"viewing|editing"}`.

**`deltas` rules** (checked by the decoder):
- `prev` is the id of the last packet the server sent **on this connection** before this message, or `since` for the first one. If `prev` is greater than the client's `lastSyncId`, the client has missed packets: it applies nothing from the message, closes the socket and reconnects with `since = lastSyncId` (SPEC-002 E1). If `prev` is less than or equal to `lastSyncId`, the message is contiguous with what the client has: it skips packets with `id ≤ lastSyncId` as duplicates (E2) and applies the rest. The server never needs to rely on the second case; it only makes a re-delivery harmless.
- Packet ids are strictly increasing and greater than `prev`. Ids can skip, because the stream is filtered by sync groups. At most 500 packets per message.
- `ack` lists this connection's own mutations that committed in the `sync_log` range the message covers. `packets` may be **empty only when `ack` is not**: a mutation can write rows this client cannot see, and its pending entry must still be confirmed. A message with neither is invalid.
- **Catch-up carries acks too.** The catch-up from `since` includes the acks for every mutation of the connection's `clientId` that committed in `(since, head]`, in an ack-only message where none of its packets are visible. A client whose live ack was lost (the socket dropped) relies on this, because a change it cannot see is confirmed only by its ack: the client's `lastSyncId` never reaches it.
- `G` packets are decoded in v0 because they take part in the ordering. Until M7, the client handles one with a full re-bootstrap.
- **Archived state changes only through `A` and `V`.** `I` inserts a live row, and `U` replaces the row's fields but keeps whether it is archived. An edit that also unarchives a row ("any edit" in state-machines.md §2) emits both `U` and `V` in the same transaction. This keeps a client that applied the stream identical to one that cold-started from a bootstrap (whose `row.archived` reflects the same state).

**Close codes:** `1012` server shutting down (reconnect with backoff) · `4001` session revoked (stop reconnecting, go to login; SPEC-002 E10). The server may also close with `1003` (a binary frame), `1008` (a message other than `pong`), `1009` (a client message over 4 KiB), `1011` (catch-up failed) or `1013` (try again later: the hub is not running yet, or the client fell too far behind). The client treats these like any other close: it reconnects with backoff and catches up from its `lastSyncId`.

**Refused before the upgrade** (SPEC-003 error body): `503` with `Retry-After` while the server starts or stops, `403` for an `Origin` other than `SURFACE_URL`'s, for an API key (SPEC-002 §4.3, Q9) or for a `clientId` another user registered through `POST /sync/mutate` (SPEC-002 §4.4), `400` for invalid connect parameters (except a missing `userId`, above). A browser sees each of these as an abnormal close (`1006`) and retries with backoff. **Live updates unavailable** (SPEC-005 §8): the client cannot tell a proxy that strips the upgrade from these refusals or from a server that is down, so it asks the server over plain HTTP. After **three attempts in a row that close, or go silent, before opening**, it requests `GET /auth/session`; any status below `500` (a `401` included) means the server answers. It then dials at once, and if that attempt also fails before opening, live updates are unavailable: the app shows the banner and the client keeps retrying with backoff. A network error, `502`, `503` or `504`, or no answer within 10 s, means the server may be down or restarting: no banner, and it asks again after the next failed attempt. A server back from a restart opens on the attempt its answer starts, so a restart never shows the banner. The count and the answer reset when an attempt opens, when the browser's `online` event fires, and when the client stops.

**No valid session** (none, or not `userId`'s): the hub accepts the upgrade and then closes at once with `4001`. It does not answer `401`. A browser cannot read the HTTP status of a refused upgrade, which looks like any network failure (`1006`), so the client would keep retrying. This is how a client that was offline when its session was revoked learns about it. Nothing is sent before the close.

**Revoked on any replica:** a session that ends (sign-out, and later revoke and password reset) closes its sockets with `4001` on every replica. The server sends `NOTIFY session_revoked` with the session ids, and every hub's listen connection hears it next to `sync`. A replica whose listen connection is down at that moment misses it, and those sockets stay open until they disconnect; their next connect is closed with `4001` as above.

**Catch-up:** on connect, the server streams `sync_log` rows with `sync_id > since` filtered by the user's groups, then switches to live mode. If `since` is older than the retention window (30 days) or ahead of the server's head (a database restored from a backup, SPEC-002 Q10), it sends `resync(too_old)`; if `schemaHash` differs, `resync(schema)`. A connection's groups are read once, before the upgrade; when a private team's membership may change them, the hub sends `resync(groups)` (§6). After a `resync` the server sends nothing more on that connection but pings, and the client closes it.

### 4.4 Mutations: `POST /sync/mutate`
```jsonc
// request
{"clientId":"…","userId":"…","schemaHash":"9f2c…","mutations":[
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
- **Idempotency:** the server stores `(clientId → lastProcessedSeq)` with the results of the last 100 seqs (SPEC-002 Q11). Re-sent mutations with `seq ≤ lastProcessedSeq` return their stored result without being re-executed; an `error` result is stored too, so a rejected mutation is never run again. Each mutation's transaction locks the client's row first, so concurrent resends of one batch get the same results. A seq older than the kept results gets `{"status":"error","error":{"code":"CONFLICT",…}}`; a client that follows this protocol never sends one.
- **Whose queue:** `userId` is the user the client's queue belongs to. The server compares it with the session's user before anything runs or a `clientId` is registered (SPEC-002 E14), so a queue is never committed as whoever signed in next on the browser.
- **Ownership:** a `clientId` belongs to the user whose mutation first used it. Requests from another user with it get `403` (below), and so does a WebSocket opened with it (§4.3).
- A mutation that changed no row gets, as its `lastSyncId`, the newest `sync_id` this client's connection receives (in the user's groups, of a synced model; 0 when there is none): no ack comes for it, and the global head may be a row the client never receives.
- **Ordering across reconnects:** the client never sends seq N+1 before N has been sent. Batches are sent one at a time per client.
- A batch holds 1–100 mutations with **consecutive, ascending** seqs, starting at 1 for a new client. `input` is any JSON value. `at` is optional and informational (SPEC-002 E11). `results` has one entry per mutation, in the same seq order.
- **CSRF** (SPEC-001 §6.1, Q7; the server checks it since PLAN-001 S3): a signed-in browser sends the `surface_csrf` cookie's value in the `X-CSRF-Token` header, read again for every request. API keys (M6) don't use cookies and send none.
- **Whole-request errors** use the SPEC-003 §9 body `{"ok":false,"error":{"code","message","correlationId"}}`:
  - `426 CLIENT_OUTDATED`: `schemaHash` differs from the server's, or the body has no `userId` (a client from before v0.5). The client shows the reload banner. A missing `userId` wins over any other problem with the body, so an old client always reloads instead of having its queue refused as invalid (`400`, below).
  - `401 UNAUTHENTICATED`: no session, or a session of a user other than `userId` (SPEC-002 E14). Nothing ran. The queue stops sending and keeps every mutation, and the client redials the socket, which tells it which case this is: `4001` (no session, or another user's) leaves the socket down for good, so the queue stays offline until its user signs in again and a new store adopts it, and the app checks the session (SPEC-001 E14); a socket that opens again resends after the backoff, which grows while the answer stays `401`. That backoff is the sync client's: today the web app also answers each `401` by checking the session and, when someone is signed in, opening a new store, whose queue starts without it. So a server or proxy that disagrees with itself (the socket accepted, mutate `401`) still makes the app retry quickly (session-d2 Handoffs, to C).
  - `403 CSRF_INVALID`: the token is missing or does not match the session, typically because the CSRF cookie was cleared or lost while the session cookie stayed. The client fetches `GET /auth/session`, which sets the cookie again, and resends the same batch at once. Refused a second time, or if the session call fails (`401`: no session), it backs off and retries like any failure below, so a token that stays wrong never makes requests loop. Any other `403` backs off without a renewal.
  - `403 FORBIDDEN` for an API key (it writes through the operations API) or a `clientId` another user registered. The client backs off like any failure.
  - `429 RATE_LIMITED` with `Retry-After` (SPEC-002 Q12): a mutation of the batch hit the rate limit. The mutations before it are committed, and the rest were not run; resending the same batch replays the first and runs the rest. The client resends the same batch after `Retry-After` seconds (at least 0.5 s and at most 30 s, plus up to 250 ms of jitter), and the rate limit does not grow its backoff. It reads the header whatever the body is (a proxy's page included). Without a readable `Retry-After` (a whole number of seconds) it backs off like any failure; on any other status the header is ignored.
  - `400 SEQ_GAP`: the batch starts after `lastSeq + 1`. The body adds `"lastSeq": <n>`, the last seq the server processed for this client, so the client resends from `lastSeq + 1`.
  - `413` (body over the limit, §9) and any other `400`/`422` with that body (a request the server read and refused): the same batch would fail forever, so the client sends smaller batches until the mutation at fault is alone, then rejects it locally (`PAYLOAD_TOO_LARGE`, or the server's code and message) and sends the rest. The seq it skipped makes the next batch a `SEQ_GAP`, which renumbers past it. The client also refuses at dispatch a mutation whose UTF-8 encoding exceeds 90 % of the limit.
  - `503` with `Retry-After` (the server is still starting, SPEC-003 §9): like `429`, the client resends after it.
  - Anything else (5xx, a network error, an unreadable body) retries the same batch with backoff. An attempt with no answer after 30 s (the request, plus the CSRF renewal and resend when there is one), or in flight when the socket drops, is abandoned and sent again; the server dedupes it.

---

## 5. Client algorithm

### 5.1 Pending mutation lifecycle
```
created ─► queued (persisted in IDB) ─► sent ─► acked(lastSyncId=N) ─► confirmed (client lastSyncId ≥ N, or an `ack` for its seq) ─► removed
                                          └──► rejected ─► removed + rebase + user-visible toast
```
A mutation is sent only once it is persisted. If the replica has already reached N when the result arrives (a resend after a reload, answered from the server's record, gets no `ack`), it is confirmed at once. Each tab sends only the queue it owns; the next tab to start adopts a queue left behind (SPEC-002 E5).

### 5.2 Applying deltas (rebase)
1. Apply each packet to the **base state** (upsert, archive, delete) and persist it to IDB.
2. Remove pending mutations that are now **confirmed**.
3. **Recompute the overlay:** re-run `optimistic()` for the remaining pending mutations, in seq order, on top of the new base. Only models touched by the delta or by pending mutations are recomputed.
4. MobX notifies the affected components.

`optimistic(store, input)` is defined next to each operation in `packages/operations`. It must be **deterministic and side-effect free** apart from the store. Server-computed values (issue `number`, timestamps, automation side effects) are left as placeholders until the delta arrives; for example the identifier renders as `ENG-…`.

### 5.3 Offline
- Offline is detected by WebSocket close plus failed pings. The UI shows an offline badge, and all eager data remains usable.
- Mutations queue in IDB and survive reloads. On reconnect the queue flushes in seq order as soon as the socket is open, while catch-up runs. Confirmation waits for the replica to reach each commit (or its `ack`), so the order of catch-up and flush does not matter.
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
- **Until `G` packets (M7)** the hub sends `resync(groups)` instead, and the client bootstraps again with its new groups, which also drops the team's rows (PLAN-001 S9, SPEC-002 Q13). It goes to a connection whose user is named by a new membership row of a private team (live or in catch-up); to every connection in a private team's group when one of its memberships is deleted, since a deleted row carries no data (SPEC-002 Q4) and the hub can't tell whose it was; and, at connect, to a connection for which a private team outside its groups lost a member after its `since` (its user may have been removed while the socket was closed). Public teams' memberships change no groups.
- A row's `groups` can change (e.g. a project loses its last public team). The repo logs `D` with the old groups, then `U` (the full row) with the new ones, under consecutive ids: users who lose visibility get only the `D`, users who gain it only the `U` (an upsert), and users who keep it get both in one batch, because the hub never splits that pair across batches or pages (SPEC-002 Q5).
- A row reaches a client with its `sync_groups` cut down to the groups that client is in, so it never learns the id of a private team it isn't a member of (SPEC-002 Q6). The client receives them in the model's `groups` field, if the model declares one; other models carry no groups (SPEC-002 Q8).

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

- `schemaHash` = `computeSchemaHash(models)` from `packages/sync-protocol`: the lowercase hex SHA-256 of a canonical JSON form of `[SYNC_PROTOCOL_VERSION, models]`. For each model it covers the name, the load strategy, and each field's name, type and nullability. Models and fields are sorted by name, so declaration order doesn't matter. Client-only metadata (refs, indexes) is not hashed. Bumping `SYNC_PROTOCOL_VERSION` changes every hash. When it changes, clients receive `resync` and do a full bootstrap.
- The hash is computed in pure TypeScript rather than with `crypto.subtle`, which is async and missing on plain-HTTP origins (common for a self-hosted LAN install).
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

---

## 11. Change log

| Date | Version | Change | Handed off |
|---|---|---|---|
| 2026-11-12 | v0.5 | SPEC-002 E14 part 2, client only, no wire change. §4.4 `401`: the queue stops sending and keeps every mutation, and the client redials the socket; `4001` keeps it offline until its user signs in again, a socket that opens again resends after a backoff that grows while the answer stays `401`. | Session C (session-d2 Handoffs: the app's session check opens a new store at every `401`, so its retries skip that backoff) |
| 2026-11-12 | v0.5 | SPEC-002 E14, a codec change. The client names its user: `userId` (a UUID) in the bootstrap query (§4.1), the socket's connect parameters (§4.3) and the mutate body (§4.4). The server compares it with the session's user first: another user gets `401` on bootstrap and mutate, and `4001` on the socket, before anything is streamed, run or registered. No `userId` gets `426 CLIENT_OUTDATED` on bootstrap and mutate, and an accepted socket that receives only `resync(schema)` (`MissingUserIdError` from the three decoders, which wins over any other problem). The hub checks `userId` before the `clientId`'s owner. A v0.5 client treats a bootstrap `426` as outdated. Found by a real-server repro: a tab's queue and socket carried on under whoever signed in next. `SYNC_PROTOCOL_VERSION` stays, so no client re-bootstraps for it. | Session A (the three server checks and the `403` wording; agreed with A 2026-11-12) |
| 2026-11-12 | v0.4 | PLAN-002 S8 follow-up, client only, no wire change. §4.4: on `429` or `503` with `Retry-After` (whole seconds), the queue resends after that long (at least 0.5 s and at most 30 s, plus up to 250 ms of jitter) instead of its own backoff, and the answer resets the backoff. The header counts whatever the body is; on other statuses it is ignored. A's optional handoff from PLAN-002 S5. | — (no server change) |
| 2026-11-07 | v0.4 | PLAN-001 S9, server only, no codec change (`groups` was already a `resync` reason). The hub sends `resync(groups)` when a private team's membership may change a connection's groups (§4.3, §6, SPEC-002 Q13): live, in catch-up, and at connect for a removal while the socket was closed. Nothing more is sent on that connection. A socket's session is read again once the hub has registered it, so a sign-out during the upgrade still closes it with `4001`. Found by the S9 security review (M1, L2). | Session D (Log): the client already handles every `resync` by bootstrapping again; nothing to change |
| 2026-11-07 | v0.4 | Status only, no wire change: §4.4's CSRF note no longer says it is pending until PLAN-001 S3 (on `main`). Approved by the user | — |
| 2026-11-07 | v0.4 | PLAN-002 S5, server only, no codec change. `POST /sync/mutate` is served (§4.4): results of the last 100 seqs are kept, rejected mutations included (SPEC-002 Q11); a `clientId` belongs to its first user, `403` for anyone else on mutate and on the socket (§4.3); `403` for an API key; `429` with `Retry-After` stops a batch (Q12); a mutation that changed nothing gets the newest `sync_id` the client receives. | Session D (session-a2 Handoffs) |
| 2026-11-07 | v0.4 | PLAN-002 S10, client only, no wire change. "Live updates unavailable" (§4.3, SPEC-005 §8): three connection attempts in a row that never open, then `GET /auth/session` answers below `500`, then one more attempt fails. A server that is down or restarting never trips it (S10 review; approach chosen by the user) | — (no server change) |
| 2026-11-07 | v0.4 | PLAN-001 S3, server only, no wire change. A session ended on one replica closes its sockets on every replica (`NOTIFY session_revoked`, §4.3). | Session A (Log) |
| 2026-11-07 | v0.4 | PLAN-002 S8 follow-up (CSRF), no codec change. `POST /sync/mutate` carries `X-CSRF-Token` from the `surface_csrf` cookie; `403 CSRF_INVALID` makes the client renew it through `GET /auth/session` and resend once (§4.4, SPEC-001 §6.1, Q7). `@surface/sync-protocol` exports `CSRF_HEADER`, `CSRF_COOKIE`, `CSRF_INVALID` and `SESSION_PATH` for both sides | Session A (session-d2 Handoffs; A defined the server side in PLAN-001 S3) |
| 2026-11-07 | v0.4 | PLAN-002 S9, client only, no wire change. The client abandons a bootstrap whose response has not started within 30 s (§4.1); found by the sync simulation, where a hung bootstrap left a tab loading for good | — (no server change) |
| 2026-11-07 | v0.4 | PLAN-002 S4, server only, no codec change. The hub refuses before the upgrade with `503`, `403` (a foreign `Origin`, or an API key, SPEC-002 Q9) or `400`, and may close with `1003`, `1008`, `1009`, `1011` or `1013`, all of which the client already treats as "reconnect with backoff" (§4.3). A `since` ahead of the server's head gets `resync(too_old)` (Q10). After a `resync` the server sends nothing more but pings (§4.3) | — |
| 2026-11-07 | v0.4 | PLAN-002 S3, server only, no codec change. Bootstrap answers `400` to `?groups=` until M7; errors before the first frame use the SPEC-003 body with `401`, `403` (an API key, SPEC-002 Q7) or `503`; the body is gzipped when `Accept-Encoding` allows it (§4.1). A row's groups travel in the model's `groups` field, if declared (§4.1, §6, SPEC-002 Q8) | — |
| 2026-11-06 | v0.4 | PLAN-002 S8, no wire change. Client: the queue flushes once the socket is open rather than after catch-up (§5.3); a result whose `lastSyncId` the replica has already passed confirms at once; queues are adopted across tabs (§5.1, SPEC-002 E5); `413` and other refused requests split the batch and reject the mutation at fault, and requests time out after 30 s (§4.4). Stated, for the server: catch-up carries the client's acks for `(since, head]` (§4.3) | Session A (Handoffs row 4) |
| 2026-11-06 | v0.4 | PLAN-002 S7. Server: an upgrade without a valid session is accepted and closed with `4001`, not refused with `401` (§4.3). Clarified, no wire change: `prev > lastSyncId` is a gap; `prev ≤ lastSyncId` skips packets with `id ≤ lastSyncId` and applies the rest (§4.3, SPEC-002 E1) | Session A (Handoffs) |
| 2026-11-06 | v0.3 | PLAN-002 S6: `meta.rows` (required), the exact row count, for the progress bar; `row.archived` (optional boolean; `true` = archived) so a cold start matches clients that saw the `A` packet. While v0.3 was unreleased, `archived` was first `true`-only and was widened to boolean before release. Also stated: archived state changes only through `A`/`V`; `U` keeps it (§4.3) | Session A (Handoffs) |
| 2026-11-06 | v0.2 | PLAN-002 S1 codecs: `deltas.prev`; acks without packets; `schemaHash` in the WebSocket URL; close codes; batch rules (1–100, consecutive seqs); `lastSeq` on `SEQ_GAP`; `CLIENT_OUTDATED` = 426; schema hash definition; `presence` deferred to M4 | Session A (session-d-sync-client.md, Handoffs) |
