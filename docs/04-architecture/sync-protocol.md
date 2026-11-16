# Surface: Sync Protocol (v1)

Status: **Draft v0.8** (built: server PLAN-011 S4b) · Date: 2026-11-13 · Decisions: [ADR-0002](adr/0002-sync-strategy.md), [ADR-0020](adr/0020-partial-issue-sync.md) (partial issue sync), [ADR-0022](adr/0022-purge-content-unlogged.md) (purge), [ADR-0023](adr/0023-document-migration-unlogged.md) (document migrations)

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
| **eager** | Workspace, User, Team, TeamMembership, WorkflowStatus, Label, Issue (*without* description; **per subscribed team**, below), IssueRelation, Attachment (metadata), Cycle (without snapshot), Project (without description), ProjectTeam, ProjectMember, ProjectMilestone, Initiative, InitiativeProject, Document (title and metadata only), Template, CustomView, ViewDefault, plus user-scoped: ViewPreference, Favorite, Subscription, Notification, ApiKey (metadata), Draft, Preferences | At bootstrap, kept live by deltas |
| **content** | IssueContent (`description`), Comment, Reaction, IssueHistory, ProjectContent (`description`), ProjectUpdate, DocumentContent, CycleSnapshot | On demand, **per parent** (§4.2). Cached in IDB, and kept live by deltas *once the parent is hydrated* |

Content is split into separate tables or models on the server (e.g. `issue_content`), so eager rows stay small.

- **Content models declare their parent** (v0.7): `parent: { model, field }` in `defineModel`. IssueContent, IssueHistory, Comment and Reaction have the parent `Issue` by `issueId` (SPEC-011, SPEC-013). The declaration is part of the schema hash (§8).
- **Labels on an issue** are the Issue's `labelIds` array; there is no IssueLabel model (SPEC-011 Q17).
- **Draft** (SPEC-012) is a user's composer and comment drafts, synced only in `user:<id>` (§6).

**Partial issue loading** (v0.8, [ADR-0020](adr/0020-partial-issue-sync.md), SPEC-011 §5.7). Issue is the one eager model that is not fully replicated. A replica holds the live issues of the teams the client subscribes to (§6.1) and the public-team issues assigned to or created by the user. Archived and deleted issues are never stored: bootstrap leaves them out, and a packet that archives or deletes an issue removes it (§4.3). An Issue's eager children (Attachment) are in its team's group only and leave the replica with it. Every other eager model stays fully replicated.

**Size budget at the reference scale** (100k issues, NFR-10): about 35 MB of eager rows uncompressed (≈ 6 MB gzipped) **per replica**, measured at the reference scale with the seed's team split (SPEC-011 §10, Q15). All 100k issue rows would be about 61 MB on their own, which is why issues load per team. This must be measured and asserted in the perf suite.

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
- **Archive state** (v0.7): a model that archives declares `archivedAt` as a synced field, and the frame's `"archived"` flag is derived from it (`true` when it is set; for live rows the server may omit the field or send `false`). The client derives its `$archived` flag from `archivedAt`. Archived rows of models other than Issue (Label) are sent and kept.
- **Issues** (v0.8): Issue rows with `archivedAt` or `deletedAt` set, and their children, are never sent. The full bootstrap (no `groups`) covers the user's home groups: `workspace`, `user:<id>`, and the groups of the teams the user is a member of, public and private. The client then subscribes its on-demand teams again (§6.1).
- `meta.rows` is the exact number of `row` frames that follow (counted in the same snapshot), so the client can show bootstrap progress. `end.rows` repeats it, so the client can detect a truncated stream.
- Rows are read inside one `REPEATABLE READ` snapshot, which includes `max(sync_id)`. That makes the snapshot consistent with `lastSyncId`.
- `userId` is the user the client's replica belongs to. The server compares it with the session's user before streaming anything: another user → `401`, so a replica never receives another user's rows (SPEC-002 E14). No `userId` (a client from before v0.5) → `426 CLIENT_OUTDATED`; a `userId` that is not a UUID → `400`. A v0.5 client treats `426` as "outdated" and shows the reload banner. An older client takes it for a failed load: on a cold start it shows the load-failure page, whose reload loads the new app; a running old tab learns it is outdated from the socket first (`resync(schema)`, §4.3).
- **Partial bootstrap** (v0.8): `GET /sync/bootstrap?groups=team:<id>[,team:<id>…]&userId=<uuid>&schemaHash=<hash>` streams the rows of those teams' groups (their live Issues and the Issues' eager children, nothing else) from one snapshot, in the same frames, with `lastSyncId` = that snapshot's and `meta.groups` = the accepted teams' groups. Each row's `groups` is cut to the connection's groups (the home groups plus the accepted teams), so a public issue keeps the user's own `user:<id>` group. `groups` lists 1 to 100 distinct `team:<uuid>` groups; anything else (`workspace`, a `user:` group, a repeat) is `400`. The client calls it after the server accepts a subscription (§6.1). An unknown team, or a private team the user isn't a member of, gives an empty stream (`meta`, then `end`, with 0 rows), never an error, so the answer reveals nothing. `groups` requires `schemaHash`: without it the answer is `400`, and with one that differs from the server's it is `426 CLIENT_OUTDATED`, the same rule as `/sync/content` (§4.2). The full bootstrap checks `schemaHash` too when the client sends one (`426` if it differs). No buffering is needed: packets after the subscription are full rows, applied as they arrive, and the answer's rows are stored at version `lastSyncId` through the per-row version and tombstone rules, so whichever is newer wins. (Until v0.8 the server answered `?groups=` with `400`.)
- A model's `groups` field, if it declares one, holds the row's sync groups cut to the receiving connection's groups (SPEC-002 Q6, Q8).
- The body is gzip-encoded when `Accept-Encoding` allows it. Errors before the first frame use the SPEC-003 body: `401` (not signed in, or signed in as a user other than `userId`), `403` (an API key), `426` (no `userId`, or a `schemaHash` that differs from the server's), `400` (an invalid parameter, or `groups` without `schemaHash`), `503` (starting).
- The client writes rows to IDB in chunks (worker) and becomes interactive once the `end` frame arrives.
- The client abandons a bootstrap whose response has not started within 30 s, like a mutate request (§4.4): a cold start fails (the app offers to try again) and a resync retries once the socket reconnects. The rows that follow have no deadline, since a large workspace streams for seconds.

### 4.2 Content: `GET /sync/content?parents=issue:<id>[,issue:<id>…]&userId=<uuid>&schemaHash=<hash>`
The contract since v0.7 (SPEC-011 §5.2, §5.3). Authenticated by the session cookie, like bootstrap.

**Request:** 1–50 distinct parents, each `issue:<uuid>`. Unknown or invisible parents are left out of the answer, never an error. Content of an archived or deleted issue the user can see is returned too (its read-only page, SPEC-015 §3.4).

**Response:** `application/x-ndjson`, gzip when accepted:
```jsonc
{"t":"meta","lastSyncId":18234,"parents":["issue:0193…"],"rows":57}
{"t":"row","m":"IssueContent","d":{"id":"0193…","issueId":"0193…","teamId":"…","description":{…},"version":3}}
{"t":"row","m":"IssueHistory","d":{…}}
…
{"t":"end","rows":57}
```
- `parents` lists the requested parents that were found and are visible. Every one of them is hydrated by this answer, even one with no rows.
- **Byte budget** (SPEC-011 §5.2, D16): an answer holds at most 4 MiB of content rows (§9), measured on the server. Parents are taken whole, in request order, while they fit; the first visible parent always comes whole, whatever its size, so a request for one parent is never cut. A visible parent left out under the budget is absent from `meta.parents`, exactly like one not found: the client marks it not hydrated (step 2 below) and asks for it again in a later request.
- Rows are IssueContent, IssueHistory, Comment and Reaction. The client store checks each `d` against its model, as for bootstrap.
- Everything is read in one `REPEATABLE READ` snapshot that includes `max(sync_id)`: that is `lastSyncId`, called `C` below.
- `meta.rows` and `end.rows` count the row frames, so a truncated stream is detected.
- Errors before the first frame use the SPEC-003 body: `400` (no parents, more than 50, a malformed or duplicate parent, a `userId` that isn't a UUID, or no `schemaHash`), `401` (not signed in, or signed in as someone other than `userId`), `403` (an API key: API callers use `issue.get`), `426 CLIENT_OUTDATED` (no `userId`, or a different `schemaHash`; the client reloads), `503` (starting).

**Hydration.** A parent is **hydrated** when the client holds all of its content and keeps it live.
1. When a tab sends a content request, it marks each requested parent **hydrating**, in memory in that tab, and **buffers** the content packets for it instead of dropping them.
2. **Applying the answer:** the tab stores the rows with version `C`, through the per-row version and tombstone rule. It **skips every parent whose Issue row is missing or tombstoned** in the replica (for example, purged while the request was in flight): those rows aren't stored and the parent isn't hydrated. It marks the found parents hydrated, then replays its buffered packets with id > `C`. Requested parents that weren't found go back to not hydrated, and their buffer is dropped. A failed request drops the buffer and the mark.
3. **Live:** `I` and `U` content packets for a hydrated parent apply like any delta. Those for a parent that is neither hydrated nor hydrating are dropped: they would be partial.
4. **Content `D` packets always apply, as tombstones**, hydrated or not. A `D` carries only `mid`, so a tab can't tell its parent; a tombstone for a row it never held costs one small record and stops a later answer at a lower `C` from bringing the row back.
5. **Content is dropped when its Issue is absent after a batch.** After a whole delta batch is applied, the content rows and hydration mark of any parent whose Issue row is now absent are removed. A group change's `D`+`U` pair leaves the Issue present after the batch (§6), so it keeps its content. A delete, an archive (an Issue leaves the replica, §4.3) or a purge leaves it absent. A purge logs no `D` for content rows ([ADR-0022](adr/0022-purge-content-unlogged.md)); this rule removes them.
6. **An `I` packet for an Issue hydrates it**, for every client that receives it: every content row is written in the creating transaction or later, and the repo logs the Issue row first.
7. **A content mutation hydrates its parent first.** An operation that writes content declares `contentParent(input)` (SPEC-003 §3), and dispatch awaits that parent's hydration, and its rows being paged into memory, before it runs the `optimistic`. Offline, with a parent never hydrated, the UI offers no content edit.
8. **Resync** clears every hydration mark with the rest of the replica.

The hydrated set is stored in IDB in the same transaction as the rows it covers, so tabs share it. A warm start doesn't page content into memory: rows are read per parent when an issue is opened or prefetched, or before a content mutation. Paging rows in rebuilds the overlay, so pending mutations on them replay. Content is hydrated and prefetched only for issues of subscribed teams, because child rows travel only in `team:<id>` (§6). An archived or deleted issue's page reads one answer and holds it in memory only, never stored or hydrated. Cache size and prefetch are in §9.

### 4.3 WebSocket: `GET /sync/ws?since=<lastSyncId>&clientId=<uuid>&userId=<uuid>&schemaHash=<hash>&teams=<id>,<id>`
Authenticated by the session cookie. `since` is a non-negative decimal integer without leading zeros. `schemaHash` lets the hub answer `resync(schema)` before catch-up. `userId` is the user the client's replica belongs to (SPEC-002 E14). `teams` (v0.8, optional) lists the public teams the client subscribes to from the start, member teams and on-demand ones (§6.1), comma-separated, at most 100; catch-up uses the accepted set. With `teams` (even empty, `teams=`), the first message is `subscribed` with the accepted teams and `at` = `since`, before any `deltas`. **Without `teams`** (a client from before v0.8) the connection follows every team the user is a member of, public ones included, as the full bootstrap does (§4.1), and no `subscribed` is sent. The hub checks, in this order: the session (none → `4001`, below); the connect parameters (a missing `userId` → `resync(schema)`, below; any other invalid parameter → `400`); `userId` against the session's user (another user → `4001`, as for no session); then the `clientId`'s owner (`403`). The `userId` check comes before the owner check, so a tab whose `clientId` its own user registered, opened under another user's cookie, gets `4001` and re-checks the session instead of a `403` it can't read. A socket closed or refused at any of these steps is never registered with the hub.

**No `userId`** (a client from before v0.5): the hub accepts the upgrade, sends `resync(schema)`, then only pings, as after a `schemaHash` mismatch. It keeps the socket as an idle connection with no user, groups or `clientId` (so it is pinged and closed on shutdown), never catches it up and never sends it a delta, and the `clientId` is neither checked nor registered. It still belongs to its session: a sign-out closes it with `4001` like any socket of that session. Old clients already turn `resync(schema)` into the reload banner (SPEC-002 E7); a refused upgrade would only be a `1006`, so an idle old tab would never learn it is outdated.

Server → client messages:
```jsonc
{"t":"deltas","prev":18234,"packets":[
  {"id":18235,"a":"I","m":"Issue","d":{…}},          // insert (full row)
  {"id":18236,"a":"U","m":"Issue","d":{…}},          // update (full row → idempotent upsert)
  {"id":18237,"a":"A","m":"Issue","d":{…}},          // archive (full row, v0.7)
  {"id":18238,"a":"V","m":"Issue","d":{…}},          // unarchive or restore (full row, v0.7)
  {"id":18239,"a":"D","m":"Comment","mid":"…"},      // hard delete (purge)
  {"id":18240,"a":"G","added":["team:…"],"removed":[]} // sync-group change for this user
], "ack":[{"clientId":"…","seq":57}]}               // mutations confirmed in these packets
{"t":"resync","reason":"schema|too_old|groups"}     // client must re-bootstrap
{"t":"subscribed","teams":["…"],"at":18240}        // v0.8: the accepted teams; their deltas follow from the packet after `at`
{"t":"unsubscribed","teams":["…"],"at":18240}      // v0.8: no packet of these teams follows `at`
{"t":"presence","subject":"issue:…","users":["…"]}  // ephemeral, not in sync_log (M4, not in v0)
{"t":"ping"}
```
Client → server messages: `{"t":"pong"}`, from v0.8 `{"t":"subscribe","teams":["…"]}` and `{"t":"unsubscribe","teams":["…"]}` (§6.1; 1 to 100 team ids each), and from M4 `{"t":"presence","subject":"issue:…","state":"viewing|editing"}`.

**`deltas` rules** (checked by the decoder):
- `prev` is the id of the last packet the server sent **on this connection** before this message, or `since` for the first one. If `prev` is greater than the client's `lastSyncId`, the client has missed packets: it applies nothing from the message, closes the socket and reconnects with `since = lastSyncId` (SPEC-002 E1). If `prev` is less than or equal to `lastSyncId`, the message is contiguous with what the client has: it skips packets with `id ≤ lastSyncId` as duplicates (E2) and applies the rest. The server never needs to rely on the second case; it only makes a re-delivery harmless.
- Packet ids are strictly increasing and greater than `prev`. Ids can skip, because the stream is filtered by sync groups. At most 500 packets per message.
- `ack` lists this connection's own mutations that committed in the `sync_log` range the message covers. `packets` may be **empty only when `ack` is not**: a mutation can write rows this client cannot see, and its pending entry must still be confirmed. A message with neither is invalid.
- **Catch-up carries acks too.** The catch-up from `since` includes the acks for every mutation of the connection's `clientId` that committed in `(since, head]`, in an ack-only message where none of its packets are visible. A client whose live ack was lost (the socket dropped) relies on this, because a change it cannot see is confirmed only by its ack: the client's `lastSyncId` never reaches it.
- `G` packets are decoded in v0 because they take part in the ordering. Until M7, the client handles one with a full re-bootstrap.
- **Archived state changes only through `A` and `V`.** `I` inserts a live row, and `U` replaces the row's fields but keeps whether it is archived. No edit changes the archived state: archived issues are read-only, and **restore** emits `V` (SPEC-015). This keeps a client that applied the stream identical to one that cold-started from a bootstrap (whose `row.archived` reflects the same state).
- **`A` and `V` carry the full row `d`** (v0.7), sent through `clientRow` like `I` and `U`, so its groups are cut to the connection's (SPEC-002 Q6). The client applies them as an upsert plus the flag, and a `V` for a row it doesn't hold inserts it. `D` still carries only `mid`.
- **Issues leave the replica when archived or deleted** (v0.8). A packet whose Issue row has `archivedAt` or `deletedAt` set (an `A`, or the `U` of a delete) removes the Issue, with a tombstone at the packet's id, together with its eager children, its content and its hydration mark, in one IDB transaction. A later `V` or `U` of the live row (restore) inserts it again. An archived Label stays in the replica with its flag.

**Close codes:** `1012` server shutting down (reconnect with backoff) · `4001` session revoked (stop reconnecting, go to login; SPEC-002 E10). The server may also close with `1003` (a binary frame), `1008` (a message other than `pong`, `subscribe` or `unsubscribe`, or more than 32 `subscribe`/`unsubscribe` waiting for their answer), `1009` (a client message over 4 KiB), `1011` (catch-up failed) or `1013` (try again later: the hub is not running yet, or the client fell too far behind). The client treats these like any other close: it reconnects with backoff and catches up from its `lastSyncId`.

**Refused before the upgrade** (SPEC-003 error body): `503` with `Retry-After` while the server starts or stops, `403` for an `Origin` other than `SURFACE_URL`'s, for an API key (SPEC-002 §4.3, Q9) or for a `clientId` another user registered through `POST /sync/mutate` (SPEC-002 §4.4), `400` for invalid connect parameters (except a missing `userId`, above). A browser sees each of these as an abnormal close (`1006`) and retries with backoff. **Live updates unavailable** (SPEC-005 §8): the client cannot tell a proxy that strips the upgrade from these refusals or from a server that is down, so it asks the server over plain HTTP. After **three attempts in a row that close, or go silent, before opening**, it requests `GET /auth/session`; any status below `500` (a `401` included) means the server answers. It then dials at once, and if that attempt also fails before opening, live updates are unavailable: the app shows the banner and the client keeps retrying with backoff. A network error, `502`, `503` or `504`, or no answer within 10 s, means the server may be down or restarting: no banner, and it asks again after the next failed attempt. A server back from a restart opens on the attempt its answer starts, so a restart never shows the banner. The count and the answer reset when an attempt opens, when the browser's `online` event fires, and when the client stops.

**No valid session** (none, or not `userId`'s): the hub accepts the upgrade and then closes at once with `4001`. It does not answer `401`. A browser cannot read the HTTP status of a refused upgrade, which looks like any network failure (`1006`), so the client would keep retrying. This is how a client that was offline when its session was revoked learns about it. Nothing is sent before the close.

**Revoked on any replica:** a session that ends (sign-out, and later revoke and password reset) closes its sockets with `4001` on every replica. The server sends `NOTIFY session_revoked` with the session ids, and every hub's listen connection hears it next to `sync`. A replica whose listen connection is down at that moment misses it, and those sockets stay open until they disconnect; their next connect is closed with `4001` as above.

**Catch-up:** on connect, the server streams `sync_log` rows with `sync_id > since` filtered by the user's groups, then switches to live mode. If `since` is older than the retention window (30 days) or ahead of the server's head (a database restored from a backup, SPEC-002 Q10), it sends `resync(too_old)`; if `schemaHash` differs, `resync(schema)`. A connection's groups are read once, before the upgrade, plus the public teams it subscribes to (§6.1); when a private team's membership may change them, the hub sends `resync(groups)` (§6). After a `resync` the server sends nothing more on that connection but pings, and the client closes it.

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
  {"seq":58,"status":"error","error":{"code":"NOT_FOUND","message":"Issue was deleted"}},
  {"seq":59,"status":"error","error":{"code":"CONFLICT","message":"That username is taken. Pick another.",
    "issues":[{"path":["username"],"message":"That username is taken. Pick another."}]}}
]}
```
- **An error's `issues`** (optional, v0.6) are the ones the operations API returns for the same error (SPEC-003 §9: `path`, `message`, optional `hint`), so a form can show each on its field; no `operation`, `candidates` or `correlationId`. The stored result keeps them, so a replayed seq returns the same issues. They follow the API's visibility rule: a row in a private team the user isn't in gets `NOT_FOUND` with the same result a missing row gets, and no issue reveals that it exists (permissions.md §5). Older servers send none, and a client must work without them.
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
  - `401 UNAUTHENTICATED`: no session, or a session of a user other than `userId` (SPEC-002 E14). Nothing ran. The queue stops sending and keeps every mutation, and the client redials the socket, which tells it which case this is: `4001` (no session, or another user's) leaves the socket down for good, so the queue stays offline until its user signs in again and a new store adopts it, and the app checks the session (SPEC-001 E14); a socket that opens again resends after the backoff, which grows while the answer stays `401`. The web app keeps the store when the same session answers after a mutate `401`, so this backoff applies there too; after a `4001` it opens a new store, spaced out when the same session keeps being revoked (SPEC-005 §3).
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
- Content that was never hydrated shows "Available when online". So do issues the replica doesn't hold (another team never subscribed, archived and deleted issues, §2): they come from server queries.

### 5.4 Conflicts
| Case | Resolution |
|---|---|
| Two users change *different* fields | Both apply, because operations are field-level |
| Two users change the *same* scalar field | Server order wins (last write wins), and both changes are visible in history |
| Edit to a deleted or invisible record | Rejected with `NOT_FOUND` / `FORBIDDEN`. The overlay is dropped and the user sees a toast. |
| Edit to an archived or deleted (not yet purged) issue, or its comments, reactions and attachments | Rejected with `CONFLICT` ("ENG-42 is archived. Restore it to edit it."): they are read-only (SPEC-011 §6.1, SPEC-015) |
| Invariant violated by concurrent change (e.g. a status deleted meanwhile) | Rejected with `CONFLICT` plus a message |
| **Rich text** (description, comment, document) | `issue.updateDescription({issue, baseVersion, description})`, and `comment.update` the same way (SPEC-013). The server rejects it with `CONFLICT` if `baseVersion ≠ current`; the error carries no `currentVersion`, since the client has it in its replica (SPEC-011 D3). Until the merge UI (FR-COL-10, M4), the client keeps the user's text and offers "Copy my text" and "Discard and reload" (SPEC-011 Q4). Real-time CRDT editing is v2. |

### 5.5 Undo / redo
At dispatch time the runner records the **inverse operation**, computed from the view state (e.g. `issue.update({id, priority: <old>})`). Undo dispatches the inverse as a *new* mutation, so it goes through the same pipeline. The stack is per tab, in memory only, holds 100 entries, and is cleared on `resync`.

---

## 6. Sync groups at runtime

- A connection's groups = `workspace` + `user:<id>` + `team:<id>` for each private team the user belongs to + `team:<id>` for each **public team the client subscribes to** (v0.8, §6.1).
- **Issue rows** (v0.8, SPEC-011 §5.7) are in `team:<teamId>` for every team. An issue of a **public** team is also in `user:<creatorId>` and `user:<assigneeId>` (when assigned), so "My issues" is local for everyone. A private team's issue is in its team group only, so leaving the team can't leak it. **Child rows** (IssueContent, IssueHistory, Comment, Reaction, Attachment) carry the issue's `teamId` and are in `team:<teamId>` only. The Issue model declares a `groups` field.
- **Draft** rows (SPEC-012) are in `user:<id>` only, so another user's drafts never reach a replica.
- When membership changes, the server emits a `G` packet **to that user only**:
  - **added:** the client calls `GET /sync/bootstrap?groups=<added>`, then continues with deltas.
  - **removed:** the client deletes every row whose groups are now all invisible, from memory and from IDB.
- **Until `G` packets (M7)** the hub sends `resync(groups)` instead, and the client bootstraps again with its new groups, which also drops the team's rows (PLAN-001 S9, SPEC-002 Q13). It goes to a connection whose user is named by a new membership row of a private team (live or in catch-up); to every connection in a private team's group when one of its memberships is deleted, since a deleted row carries no data (SPEC-002 Q4) and the hub can't tell whose it was; and, at connect, to a connection for which a private team outside its groups lost a member after its `since` (its user may have been removed while the socket was closed). Public teams' memberships change no server-side groups: the client subscribes to a public team it joins and unsubscribes from one it leaves (§6.1).
- A row's `groups` can change (e.g. a project loses its last public team, a public team's issue gets a new assignee, a team label moves to the workspace with `label.moveToWorkspace`). The repo logs `D` with the old groups, then `U` (the full row) with the new ones, under consecutive ids: users who lose visibility get only the `D`, users who gain it only the `U` (an upsert, so it arrives as an insert), and users who keep it get both in one batch, because the hub never splits that pair across batches or pages (SPEC-002 Q5). Clients that keep the row keep its content too, because content is dropped only when the Issue is absent after the whole batch (§4.2 rule 5).
- A row reaches a client with its `sync_groups` cut down to the groups that client is in, so it never learns the id of a private team it isn't a member of (SPEC-002 Q6). The client receives them in the model's `groups` field, if the model declares one; other models carry no groups (SPEC-002 Q8).

### 6.1 Team subscriptions (v0.8)

Partial issue loading ([ADR-0020](adr/0020-partial-issue-sync.md), SPEC-011 §5.7). The client subscribes to:
- every public team the user is a member of (read from its TeamMembership rows), and
- up to **5 other public teams, on demand**: when the user opens that team's issue list or one of its issues, including an issue held only through a `user:` group. The least recently opened is dropped first. The set is stored in IDB, per replica.

Private teams the user is a member of are home groups, as before.

- **Subscribing:** `teams` on the socket URL (§4.3), or `{"t":"subscribe","teams":[…]}` on an open socket. The server accepts a public team (any active user may subscribe to it) or a private team the user is a member of. Anything else (an unknown id, a private team the user isn't in) is **ignored the same way**, so the answer reveals nothing. It answers `{"t":"subscribed","teams":[…accepted],"at":<id>}`: the connection receives the team's deltas from the packet after `at`. The client then loads the team with the partial bootstrap (§4.1). The server checks each request when it handles it (a team that turned private is refused from then on), and handles a connection's `subscribe` and `unsubscribe` one at a time, in order, once catch-up is done.
- **Unsubscribing** (an on-demand team dropped, or the user leaves a public team): the client sends `{"t":"unsubscribe","teams":[…]}`. The server answers `{"t":"unsubscribed","teams":[…],"at":<id>}`, naming each team asked except the user's private teams (home groups, which stay): every packet of those teams up to `at` has been sent, and none follows. On that ack the client removes every Issue row, with its children and hydration mark, whose `groups` no longer meet the connection's groups. A row also in `user:<id>` stays. Leaving a **private** team keeps the `resync(groups)` path below.
- **Content needs the subscription:** child rows travel only in `team:<id>`, so the client hydrates and prefetches content only for issues of subscribed teams (§4.2).
- **Eager children leave with their issue.** When an Issue leaves the replica (unsubscribe, archive, delete, a group change), its eager children (Attachment), its content and its hydration mark are removed in the same IDB transaction. Each child model registers its parent field for this.

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

- **Bulk writes** (v0.7, SPEC-011 §5.1): `repo.updateWhere(model, ids, patch, { touchUpdatedAt })` locks the rows in ascending id and logs one `U` per row; `repo.deleteWhere(model, column, ids)` logs one `D` per row. Settings cascades (a label delete rewriting `labelIds`) use `updateWhere` with `touchUpdatedAt: false`. Every flush inserts `sync_log` rows in chunks of at most 5,000 per statement, under Postgres's limit of 65,535 bind parameters.
- **Groups of an Issue and its children** come from the issue row the handler already locked (SPEC-011 §4.8), not from a read of the team row, so the team lock is never taken after an issue lock.
- **Two stated exceptions** write synced rows without a `sync_log` row each: purge deletes an issue's content rows with no `D` ([ADR-0022](adr/0022-purge-content-unlogged.md)), and a document schema migration rewrites stored documents in the migration ([ADR-0023](adr/0023-document-migration-unlogged.md)). Nothing else may.

---

## 8. Schema evolution

- `schemaHash` = `computeSchemaHash(models)` from `packages/sync-protocol`: the lowercase hex SHA-256 of a canonical JSON form of `[SYNC_PROTOCOL_VERSION, models]`. For each model it covers the name, the load strategy, each field's name, type and nullability, and a content model's `parent` declaration (v0.7). The input also carries `DOC_SCHEMA_VERSION` (SPEC-013 §4.4), the version of the stored rich-text documents, so an editor schema change resyncs every client. Models and fields are sorted by name, so declaration order doesn't matter. Client-only metadata (refs, indexes) is not hashed. Bumping `SYNC_PROTOCOL_VERSION` changes every hash. When it changes, clients receive `resync` and do a full bootstrap.
- The hash is computed in pure TypeScript rather than with `crypto.subtle`, which is async and missing on plain-HTTP origins (common for a self-hosted LAN install).
- Operation inputs evolve **additively** (optional fields only). A removed or renamed operation makes the server reply `CLIENT_OUTDATED`, and the client reloads.
- DB migrations run at server start, guarded by an advisory lock, before the server accepts connections. A migration that rewrites stored documents logs no `sync_log` rows; it is allowed only in a release that bumps `DOC_SCHEMA_VERSION`, so every client resyncs ([ADR-0023](adr/0023-document-migration-unlogged.md)).

---

## 9. Limits & tuning (initial values)

| Parameter | Value |
|---|---|
| Mutation batch size | ≤ 100 mutations or 1 MB |
| Delta packet batch | ≤ 500 packets per message |
| Content fetch | ≤ 50 parents per request; ≤ 4 prefetch requests in flight (an open's request, one parent, is not counted) |
| Content answer | ≤ 4 MiB of content rows, by whole parents in request order; the first parent always comes whole (§4.2) |
| Content cache | 2,000 hydrated issues per replica, least recently opened evicted first; never one open in a tab (a shared Web Lock per open issue; without Web Locks nothing is evicted from a shared replica; an in-memory replica, one tab's alone, is evicted without locks) |
| Prefetch | Open issues assigned to me in subscribed teams (the 100 most recently updated), the first 50 visible rows of the active list (debounced 200 ms), an issue hovered for 150 ms, and on an issue page the issues `J` and `K` open next. No "current cycle" until M3. |
| On-demand team subscriptions | Up to 5 public teams beyond the user's own, least recently opened dropped first |
| `sync_log` insert chunk | ≤ 5,000 rows per statement |
| `sync_log` retention | 30 days |
| Ping interval / timeout | 25 s / 10 s |
| Reconnect backoff | 0.5 s → 30 s with jitter |

---

## 10. Test obligations

1. **Convergence property:** with random operations from N clients and random network faults, all clients equal the server state once the system is quiescent.
2. **Exactly-once:** a mutation is never lost and never applied twice across crashes, reloads, and resends.
3. **Ordering:** deltas are applied strictly in `sync_id` order with no gaps. A gap triggers a reconnect.
4. **Group change:** visibility is gained and lost correctly, with purging on removal. Subscribing to and unsubscribing from a team equals a fresh bootstrap of the new set.
5. **Rejection:** the overlay rolls back cleanly and the UI state matches the base state.
6. **Performance:** bootstrap, warm start, and delta apply stay within the NFR budgets at the reference scale.
7. **Content models** (v0.7): with hydration, buffering, tombstones and eviction in the generator, every client's hydrated content equals the server's for its hydrated parents.
8. **Archive interleavings** (v0.7): archive, restore, delete, purge and label cascades, in any interleaving, leave every client equal to a fresh bootstrap.

---

## 11. Change log

| Date | Version | Change | Handed off |
|---|---|---|---|
| 2026-11-16 | v0.8 | Text only, no wire change (SPEC-011 D18, PLAN-011 S7). §9: the "≤ 4 requests in flight" limit counts prefetch requests only; an in-memory replica is evicted without Web Locks; prefetch also covers the issues `J` and `K` open next on an issue page. | — (client only) |
| 2026-11-16 | v0.8 | No codec change. §4.2: a content answer is bounded by a 4 MiB byte budget (SPEC-011 D16), filled by whole parents in request order; the first parent always comes whole. A visible parent left out is absent from `meta.parents`, like one not found, and the client asks for it again. §9 gains the limit. | PLAN-011 S6: built 2026-11-16 (`sync-content-route.test.ts`) |
| 2026-11-12 | v0.8 | Partial issue loading ([ADR-0020](adr/0020-partial-issue-sync.md), SPEC-011 §5.7), accepted at the M1 gate. Issue is eager **per subscribed team** (§2), and the 35 MB budget is per replica. Issue rows of public teams are also in `user:<creatorId>` and `user:<assigneeId>`; child rows are in `team:<id>` only (§6). Codec changes: `teams` on the socket URL; `subscribe` and `unsubscribe` (client → server) and `subscribed` and `unsubscribed` (server → client) messages (§4.3, §6.1); a socket without `teams` follows the user's member teams. The partial bootstrap `?groups=team:<id>` is enabled, with an empty answer for an unknown or invisible team (§4.1). Bootstrap leaves out archived and deleted issues, and an `A` or a delete's `U` removes an Issue, with its children and content, on the client; restore's `V` or `U` inserts it (§4.3). `schemaHash` changes. | PLAN-011 S4b (server): built 2026-11-13 (`subscribe-leak.int.test.ts`, `sync-bootstrap-partial.test.ts`, `sync-subscribe.test.ts`); S4c (client) |
| 2026-11-12 | v0.7 | Accepted at the M1 gate (SPEC-010, SPEC-011, SPEC-013, SPEC-015). **Archive on the wire:** `archivedAt` is a synced field on models that archive, the frame's `archived` flag is derived from it, `A` and `V` carry the full row through `clientRow`, and a `V` for a missing row inserts it (§4.1, §4.3). **Content:** the `/sync/content` contract and hydration rules (§4.2; the parameter is `parents`); content models declare `parent`; Comment and Reaction are content models with parent Issue; content `D`s always apply as tombstones, and content is dropped when its Issue is absent after a batch. A purge logs no `D` for content rows ([ADR-0022](adr/0022-purge-content-unlogged.md)). **Server:** `repo.updateWhere` and `repo.deleteWhere`, `sync_log` inserts in chunks of 5,000, groups from the locked issue row (§7). **Schema hash** gains each model's `parent` and `DOC_SCHEMA_VERSION` (§8); document migrations are unlogged ([ADR-0023](adr/0023-document-migration-unlogged.md)). The description conflict carries no `currentVersion` (§5.4). Prefetch and cache limits (§9) and property-suite obligations (§10). Draft rows sync in `user:<id>` only (§6). IssueLabel is gone: labels are `labelIds` on Issue (§2). `schemaHash` changes. | PLAN-011 S1–S2 (archive, repo), S5a–S5b (content); PLAN-012 (Draft); PLAN-013 (comments); PLAN-015 S2 (purge) |
| 2026-11-12 | v0.6 | Additive. §4.4: a mutation's `error` may carry `issues` (`[{path, message, hint?}]`, `path` of strings and non-negative integers), the operations API's issues for the same error, also in the stored result a replay returns. The client passes them on in `MutationOutcome` and `Rejection` (`RejectionError`), so a form can show a server refusal on its field. A client reading a server without them sees none. | Session A (the executor's issues in the mutate result and in the stored `client_mutations` result; a leak test that a hidden row's rejection, issues included, matches a missing row's): built 2026-11-12 (`sync-mutate-leak.int.test.ts`) |
| 2026-11-12 | v0.5 | Text only, no wire change. §4.4 `401`: the web app now keeps the store when the same session answers after a mutate `401`, so the client's backoff applies in the app (C's fix of D2's handoff, `30cbb7d`, SPEC-005 §3). | — |
| 2026-11-12 | v0.5 | No wire change. The package also holds the paths the server answers itself: `SERVER_PREFIXES` and `isServerPath(pathname)` (`src/server-paths.ts`, no imports), exported from the root and alone as `@surface/sync-protocol/server-paths`, so the offline worker (ADR-0019) can import them without the package's schemas. The server's app-page fallback uses them; a new top-level server prefix is added there. | Session C (switch `apps/web/src/offline/app-cache.ts` to it; C's PLAN-005 S9 handoff, item 3, agreed with D2) |
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
