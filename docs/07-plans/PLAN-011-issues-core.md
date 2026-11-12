# PLAN-011: Issues core: create, properties, history, IDs

Implements: [SPEC-011](../06-specs/SPEC-011-issues-core.md) · Status: **Draft** (waits for M1 acceptance, README §7) · Order: **1st of M1, critical path** (S1 → S4 → S5a → S5b → S6; S4b → S4c, partial issue loading, run beside S5a and S5b, and S6 needs S4b; S5 is two PRs, S5a and S5b) · Depends on: M0 (PLAN-001…005 on `main`); PLAN-010 S1 (S3, S4); PLAN-013 S1 (S6); PLAN-010 S5 (S8)

> **Shared foundations.** This plan owns the sync and registry changes every M1 plan builds on (SPEC-011 §1): the `OptimisticStore` additions, the registry flags `systemOnly` and `contentParent`, the repo's bulk writes, archive state on the wire, groups from the locked issue row, `lockIssueForWrite`, and the content-model machinery, and partial issue loading (SPEC-011 §5.7, ADR-0020: S4b server, S4c client). Other plans cite these slices by number. **Every slice keeps its number**; S4b and S4c were inserted after S4 without renumbering. S5 is built as two PRs, S5a (protocol and server) and S5b (client); another plan's "PLAN-011 S5" means both are merged.
>
> **Order of change.** The sync engine is changed in the order that keeps every slice mergeable alone: first code no wire depends on (S1), then one wire change (S2, protocol v0.7), then the first issue tables (S3), the operations on them (S4), then partial issue loading (S4b server and protocol v0.8, S4c client) beside content (S5a protocol and server, S5b client), then S6 real content and S7 cache. S8 runs last. S3 already gives children `team:<teamId>` only, so content is built on its final groups; S6 needs S4b, because connections receive a public team's `team:<id>` group, and so its content deltas, only from S4b. Each slice says what stays stubbed until a later one.

---

## 1. Slices

### S1: Registry & store foundations (no issues yet) · M
- **`OptimisticStore`** (`packages/operations/src/optimistic.ts`, SPEC-011 §6.3):
  - `store.find` returns rows **ordered by id** (`packages/sync-client/src/overlay.ts`, the `find` in `#run`: sort the result of `rowsOf`). Replays become deterministic.
  - New `store.unarchive(model, ref)`: clears the layer's archived flag and, when the model declares `archivedAt`, sets it to `null`.
  - `store.archive` also sets `archivedAt` to `store.now` when the model declares the field. No model declares it until S2, so this is a no-op until then.
  - The interface doc says `get` and `find` return `archivedAt` like any field (true from S2).
- **`defineOperation` flags** (`packages/operations/src/define.ts`, SPEC-003 §3 changes listed in SPEC-011 §12 and SPEC-014/015 §12):
  - `contentParent?(input): { model: string; id: string }`, mutations only. A definition check refuses it on a query. Dispatch ignores it until S5b.
  - `systemOnly?: true`. Callable only by the `system` actor in every environment (`apps/server/src/executor/execute.ts`, the `callable` check). Hidden from `GET /api/ops` (`apps/server/src/http/ops.ts`), the catalog (`packages/operations/src/catalog.ts`), MCP when it lands, and the command menu (`apps/web/src/command-menu/sources/operations.ts`). Exempt from lint rule 2's seed run and rule 4 (`packages/operations/src/lint.ts`). `internal` keeps its meaning (dev-only `debug.*`).
- **Repo bulk writes** (`apps/server/src/sync/repo.ts`, SPEC-011 §5.1):
  - `flush` inserts `sync_log` rows in chunks of at most 5,000 per statement (`SYNC_LOG_CHUNK`), under the same sync lock and one `sync_state` bump.
  - New `updateWhere(model, ids, patch, { touchUpdatedAt })`: one `SELECT … ORDER BY id FOR UPDATE` per chunk, one `UPDATE … RETURNING` per chunk, one `U` per row. The groups are each row's stored `sync_groups`; `updateWhere` refuses a patch that touches a field the model's groups derive from (`teamId`), so it never changes groups. **An empty patch is accepted and means "log each row again"**: no column is written (no `UPDATE`, no `updatedAt` change), the rows are still locked in ascending id, and one `U` per row carries the stored row. `issue.restore` uses it for Attachment rows (PLAN-015 S1, SPEC-011 §5.7).
  - New `deleteWhere(model, column, ids, { log })`: `DELETE … WHERE column = ANY($ids) RETURNING id, sync_groups`, in chunks, one `D` per row. `log: false` (default `true`) writes no `sync_log` rows. It is accepted only for a `load: 'content'` model whose parent row is deleted, with a logged `D`, in the same transaction (an assertion in `flush`); clients drop content of a missing parent (S5b). This is the one sanctioned unlogged repo write, for purge (SPEC-015 Q2, its ADR in the acceptance gate); it still goes through the repo, so rule 2 holds.
  - The SQL for both is built by pure functions (`apps/server/src/sync/bulk.ts`, new), so chunking and lock order are unit-tested without Postgres.
  - `Repo` gains both methods in its interface; the test fakes in `apps/server/test/` (`sync-fake-log.ts`, `support/`) gain them too.
- No migration. No schema hash change.
- **Tests:**
  - `sync-client/test/overlay-find.test.ts` (extend): `find` is ordered by id across base, draft and layer rows; two rebuilds give identical rows (AC-7, the `find` half).
  - `sync-client/test/overlay.test.ts` (extend): `unarchive` clears the flag; `archive` and `unarchive` on a model without `archivedAt` change only the flag.
  - `operations/test/define.test.ts` (extend): `contentParent` refused on a query; `systemOnly` accepted on mutations.
  - `operations/test/lint.test.ts` + `operations/test/catalog.test.ts` (extend): a `systemOnly` op is exempt from rules 2 and 4 and absent from the catalog.
  - `server/test/executor-unit.test.ts` (extend): a `systemOnly` op is `UNKNOWN_OPERATION` for `user`, `api` and `mcp` actors, also outside production, and runs for `system`.
  - `web/test/command-operations.test.ts` (extend): a `systemOnly` op never appears.
  - `server/test/sync-repo-bulk.test.ts` (new): chunks of at most 5,000 rows, ids locked ascending, `updatedAt` untouched with `touchUpdatedAt: false`, one `U` or `D` per row, a `teamId` patch refused, an empty patch logs one `U` per row with the stored row and writes no column; `log: false` refused for an eager model and for a content model whose parent is not deleted in the same transaction (AC-21 unit part).
  - ⏸ held (integration) `server/test/sync-repo-bulk.int.test.ts`: 10,001 rows through `updateWhere` and `deleteWhere` against Postgres, `sync_log` contiguous. Existing `sync-repo.int.test.ts` is run.

### S2: Archive state on the wire (protocol v0.7) · M
- **Wire** (`packages/sync-protocol/src/socket.ts`, SPEC-011 §5.5): `A` and `V` packets carry the full row `d`, like `I` and `U` (`rowStatePacketSchema` splits into an archive packet with `d` and a delete packet with `mid`). Bump `SYNC_PROTOCOL_VERSION` (`schema-hash.ts`) so every schema hash changes and every client re-bootstraps once (SPEC-002 E7), whatever models change.
- **Server** (`apps/server/src/sync/delta-writer.ts`, `toPacket`): `A` and `V` go through `clientRow`, so `syncGroups` is cut to the connection's groups. `sync_log.data` already holds the row (`repo.ts`, `change()`).
- **Models:** `archivedAt` becomes a declared `timestamp().nullable()` field on `Label` (`packages/domain/src/model/workspace-models.ts`) and on the `DebugItem` fixture. The column exists on both tables. Issue declares it in S3. Coordinate with PLAN-010 S1: it adds `exclusive` only, not `archivedAt`.
- **Client:**
  - `deltas.ts`: an `A` or `V` packet becomes an upsert of `d` plus the flag. A `V` for a row the client doesn't hold inserts it.
  - `pool.ts` (`BaseChange`, `applyBase`): `archive` and `unarchive` carry the row. `$archived` is derived from `archivedAt` for models that declare it, and from the frame flag (bootstrap) or packet otherwise.
  - `storage/types.ts` (`StoredChange`), `storage/indexeddb.ts`, `storage/memory.ts`: archive and unarchive store the row with its version, under the existing version and tombstone rules.
- **Bootstrap:** the frame's `archived` flag stays (`bootstrap.ts`, `ARCHIVED_ALIAS`), now equal to `archivedAt IS NOT NULL` by construction.
- **Sim:** new internal ops `debug.archive` and `debug.unarchive` (`packages/operations/src/ops/debug.ts`, handlers in `apps/server/src/handlers/debug/`, the fake hub in `sync-client/test/support/hub.ts`) join the generator.
- **Docs in the same PR:** sync-protocol §4.1, §4.3 and §11 (v0.7), per SPEC-011 §12, if M1 acceptance hasn't already applied them.
- **Tests:**
  - `sync-protocol/test/socket.test.ts` (extend): `A`/`V` decode with `d`; a `D` still carries only `mid`; an `A` without `d` is refused.
  - `server/test/sync-delta-writer.test.ts` (extend): `A` and `V` carry the row with groups cut to the connection's (AC-18).
  - `sync-client/test/live.test.ts` + `pool.test.ts` (extend): `V` for a missing row inserts it; `U` on an archived row keeps it archived; `archivedAt` and `$archived` agree (AC-18).
  - `sync-client/test/storage.contract.test.ts` (extend): an older `A` can't overwrite a newer `U`, on both storages.
  - `tests/sync-sim/test/archive.prop.test.ts` (new, sync property suite): archive, unarchive, edit and delete in any interleaving, with socket drops, equal a fresh bootstrap (AC-18, debug half).
  - `server/test/archive-wire-leak.int.test.ts` (new, **leak test, not held**): a non-member of private SEC gets no `A` or `V` frame for SEC's labels, and a member's `A`/`V` rows carry only groups they are in (AC-10, AC-18).

### S3: Issue schema, model, numbering, order keys, issue lock · L
- **Needs PLAN-010 S1** (`fractionalKeyBetween` in `packages/domain`).
- **Migration** (next migration number; generated with `db:generate`, SPEC-011 §4.10), in `apps/server/src/db/schema/issues.ts` (new): `issues`, `issue_content`, `issue_history` (each with `sync_groups` and a GIN index), server-only `issue_search_text`, and every foreign key and index §4.10 lists (`(team_id, number)` unique, `(sort_order COLLATE "C", id)`, GIN on `label_ids`, the `pg_trgm` index on `lower(title COLLATE "und-x-icu")`, `issue_content(issue_id)`, `issue_history(issue_id, created_at)`). `issue_history.api_key_id` has no foreign key: there is no API key table until M6. One migration, as the spec says; S5a registers the content tables and S6 first writes them.
- **Domain** (`packages/domain`):
  - `src/model/issue-models.ts` (new): the `Issue` model (eager, every §4.1 field, `archivedAt`, `deletedAt`, `deletedById`), added to `PRODUCTION_MODELS`. A new `day()` field builder for `dueDate` (`YYYY-MM-DD`) in `src/model/fields.ts`.
  - `src/order-key.ts` (new): `keyBefore(first, jitter)` and `keyBetween(a, b, jitter)` over PLAN-010's `fractionalKeyBetween`, with a jitter suffix. `jitterFromId(id)` gives the optimistic jitter (SPEC-011 §6.2).
  - `src/issue.ts` (new): `issueTitleProblem`, `normalizeTitle` (line breaks to spaces), `PRIORITIES` reuse (`priority.ts`).
- **Server:**
  - `SYNCED_MODELS.Issue` (`apps/server/src/sync/models.ts`): on insert, groups come from the team row `FOR SHARE` (in S3 and S4 the team row's groups, `workspace` for a public team, like statuses; S4b replaces the builder with SPEC-011 §5.7's). On update, the repo **keeps the locked row's groups** unless the patch changes `teamId` (M3), so no team read happens after the issue lock (SPEC-011 §4.8). Add `issues` to `SYNCED_TABLES` (`packages/config/eslint.js`) and the sync scope table in `apps/server/src/db/README.md`.
  - `groupsOfIssueChild` (same file): a child's `teamId` comes from its issue's locked row (`issues.team_id`), never from input, and its groups are `team:<teamId>` only, never the issue's `user:` groups (SPEC-011 §5.1, §5.7). The repo overwrites any `teamId` a handler passes for a child model.
  - `apps/server/src/issues/lifecycle.ts` (new, the path SPEC-015 §4.4 names): `lockIssueForWrite(tx, issueId, ctx, mode)` → `LockedIssue` (`id`, `teamId`, `number`, `syncGroups`, `state`). `FOR UPDATE`, filtered by the actor's groups and the API key's teams (`visibleTo`, `executor/list.ts`); missing or invisible is `NOT_FOUND`. `edit` refuses archived and deleted issues with the §6.4 `CONFLICT` messages; `cascade` checks nothing; `lifecycle` returns the state. PLAN-015 S1 adds the lifecycle rule table behind `lifecycle`.
  - `apps/server/src/issues/numbering.ts` (new): `nextIssueNumber(tx, teamId)` upserts `team_issue_counters` (`INSERT … ON CONFLICT DO UPDATE SET last_number = last_number + 1 RETURNING`, the table's documented form; it takes the same row lock as SPEC-011 §4.5's `UPDATE … RETURNING` and covers a team without a row). `firstSortKey(tx, teamId)` reads the team's lowest `sort_order` after the counter lock and returns `keyBefore` with random jitter.
- **Client:** `Issue` registered through `PRODUCTION_MODELS`, so the web store holds it; `IssueRef` resolution in `sync-client/src/refs.ts` (identifier via the team key, or id).
- **Server refs:** `IssueRef` in `apps/server/src/executor/refs/sources.ts` (`lookupIssue`): identifier or UUID, narrowed by sync groups and API key `teamIds` (SPEC-003 §4 change); invisible is `NOT_FOUND` with one wording (E13).
- Nothing writes issues yet: no operation exists until S4.
- **Tests:**
  - `domain/src/order-key.test.ts` (new, property): any sequence of `keyBefore`/`keyBetween` gives a strict byte order with no duplicates; equal inputs with different jitter differ; `jitterFromId` is deterministic (AC-2 unit part).
  - `domain/src/issue.test.ts` (new): title trimming, line breaks, 1–255 characters.
  - `server/test/issue-lock.test.ts` (new): `edit` refuses archived and deleted issues even for a no-op, with the §6.4 wording; `cascade` passes; `NOT_FOUND` for an invisible or key-excluded issue (AC-23 unit part).
  - `server/test/issue-child-groups.test.ts` (new): a child's `teamId` comes from the locked issue row and its groups are `team:<teamId>` only; a `teamId` in input is overwritten; no team row is read on an issue update (AC-19, D5).
  - `server/test/issue-numbering.test.ts` (new): the counter statement and the sort key read come after the counter lock (unit over the statement order).
  - `server/test/workspace-models.test.ts` (extend): `Issue` columns match the model; `issue_search_text` is not synced.
  - `server/test/resolvers.int.test.ts` is existing: run it. New `IssueRef` leak cases go in S4's leak test.

### S4: Issue operations · L
- **Needs PLAN-010 S1** (`labels.exclusive`, the label-write rule of SPEC-010 AC-10, `isValidEstimate`).
- **Operations** (`packages/operations/src/ops/issue.ts`, new; listed in `ops/index.ts`): `issue.create`, `issue.update`, `issue.get`, `issue.list`, `issue.count`, `issue.groupBy`, with the §6.1 inputs and outputs. `IssueSummary` and `IssueOutput` without `description` and `version` (S6 adds them, additively) and without `attachments[]`/`reactions[]` (PLAN-014, PLAN-013). `issue.create` takes no `description` until S6. `issue.create` has `ui` **Create issue…**; the composer it opens is PLAN-012 S5, so until then its command opens nothing new (the command entry is PLAN-012's).
- **Domain** (`packages/domain/src/issue.ts`):
  - `statusSideEffects(fromCategory, toCategory, now, current)` for §4.6 and `inv20Problem(issue, category)`.
  - `mergeLabels(current, add, remove, labelsById)`: applies adds and removes as no-ops where needed, then PLAN-010's exclusive-group rule, then the 20-label limit.
  - `issueChangeSet(before, after)`: the fields an operation changed. It decides E12 (no change → no event) and feeds the `issue.updated` event now and history in S6.
  - `issueSlug(title)` (§4.1) and `ISSUE_FILTER_FIELDS` (`defineFilterFields`, every §6.1 filter field, shared by the client evaluator and the SQL compiler).
- **Handlers** (`apps/server/src/handlers/issues/`, new: `create.ts`, `update.ts`, `get.ts`, `list.ts`, `shared.ts`, `list-model.ts`):
  - Lock order of §4.8: create takes the team row `FOR SHARE`, then `FOR KEY SHARE` on the status and labels it writes (ascending id), then the counter, then inserts. Update takes `FOR KEY SHARE` on newly set status and labels, then `lockIssueForWrite(…, 'edit')`.
  - After the locks, the handler **re-reads** the status and labels. A status or label gone meanwhile is `CONFLICT` with the §6.4 wording (E19, E22). INV-06, INV-07 and INV-20 are checked on the re-read values.
  - A **newly added** label that is archived, or sits in an archived group, is refused with `INVALID_INPUT` "That label is archived. Unarchive it in Settings → Labels." (SPEC-010 E12, E13), read from `Label.archivedAt` (declared in S2). A label already on the issue stays. This check is owned here; PLAN-010 S6 only adds the archive operations. Until PLAN-010 S6 merges, archived labels exist only in tests (rows written through the repo).
  - `issue.update` writes only changed fields; a no-op on a live issue writes nothing and emits nothing (E12).
  - `issue.created` and `issue.updated` go to the outbox (`ctx.emit`) with the changed fields.
  - `issue.list`, `count`, `groupBy` use a new `issueListModel` (`defineListModel`): `archivedColumn`, deleted issues always excluded, `(sortOrder, id)` order, groupings by status, assignee, priority and label (an issue counts in each label; at most 500 groups). Status and label names resolve **within `team`**: `FilterRefType` in `executor/list.ts` gains team-scoped `StatusRef` and `LabelRef`.
- **Label cascade helper** (`apps/server/src/issues/cascade.ts`, new): `removeLabelFromIssues(tx, repo, labelId)` finds the issues with the label in ascending id and calls `repo.updateWhere(…, { touchUpdatedAt: false })`. No history, event or lifecycle check (§4.9). **PLAN-010 S5 calls it** from `label.delete`, after taking the team (or workspace) row and the label row `FOR UPDATE`.
- **Optimistic** (§6.2): `issue.create` inserts the Issue with `number: null`, the label rule applied, `sortOrder` from `keyBefore(lowest in store, jitterFromId(id))`, and category timestamps from `store.now`. `issue.update` patches the given fields, `labelIds` through `mergeLabels`, and the category timestamps.
- **Seed** (`apps/server/test/seed.ts`): a few ENG issues for the examples (§6.1).
- **Web:** route `/issue/$identifier/$slug?` and `/issue/$id` (pending) in `apps/web/src/app/router.tsx`, with the helper `apps/web/src/features/issues/issue-url.ts` (new): resolves identifier, slug and pending id in the replica, and builds the canonical address, replaced without a history entry (E27). PLAN-012 S4 uses the helper for the replace on title change and when the number arrives; it adds no second route. A pending issue routes as `/issue/<id>` until its number arrives (Q14). It shows a plain placeholder (identifier and title) until PLAN-012 S4 builds the issue page. The command-menu identifier fast path (`eng-87` → **Open ENG-87**, command-menu §3.1) in `apps/web/src/command-menu/sources/navigation.ts`.
- **Sim:** the real-server sim (`tests/sync-sim/src/real-server.ts`, `world.ts`) compares Issue rows next to debug items, and its generator gains `issue.create` (including rejected creates: an unknown label, a status of another team, an exclusive-group clash) and `issue.update` with label adds and removes.
- **Tests:**
  - `domain/src/issue.test.ts` (extend): `statusSideEffects` per §4.6 row, Triage and Duplicate refused; a fast-check property that INV-20 holds after any sequence of status changes (AC-3); `mergeLabels` cases and a property for the exclusive rule and the limit (AC-4, AC-16, E5–E7).
  - `domain/src/issue-slug.test.ts` (new, property): lowercase hyphenated words, at most 60 characters on a word boundary, empty for no letters or digits (AC-24).
  - `operations/src/ops/issue.test.ts` (new): each `optimistic` against a fake store gives the server's row except number and `sortOrder`; two rebuilds give identical rows (AC-7).
  - `server/test/issue-handlers.test.ts` (new): validation of every §4.1 field and the defaults (AC-1); E8 (an off-scale estimate stays); E12; adding an archived label or a label in an archived group refused, an already-applied archived label kept (SPEC-010 E12, E13); the re-read `CONFLICT` for a deleted status and label (AC-15 unit part, E19, E22); key locks taken before the issue lock, in id order (AC-20 unit part); archived and deleted issues refused even for a no-op (AC-23).
  - `server/test/issue-cascade.test.ts` (new): `removeLabelFromIssues` passes every issue with the label, archived and deleted ones included, to `updateWhere` with `touchUpdatedAt: false`, and writes no history or event (AC-17 unit part, E20).
  - `operations/test/spec-011.test.ts` (new) + `operations/test/lint.test.ts`: every §6.1 op is registered and passes the lint (AC-12).
  - `web/test/app-router.test.tsx` (extend): any slug resolves and is replaced (AC-24, E27); `web/test/command-sources.test.ts` (extend): the identifier fast path.
  - `tests/sync-sim/test/issues-real-server.int.test.ts` (new, **sync property suite, not held**): concurrent creates in one team, with rejected creates, give gap-free numbers in commit order and distinct sort keys (AC-2, E1, E3); two clients adding and removing labels, same-group adds included, converge (AC-4, E5–E7).
  - `server/test/issue-leak.int.test.ts` (new, **leak test, not held**): for private SEC, a non-member's bootstrap, catch-up and live deltas carry no SEC issue; `issue.get`, `update` and every `IssueRef` are `NOT_FOUND` worded like a missing issue; `list`, `count` and `groupBy` exclude SEC (and its group names); an API key limited to team A gets the same for public team B (AC-10, E13).

### S4b: Partial issue loading, server · M (4 d)
- Needs S4. SPEC-011 §5.6, §5.7, ADR-0020.
- **Group builders** (`apps/server/src/sync/models.ts`): `groupsOfIssue` gives a private team's issue `team:<teamId>`, and a public team's issue `team:<teamId>`, `user:<creatorId>` and `user:<assigneeId>` when assigned. Children keep S3's `team:<teamId>` only. Public team issues leave the `workspace` group; dev databases with issues from S3–S4 are recreated (nothing is released between slices).
- **An assignee change is a group change, through the repo.** On a public team's issue, `issue.update` that changes `assigneeId` recomputes the `user:` part from the locked row (a public issue always carries `user:<creatorId>`, so no team row is read after the issue lock, SPEC-011 §4.8). This relies on the invariant that `creatorId` is never null (SPEC-011 §4.1): the builder tells a public issue from a private one by the stored `user:<creatorId>` group. A future creator-less path must carry an explicit flag; a unit test in `issue-groups.test.ts` asserts the builder fails loudly on an Issue row with no creator. The repo logs `D` with the old groups, then `U` with the new ones, under consecutive ids (sync-protocol §6).
- **Two kinds of groups** (`apps/server/src/sync/groups.ts`):
  - `visibleGroups(actor)`: every group the actor may see, including every public team's `team:<id>`. Every query, `IssueRef`, `/sync/content` (S5a) and `GET /files/:id` (PLAN-014) filter with it, never with a socket's groups.
  - A **connection's groups**: `workspace`, `user:<id>`, the member private teams (as today) and the **subscribed** public teams.
- **WebSocket** (`packages/sync-protocol/src/socket.ts`, `apps/server/src/sync/socket.ts`): the `teams` query parameter on `/sync/ws`; client messages `subscribe` and `unsubscribe`, server message `subscribed {teams, at}`. Each team is checked: a public team, or a private team the user is a member of. Anything else (unknown id, a private team the user isn't in) is dropped from `teams` silently, identically, and is absent from the `subscribed` ack. Catch-up uses the accepted set. From the packet after `at`, the hub sends the team's deltas.
  - **`unsubscribe` is answered with `unsubscribed {teams, at}`** (SPEC-011 §5.7). The hub removes the teams from the connection's groups and queues the ack in the same ordered stream as the deltas, so every packet of those teams before it has been sent, and none follow. The client removes the team's rows only on this ack (S4c).
  - **`visibleHead`** (the confirm point of a no-op mutation, `apps/server/src/sync/client-mutations.ts`) is computed with the **connection's groups** (home groups plus the subscribed teams), never with every group the user could see (`visibleGroups`). Otherwise a no-op would confirm at an id the connection never receives, or skip one it does.
  - **Privacy flip (M7 obligation, recorded as a risk below):** the hub re-checks the `teams=` list at connect, so a connection can't re-subscribe to a team that has become private.
- **Partial bootstrap** (`apps/server/src/sync/bootstrap.ts`): `GET /sync/bootstrap?groups=team:<id>` is enabled. It streams the Issue rows and eager children of that group from one snapshot, with `lastSyncId`. An unknown or invisible team gives the same answer as an unknown id: byte-identical, with the same `meta` apart from `lastSyncId` and `serverTime`, and `rows: 0`. Never an error.
- **Bootstrap leaves out archived and deleted issues and their children**, full and partial (`archived_at IS NULL AND deleted_at IS NULL`; eager children joined through `issue_id`).
- **Protocol v0.8:** bump `SYNC_PROTOCOL_VERSION` (`schema-hash.ts`), so every client re-bootstraps once.
- **Docs in the same PR:** sync-protocol §4.1, §4.3, §6 (v0.8, with `unsubscribed`) and permissions §2, per SPEC-011 §12, if M1 acceptance hasn't already applied them.
- **Tests:**
  - `server/test/issue-groups.test.ts` (new): a private team's issue has only `team:<teamId>`; a public one adds `user:<creatorId>` and `user:<assigneeId>`; children have `team:<teamId>` only; an assignee change logs `D` then `U` with the right groups (AC-26 unit part, E28, E29).
  - `server/test/sync-subscribe.test.ts` (new, fake hub socket): accepted set, `at`, catch-up on the accepted set; an unknown team and a non-member's private team are dropped identically and absent from the ack (E32); `unsubscribe` is answered with `unsubscribed` after every earlier packet of the team and no packet follows; `visibleHead` for a no-op uses the connection's groups, not `visibleGroups`.
  - `server/test/sync-bootstrap-partial.test.ts` (new, query builder): `groups` parsing; archived and deleted issues and their children left out of full and partial bootstraps (AC-26, AC-29 server part); the answer for a private team the user isn't in is byte-identical to the one for an unknown id apart from `lastSyncId` and `serverTime` (AC-28).
  - `sync-protocol/test/socket.test.ts` (extend): `subscribe`, `unsubscribe`, `subscribed`, `unsubscribed` and the `teams` parameter.
  - `server/test/subscribe-leak.int.test.ts` (new, **leak test, not held**): a non-member's `subscribe` to private SEC and `?groups=team:<SEC>` behave exactly as for an unknown team; no `user:` group delivers a SEC issue or any child row; a key with `teamIds=[A]` sees no team B issue through `user:` groups (AC-28).
  - ⏸ held (integration) `server/test/sync-bootstrap-partial.int.test.ts`: full and partial bootstrap contents against Postgres (AC-26 integration part).

### S4c: Partial issue loading, client · L (6 d)
- Needs S4b.
- **Subscription manager** (`packages/sync-client/src/subscriptions.ts`, new):
  - Member public teams come from the user's TeamMembership rows and follow them live (a join subscribes, a leave unsubscribes).
  - The on-demand set (at most 5 teams, least recently opened dropped) is stored in IndexedDB, per replica (a `subscriptions` store). `openTeam(teamId)` touches it.
  - The socket URL carries `teams=`. After `subscribed`, the client runs the partial bootstrap. There is no buffering: packets after `at` apply as they arrive (E30). After a full bootstrap it subscribes its on-demand teams again.
- **`writePartialRows(rows, C)`** (`storage/types.ts`, `indexeddb.ts`, `memory.ts`, `rpc.ts`; SPEC-011 §5.7): the version-aware storage call that writes the partial answer. A row is skipped when storage holds a newer version of it or a tombstone at or above `C`. It starts no generation and never moves `meta.lastSyncId` or the tab's `lastSyncId`. After the write, the tab reloads those row ids from storage into the pool (`pool.ts` has no per-row versions), so a packet above `C` that arrived during the load, stored as a newer row or a tombstone, wins. The in-memory storage implements the same rule, so the fallback behaves alike.
- **Several tabs** (SPEC-011 §5.7, E35, E36):
  - `teamThrough[teamId]` in the IDB `meta` (per team): a tab advances it, for each team it is subscribed to, when it advances its own applied id.
  - On start or reconnect, a tab that subscribes to T with `teamThrough[T]` below its `since`, or absent, reruns T's partial bootstrap, then removes T's stored rows that are absent from the answer and older than `C` (the sweep), with their children, content and marks.
  - Each tab subscribed to T holds the shared Web Lock `surface-team:<id>` (`locks.ts`). Removing T's rows (an unsubscribe ack, LRU eviction) takes it exclusively with `ifAvailable` and skips if another tab holds it. Without Web Locks, team rows are never removed.
- **Unsubscribe removal:** the client sends `unsubscribe` and removes the team's rows **only when the `unsubscribed` ack arrives** (socket messages are ordered, so every earlier packet of the team is applied and none follow, M2). It removes every Issue row whose `groups` no longer meet the connection's groups. A row also in `user:<id>` stays (E31), but its **content and hydration mark are dropped**, because its content would not stay live without the team's group. Children of a removed Issue go as for any absent Issue: content and hydration marks by S5b's rule (whichever of S4c and S5b merges second wires them together), and eager children through `registerIssueChild(model, 'issueId')` (new here; PLAN-014 S4a registers Attachment). Leaving a private team keeps today's `resync(groups)`.
- **Hydration needs the subscription** (SPEC-011 §5.3 step 5): the `I` rule marks an issue hydrated only when its team is subscribed (S5b wires it; S4c supplies the "subscribed teams" set).
- **Archived and deleted removal** (`deltas.ts`): any `I`, `U`, `A` or `V` packet whose row has `archivedAt` or `deletedAt` set (this covers label-cascade `U`s on archived or deleted issues) removes the Issue with a tombstone at the packet's id, with its children and hydration mark. The children are removed after the whole delta batch, so a `D`+`U` group-change pair keeps them. A later `V` or `U` of the live row inserts it again (AC-29, E33).
- **The Issue model declares `groups`** (`issue-models.ts`; cut to the connection's groups, SPEC-002 Q8). This changes the schema hash.
- **`sync-react`:** `useTeamLoadState(teamId)` returns `loading`, `ready` or `offline` (offline and never loaded) and subscribes the team on demand when it isn't a member team. PLAN-012 S3 and S4 use it.
- **Fake hub** (`sync-client/test/support/hub.ts`, `server.ts`): connection groups, `subscribe`/`unsubscribe`/`subscribed`/`unsubscribed`, the partial bootstrap, `user:` groups on issues and the `D`+`U` pair on reassignment.
- **Sim:** the fake-hub generator (`tests/sync-sim/src/steps.ts`) gains subscribe, unsubscribe (acked in order with the deltas), reassign, archive, delete and restore, interleaved with deltas and socket drops, and a second tab (own socket, own subscriptions, shared storage).
- **Tests:**
  - `sync-client/test/subscriptions.test.ts` (new, fake hub, fake-indexeddb): LRU of 5 and its IDB persistence; member teams from TeamMembership; re-subscribe after reconnect and after a full bootstrap; rows are removed only on the `unsubscribed` ack, and a packet of the team that arrives before the ack is applied first (AC-27 unit part, E31); unsubscribing drops the content and hydration mark of a row kept through `user:` (SPEC-011 §5.3 rule 5, §5.7).
  - `sync-client/test/partial-write.test.ts` (new, fake-indexeddb and the memory storage, both): an `A`, a `D` or a delete's `U` above `C` arriving before the answer is not undone in the pool: the answer's row is skipped, and the pool reloaded from storage shows the removal (AC-27, E30). A row that storage holds as a tombstone at or above `C` stays removed; `meta.lastSyncId` and the tab's `lastSyncId` don't move; no generation starts.
  - `sync-client/test/team-cursor.test.ts` (new, fake-indexeddb, fake locks, two tabs): two tabs with different subscriptions each advance `teamThrough` for their own teams only; a cursor behind `since` (or absent) triggers the partial bootstrap again and the sweep, which removes rows absent from the answer and older than `C`; the removal of T's rows is skipped while another tab holds `surface-team:<id>`, and never happens without Web Locks (AC-27, E35, E36).
  - `sync-client/test/issue-removal.test.ts` (new): an `I`, `U`, `A` or `V` whose row has `archivedAt` or `deletedAt` set removes the Issue with its children and mark, including a label-cascade `U` on an archived issue; restore's `V` or `U` inserts it again and the Attachment `U`s that follow bring its attachments back; a `D`+`U` pair in one batch keeps the children, a lone `D` removes them; unsubscribe keeps `user:` rows; a reassignment away removes it (AC-29 unit part, E28, E29, E33).
  - `sync-react/test/team-load-state.test.tsx` (new): `loading` → `ready`; offline and never loaded is `offline`.
  - `tests/sync-sim/test/partial.prop.test.ts` (new, **sync property suite, not held**): subscribes, unsubscribes (with the ack in flight behind packets), reassignments, archives, deletes and restores, interleaved with deltas, socket drops and a second tab with other subscriptions, leave a replica equal to a fresh bootstrap with the same subscriptions; no archived or deleted Issue is ever stored (AC-27, AC-29).

### S5a: Content protocol and server · M (3 d)
- **Shared definitions:**
  - `defineModel` gains `parent: { model, field }` for `load: 'content'` (`packages/domain/src/model/define-model.ts`); required for content models, refused on eager ones. `SchemaHashModel` and `computeSchemaHash` include it (`packages/sync-protocol/src/schema-hash.ts`).
  - The `IssueContent` and `IssueHistory` models (`issue-models.ts`, parent `Issue` by `issueId`), added to `PRODUCTION_MODELS`, and their `SYNCED_MODELS` entries with `groupsOfIssueChild` and `teamColumn` (§5.1). Their tables exist since S3. Nothing writes them until S6, except tests through the repo.
  - The repo logs an Issue row before its content rows in one transaction (an assertion in `flush`, §5.1).
- **Wire** (`packages/sync-protocol/src/content.ts`, new): `CONTENT_PATH`, `encodeContentQuery`/`decodeContentQuery` (1–50 distinct `issue:<uuid>` parents, `userId`, `schemaHash`), and the `meta`/`row`/`end` frames of §5.2 over the existing NDJSON codec.
- **Server** (`apps/server/src/sync/content.ts`, new; route in `routes.ts`): `GET /sync/content`. Errors before the first frame per the §5.2 table (`400`, `401` incl. another `userId`, `403` for API keys, `426`, `503`). One `REPEATABLE READ READ ONLY` snapshot: `lastSyncId` from `sync_state`, visible parents (`sync_groups && $groups`, where `$groups` is every group the actor may see: S4b's `visibleGroups` once merged, never the socket's subscriptions), then their content rows through `clientRow`, counted for `meta.rows`. Gzip as for bootstrap.
- **Fake server** (`sync-client/test/support/hub.ts`, `server.ts`): `GET /sync/content` for test content models, with faults, so S5b tests run against it.
- **Tests (S5a):**
  - `sync-protocol/test/content.test.ts` (new): query limits and duplicates, frames, a truncated stream detected (AC-9 codec part).
  - `server/test/sync-content-route.test.ts` (new, fake pool like `sync-routes.test.ts`): each §5.2 error status; one snapshot; invisible parents left out of `parents`; `meta.rows` equals the row frames (AC-9 unit part).
  - `server/test/sync-registry.test.ts` (extend): `parent` changes the schema hash; a content model without one is refused.
  - `server/test/content-leak.int.test.ts` (new, **leak test, not held**): with SEC content written through the repo, a non-member's `/sync/content` for SEC parents returns no parent and no row, and catch-up and live deltas carry no SEC content; rows carry only the caller's groups (AC-10).
  - ⏸ held (integration) `server/test/sync-content.int.test.ts`: the endpoint against Postgres, rows consistent with `lastSyncId` under concurrent writes (AC-9 endpoint part).

### S5b: Content client: hydration, storage, dispatch · L (5 d)
- Needs S5a.
- **Client** (`packages/sync-client/src/content.ts`, new, used by `store.ts`):
  - Hydration state per §5.3: `hydrating` marks and packet buffers in memory per tab; the answer is stored at version `C` through the storage's version and tombstone rules; parents whose Issue is missing or tombstoned are skipped; buffered packets with id > `C` are replayed; a failed request drops the buffer and the mark.
  - `deltas.ts` routes content packets: `I`/`U` for a parent that is neither hydrated nor hydrating are dropped; content `D` always applies as a tombstone; an Issue `I` marks it hydrated; after a whole batch, content and marks of parents whose Issue is now absent are removed (the `D`+`U` pair keeps them, E24).
  - **Storage** (`storage/types.ts`, `indexeddb.ts`, `memory.ts`, `rpc.ts`): content model stores with an index on `row.issueId`; a `hydrated` store (parent id → last opened time) written in the same IDB transaction as the rows it covers; `applyChanges` reads that set to keep or drop content upserts, so every tab keeps a parent live once any tab hydrated it (E18). New calls: `writeContent`, `readContent(parent)`, `readHydrated`. `beginBootstrap` and `clear` also clear content and the hydrated set (step 7).
  - **Lazy reads:** a warm start (`hydrate.ts`, the M0 replica load, unrelated to content hydration) skips content models. `content.open(issueId)` pages a parent's rows in from IDB, or fetches them, and returns a release handle. Paging in **rebuilds the overlay** (`overlay.rebuild(queue.mutations)`, §5.4).
  - **Dispatch** (`store.ts` `dispatch`): an op with `contentParent` awaits hydration and page-in of that parent before its `optimistic` runs and before its seq is taken. Dispatches after it wait in a FIFO chain, so seqs keep call order. Offline with a parent never hydrated, dispatch refuses with "Available when online" (the UI offers no edit, SPEC-013 E20).
  - `sync-react`: `useIssueContent(issueId)` (`packages/sync-react/src/hooks.ts`) returns `loading`, `ready` or `offline` and the rows.
- **Sim (fake hub):** `tests/sync-sim/src/steps.ts` gains content fetches, content edits and deletes, parent purges and group changes (`D`+`U`), interleaved with socket drops.
- **Tests (S5b):**
  - `sync-client/test/content-hydration.test.ts` (new, fake server): buffering and replay above `C` (E17); an Issue `I` hydrates; `I`/`U` for an unhydrated parent dropped; content `D` stored as a tombstone (E25); a missing parent skipped (E15, E23); content kept across a `D`+`U` pair (E24); resync clears marks (AC-9).
  - `sync-client/test/content-dispatch.test.ts` (new, fake server, fake-indexeddb): a `contentParent` mutation waits for hydration and page-in, then the rebuilt overlay replays it on the paged-in rows; seqs keep call order; offline and unhydrated refuses (AC-22, E11).
  - `sync-client/test/storage.contract.test.ts` + `storage.prop.test.ts` (extend): the hydrated set and content rows commit together; two tabs share it (E18).
  - `tests/sync-sim/test/content.prop.test.ts` (new, sync property suite): content fetches interleaved with deltas, deletes, purges (unlogged content deletes included), group changes and socket drops equal a fresh fetch (AC-8, fake-hub part).

### S6: IssueContent, IssueHistory and the description · L
- **Needs S4b** (connections receive public teams' `team:<id>` groups, so the real-server sim sees content deltas) and S5b. **Needs PLAN-013 S1** (`@surface/editor/schema`: `validateDoc`, `docToText`, Markdown in and out; `EMPTY_DOC`, `DOC_SCHEMA_VERSION` in `packages/domain`). `DOC_SCHEMA_VERSION` feeds `computeSchemaHash` (§4.3).
- **Writes:**
  - `issue.create` gains `description?` (JSON, or Markdown for API and MCP, Q12) and writes the IssueContent row (`EMPTY_DOC` when absent, version 1) and one `created` history entry, Issue first.
  - `issue.update` writes one `updated` entry with every changed field from `issueChangeSet`, with reference names snapshotted (§4.4).
  - Both folds of §4.4 in `apps/server/src/issues/history.ts` (new), after the issue lock: the creator fold (3 minutes) and the description fold (10 minutes, same actor). A folded entry is a `U` with a new `updatedAt`.
  - `actorKind`, `actorId` and `apiKeyId` from `ctx.actor`.
- **New operation** `issue.updateDescription` (`ops/issue.ts`, `handlers/issues/update-description.ts`): `contentParent` = the issue; `lockIssueForWrite(…, 'edit')`, re-read the version, `CONFLICT` on a stale `baseVersion` with the §6.4 wording and no extra fields (D3); validates with `validateDoc` and the 200 KB limit; bumps the version; writes `issue_search_text` with `docToText` in the same transaction; history `description: true`, folded.
- **Inline-file claim seam** (`apps/server/src/files/claim.ts`, new): `claimInlineFiles(tx, doc, issue, actor)`, the one signature SPEC-014 §4.3 uses. Here its body accepts a document with no `/files/<uuid>` reference and refuses any reference with SPEC-014's `INVALID_INPUT` "A file in this text can't be used here. Upload it again.", so nothing unclaimed is ever saved. `issue.create` and `issue.updateDescription` call it in their transaction, after the issue lock. PLAN-013 S3 calls the same function from the comment handlers; PLAN-014 S4b replaces the body and changes no caller.
- **Reads:** `IssueOutput` gains `description` (Markdown and JSON, Q12) and `version`; `issue.get` reads them.
- **Domain:** `historyEntryFor(kind, changes)` and the fold predicates in `packages/domain/src/issue-history.ts` (new); the activity line formatter `activityLine(entry, viewerId)` (§4.4 table, "via API"/"via MCP") in `packages/domain/src/activity-line.ts` (new). SPEC-012 adds the other fields' wording to the same formatter.
- **Optimistic:** `issue.create` with a description also inserts the IssueContent row (version 1); `issue.updateDescription` patches `description` and `version`. No history is predicted.
- **Sim (real server):** the generator gains `issue.updateDescription` (with stale `baseVersion`s) and content fetches against the real `/sync/content`.
- Dev databases with issues from S4–S5b have no IssueContent row: recreate them. Nothing is released between slices.
- **Tests:**
  - `domain/src/issue-history.test.ts` (new): one entry per changing operation; names snapshotted; `created` holds only non-default `to` values; both folds, including their time limits and actors; `deleted`, `restored` and `archived` have empty `changes` (AC-5, E4, E16, E21).
  - `domain/src/activity-line.test.ts` (new): every §4.4 line and the "via API"/"via MCP" suffix (AC-25).
  - `server/test/issue-description.test.ts` (new): version bump; stale `baseVersion` is `CONFLICT` with no extra fields (E10); search text written with the content; 200 KB and schema validation; refused on archived and deleted issues (AC-6 unit part, AC-23); a document with a `/files/<uuid>` reference refused by the claim seam (replaced by PLAN-014 S4b's claim tests).
  - `server/test/issue-history-writer.test.ts` (new): `apiKeyId` for key actors; no-op updates write nothing; the fold runs after the issue lock (AC-5).
  - `operations/src/ops/issue.test.ts` (extend): create with a description and `updateDescription` predict the committed rows (AC-7); `operations/test/spec-011.test.ts` (extend, AC-12).
  - `tests/sync-sim/test/issues-real-server.int.test.ts` (extend, sync property suite): issue ops and content on the real server converge (AC-8, real-server part).
  - `server/test/content-leak.int.test.ts` (extend, **not held**): history and description written by real operations stay inside SEC's group (AC-10).
  - ⏸ held (integration) `server/test/issue-description.int.test.ts`: the `issue_search_text` row and the version against Postgres (AC-6).

### S7: Content cache: eviction and prefetch · M
- **Eviction** (`packages/sync-client/src/content.ts`, `locks.ts`, §5.4, Q11): at most 2,000 hydrated issues per replica, least recently opened first. A tab holds a shared Web Lock `surface-content:<issueId>` while an issue is open (`content.open` takes it, the release handle frees it). Eviction takes each candidate's lock exclusively with `ifAvailable`, and skips it when held; it removes the parent's rows and hydrated mark in one IDB transaction (`storage.evictContent`). Without Web Locks (plain HTTP), nothing is evicted.
- **Prefetch** (`content.prefetch(ids)` + `sync-react` `usePrefetchContent`), of issues the replica holds only (SPEC-011 §5.7): open issues assigned to the user (the 100 most recently updated) after start; the first 50 visible rows of a list (debounced 200 ms); hover after 150 ms. At most 50 parents per request and 4 requests in flight; hydrated parents are not requested. PLAN-012 S3 and S4 call the hooks from the list and the issue page.
- **Offline state:** `useIssueContent` reports `offline` for a never-hydrated parent, so the UI shows "Available when online" (E11).
- **Sim:** evictions join the fake-hub generator.
- **Tests:**
  - `sync-client/test/content-eviction.test.ts` (new, fake locks): LRU order, the 2,000 limit, an open issue never evicted, no eviction without Web Locks, rows and mark removed together.
  - `sync-client/test/content-prefetch.test.ts` (new, fake timers): debounce, hover delay, 50-parent and 4-request limits, hydrated parents skipped.
  - `tests/sync-sim/test/content.prop.test.ts` (extend): with evictions (AC-8).

### S8: Leak suite, filter conformance, size budget, hardening · M
- **Needs PLAN-010 S5** (`label.delete` calling S4's cascade helper) for the cascade interleavings. Runs after S6 and S7.
- **Sim:** the real-server generator gains `label.delete` racing `issue.update` that adds the label, and label cascades interleaved with archive and delete (AC-18, AC-20, E22). PLAN-015 adds its lifecycle operations (delete, restore, auto-archive) to the same generator (PLAN-015 S5).
- **Leak suite:** complete the permissions.md §5 checklist for issues, content and history across S2–S6's leak files (AC-10): bootstrap, catch-up, live deltas, `/sync/content`, every operation, list/count/groupBy, group names in `groupBy`, API key `teamIds`, `A`/`V` frames.
- **Filter conformance** (Q13, exception granted by the user 2026-11-12, so not held): `server/test/issue-filter-conformance.int.test.ts` (new) re-runs the PLAN-003 S5 harness for the Issue model, through the real codec, against Postgres. The client evaluator and the SQL compiler share `ISSUE_FILTER_FIELDS` (S4), and `domain/src/issue-filter.test.ts` (new) evaluates every field and operator on the client.
- **Size budget** (AC-14): `domain/src/issue-size.test.ts` (new) generates rows over the §10 seed distribution and asserts an average compact-JSON Issue row of at most 650 bytes. The same test computes the **worst-case replica total** from the seed distribution: the member teams plus the 5 largest on-demand teams, not only the seed's team split, and asserts it is within 35 MB (AC-14). The measured total on a real replica (IndexedDB, with tombstones, which accumulate for removed issues and are compacted at re-bootstrap, SPEC-011 §10) is a perf test, held.
- **1,000-case run** of the sync property suite on `main` with Issue, content and partial loading in the generator (AC-8, AC-27, AC-29), recorded in "As built".
- **Hardening:** review every new handler for the lock order of §4.8 (a unit test lists each issue-writing handler and checks it calls `lockIssueForWrite`); the overlay perf test (`overlay.perf.test.ts`) with 10k issues in the base.
- **Tests:** as above, plus `tests/sync-sim/test/issues-real-server.int.test.ts` (extend, sync property suite: AC-18, AC-20).

---

## 2. Modules touched

- `packages/domain`: `src/model/define-model.ts` (`parent`), `src/model/fields.ts` (`day()`), `src/model/issue-models.ts` (new; Issue declares `groups`, S4c), `src/model/workspace-models.ts` (`Label.archivedAt`, `PRODUCTION_MODELS`), `src/model/debug-item.ts`, `src/order-key.ts`, `src/issue.ts`, `src/issue-history.ts`, `src/activity-line.ts` (new), `src/refs.ts`.
- `packages/operations`: `src/optimistic.ts`, `src/define.ts`, `src/lint.ts`, `src/catalog.ts`, `src/ops/issue.ts` (new), `src/ops/debug.ts`, `src/ops/index.ts`.
- `packages/sync-protocol`: `src/socket.ts` (`A`/`V` with `d`; `subscribe`, `unsubscribe`, `subscribed`, the `teams` parameter), `src/schema-hash.ts` (version bumps v0.7 and v0.8, `parent`), `src/content.ts` (new), `src/index.ts`.
- `packages/sync-client`: `src/overlay.ts`, `src/pool.ts`, `src/deltas.ts`, `src/store.ts`, `src/content.ts` (new), `src/subscriptions.ts` (new), `src/hydrate.ts` (skip content models), `src/refs.ts`, `src/locks.ts`, `src/storage/{types,indexeddb,memory,rpc}.ts`, `test/support/{hub,server}.ts`.
- `packages/sync-react`: `src/hooks.ts` (`useIssueContent`, `usePrefetchContent`, `useTeamLoadState`).
- `apps/server`: `src/sync/{repo,bulk,models,groups,registry,delta-writer,content,routes,socket,bootstrap}.ts`, `src/db/schema/issues.ts` (new), `src/db/README.md`, `src/issues/{lifecycle,numbering,history,cascade}.ts` (new), `src/handlers/issues/*` (new), `src/handlers/debug/*`, `src/handlers/index.ts`, `src/executor/{execute,list}.ts`, `src/executor/refs/sources.ts`, `src/http/ops.ts`, `migrations/` (one new migration), `test/seed.ts`.
- `apps/web`: `src/app/router.tsx` (issue route), `src/command-menu/sources/{operations,navigation}.ts`.
- `packages/config/eslint.js` (`SYNCED_TABLES`), `tests/sync-sim/src/*` (generator, world, real server).

## 3. Migration & rollback

- **One migration**, in S3 (next migration number): `issues`, `issue_content`, `issue_history`, `issue_search_text`, their foreign keys and indexes. It is additive. S1, S2, S4, S4b, S4c, S5a, S5b, S6–S8 add no migration: S2's `archivedAt` columns already exist on `labels` and `debug_items`.
- **Before release:** a slice is rolled back by reverting its PR. For S3, revert the migration file with the code and recreate dev and CI databases, because the runner records applied migrations in `schema_migrations` and never runs a down step. S4b and S6 also need dev databases recreated (S4b moves public issues out of `workspace`; issues from S4–S5b have no IssueContent row).
- **After release:** forward-only. A later change adds a migration; nothing is dropped.
- **Clients:** S2 (protocol version bump), S3 (`Issue`), S4b (protocol v0.8), S4c (`Issue.groups`), S5a (content models, `parent`) and S6 (`DOC_SCHEMA_VERSION`) each change the schema hash, so connected clients re-bootstrap once (SPEC-002 E7). Pending mutations survive it (E8). Nothing is released between M1 slices, so users see one reload per release.
- **Wire:** S2 is a codec change. Old clients are told to reload by the schema hash before they decode an `A` or `V` packet with `d`.

## 4. Test plan (AC → test)

> ⏸ **Tests that need a browser, a running stack or Postgres are held** ([README §6](README.md#6-testing-hold-e2e-smoke-and-integration)): rows marked held get no test for now, and the markers override the slices' "Tests:" bullets. Unit and property tests in the same row are still written, and so are the sync property suite and private-team leak tests.

| AC | Test |
|---|---|
| AC-1 | `server/test/issue-handlers.test.ts` (validation of every §4.1 field, default status and priority) (S4) |
| AC-2 | `domain/src/order-key.test.ts` (property, S3) + `server/test/issue-numbering.test.ts` (S3) + `tests/sync-sim/test/issues-real-server.int.test.ts` (sync property suite, not held: concurrent and rejected creates in one team, S4). "Never reused after purge" is extended by PLAN-015 S2. |
| AC-3 | `domain/src/issue.test.ts` (`statusSideEffects` per §4.6 row, Triage/Duplicate refused, INV-20 property) (S4) |
| AC-4 | `domain/src/issue.test.ts` (`mergeLabels` cases and property) + `server/test/issue-handlers.test.ts` (re-read checks) + `tests/sync-sim/test/issues-real-server.int.test.ts` (two clients, adds, removes, same-group adds) (S4) |
| AC-5 | `domain/src/issue-history.test.ts` + `server/test/issue-history-writer.test.ts` (S6) |
| AC-6 | `server/test/issue-description.test.ts` (S6, unit part) + ⏸ held (integration) `server/test/issue-description.int.test.ts` |
| AC-7 | `operations/src/ops/issue.test.ts` (S4, S6) + `sync-client/test/overlay-find.test.ts` (ordered `find`, two rebuilds identical, S1) |
| AC-8 | Sync property suite (not held): `tests/sync-sim/test/content.prop.test.ts` (fake hub: fetches, deletes, purges, `D`+`U`, drops, S5b; evictions, S7) + `tests/sync-sim/test/issues-real-server.int.test.ts` (Issue ops and content on the real server, S6) + the 1,000-case run on `main` (S8) |
| AC-9 | `sync-protocol/test/content.test.ts` (codec) + `server/test/sync-content-route.test.ts` (errors, visibility, counts) (S5a) + `sync-client/test/content-hydration.test.ts` (fake server) (S5b) + ⏸ held (integration) `server/test/sync-content.int.test.ts` (endpoint) |
| AC-10 | Leak tests (not held): `server/test/archive-wire-leak.int.test.ts` (S2), `server/test/issue-leak.int.test.ts` (S4), `server/test/content-leak.int.test.ts` (S5a, S6), completed against permissions.md §5 in S8 |
| AC-11 | `domain/src/issue-filter.test.ts` (client evaluator, S8) + `server/test/issue-filter-conformance.int.test.ts` (Postgres, not held: Q13 exception granted 2026-11-12, S8) |
| AC-12 | `operations/test/spec-011.test.ts` + `operations/test/lint.test.ts` (S4, S6) + the existing `server/test/registry-contract.int.test.ts` (examples against the seed; existing, run) |
| AC-13 | ⏸ held (e2e perf) `e2e/issue-realtime.perf.spec.ts` (checked by hand in PLAN-012 S7's demo) |
| AC-14 | `domain/src/issue-size.test.ts` (row size and the worst-case replica total, S8) + ⏸ held (perf) the measured per-replica total at the reference scale |
| AC-15 | `server/test/issue-handlers.test.ts` (re-read `CONFLICT`, E19) (S4) + ⏸ held (integration) `server/test/issue-status-fk.int.test.ts` (`ON DELETE RESTRICT`) |
| AC-16 | `domain/src/issue.test.ts` (a label moved into an exclusive group: the next add removes the others) (S4, with PLAN-010 S1's rule tests) |
| AC-17 | `server/test/issue-cascade.test.ts` (cascade function, S4) + ⏸ held (integration) `server/test/label-delete-cascade.int.test.ts` (with PLAN-010 S5) |
| AC-18 | `server/test/sync-delta-writer.test.ts`, `sync-client/test/live.test.ts`, `pool.test.ts`, `sync-protocol/test/socket.test.ts` (S2) + sync property suite: `tests/sync-sim/test/archive.prop.test.ts` (S2) and `issues-real-server.int.test.ts` (label cascades, S8) |
| AC-19 | `server/test/issue-child-groups.test.ts` (S3) |
| AC-20 | `server/test/issue-handlers.test.ts` (lock order, S4) + `tests/sync-sim/test/issues-real-server.int.test.ts` (edits racing `label.delete`, S8, after PLAN-010 S5) |
| AC-21 | `server/test/sync-repo-bulk.test.ts` (statement builder, `log: false` rules and the empty patch, S1) + ⏸ held (integration) `server/test/sync-repo-bulk.int.test.ts` |
| AC-22 | `sync-client/test/content-dispatch.test.ts` (fake server, fake-indexeddb) (S5b) |
| AC-23 | `server/test/issue-lock.test.ts` (S3) + `server/test/issue-handlers.test.ts` (S4) + `server/test/issue-description.test.ts` (S6) + ⏸ held (integration) `server/test/issue-readonly.int.test.ts`. Child writes are covered by PLAN-013 S3 and PLAN-014 S4a. |
| AC-24 | `domain/src/issue-slug.test.ts` (property) + `web/test/app-router.test.tsx` (any slug resolves and is replaced) (S4) |
| AC-25 | `domain/src/activity-line.test.ts` (S6) |
| AC-26 | `server/test/issue-groups.test.ts` + `server/test/sync-bootstrap-partial.test.ts` (S4b) + ⏸ held (integration) `server/test/sync-bootstrap-partial.int.test.ts` (bootstrap contents) |
| AC-27 | `sync-client/test/subscriptions.test.ts` + `partial-write.test.ts` + `team-cursor.test.ts` (S4c) + `tests/sync-sim/test/partial.prop.test.ts` (sync property suite, not held, S4c) |
| AC-28 | `server/test/subscribe-leak.int.test.ts` (leak test, not held, S4b) + `server/test/sync-bootstrap-partial.test.ts` (byte-identical answer, S4b) |
| AC-29 | `server/test/sync-bootstrap-partial.test.ts` (S4b) + `sync-client/test/issue-removal.test.ts` (S4c) + `tests/sync-sim/test/partial.prop.test.ts` (sync property suite, not held, S4c) |
| Leak: permissions.md §5 (bootstrap, catch-up, deltas, refs, lists, `groupBy` names, API key `teamIds`, `A`/`V`, `/sync/content`, subscriptions, `user:` groups) | The AC-10 and AC-28 files above (not held) |
| E13 | `server/test/issue-leak.int.test.ts` (one wording for missing, private and key-excluded) (S4) |
| E17, E23, E24, E25 | `sync-client/test/content-hydration.test.ts` (S5b) + `tests/sync-sim/test/content.prop.test.ts` |
| E18 | `sync-client/test/storage.prop.test.ts` (S5b) |
| E19, E22 | `server/test/issue-handlers.test.ts` (S4) + `issues-real-server.int.test.ts` (S8) |
| E21 | `domain/src/issue-history.test.ts` (description fold) (S6) |
| E26 | `sync-client/test/rejection.test.ts` (extend: a queued edit rejected with `CONFLICT` rolls back, nothing unarchived) (S4) |
| E27 | `web/test/app-router.test.tsx` (S4) |
| E28, E29 | `server/test/issue-groups.test.ts` (S4b) + `sync-client/test/issue-removal.test.ts` (S4c) |
| E30 | `sync-client/test/partial-write.test.ts` (S4c) |
| E31 | `sync-client/test/subscriptions.test.ts` (S4c) |
| E35, E36 | `sync-client/test/team-cursor.test.ts` (S4c) + `tests/sync-sim/test/partial.prop.test.ts` (second tab) |
| E32 | `server/test/sync-subscribe.test.ts` (S4b) + `server/test/subscribe-leak.int.test.ts` |
| E33 | `sync-client/test/issue-removal.test.ts` (S4c) + PLAN-012 S4 `web/test/issue-page.test.tsx` (the read-only view) |
| E34 | `sync-react/test/team-load-state.test.tsx` (S4c) + PLAN-012 S3 list tests and PLAN-015 S4 `web/test/archive-screen.test.tsx` (the "Available when online" states) |

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| The shared engine changes (S1, S2, S5a, S5b) break M0 sync for every model | Each lands alone, behind a green `pnpm check`, the existing sync property suite and the existing integration tests (`pnpm test:int`, run for every engine slice). S2 gets its own archive property before any issue exists. |
| Content packets are dropped or resurrected around a content request (the hardest part of §5.3) | Rules are implemented once, in `content.ts`, and each has a named unit test (E17, E23–E25). The fake-hub property suite (S5b) interleaves fetches with every fault at 1,000 cases. Per-row versions and tombstones stay the only source of ordering. |
| Awaiting hydration in `dispatch` reorders seqs or stalls the queue | A FIFO dispatch chain: later dispatches wait behind an awaiting one, so seqs follow call order. Offline with an unhydrated parent refuses at once instead of waiting. `content-dispatch.test.ts` covers both. |
| A deadlock between issue edits, child writes and label cascades | One lock order (§4.8), enforced in `lockIssueForWrite` and the create path; a unit test checks the order of locks each handler takes; the real-server sim races edits against `label.delete` (AC-20). The executor still retries deadlocks (E5), so a missed case degrades to a retry, not an error. |
| Groups from the issue row go stale when a team's privacy changes (M7) or an issue moves (M3) | Documented as the M3/M7 obligation: those operations rewrite issue and child groups with `updateWhere`. `updateWhere` refuses `teamId` patches, so nothing changes groups silently. |
| Eager size over budget (≈ 61 MB at 100k issues if every issue were held) | Partial loading (S4b, S4c; Q15 decided) keeps a replica to its teams' live issues and the user's own. AC-14's row-size test fails on growth; the per-replica total is measured once perf tests resume. |
| A subscription or a `user:` group leaks a private team's issue | Private issues never carry a `user:` group; the server checks every subscription and ignores an invalid one exactly like an unknown team; `subscribe-leak.int.test.ts` (AC-28) is written in S4b, not held. |
| A team's privacy changes (M7) while connections are subscribed to it, so a non-member keeps receiving the now-private team's issues | M7 obligation (SPEC-011 §5.7, §12): a public to private flip drops `team:X`, or sends `resync(groups)`, for every connection subscribed to X whose user isn't a member, and the hub re-checks the `teams=` list at connect (S4b). The M7 plan must carry it with its leak test. The same obligation covers M3's IssueRelation groups (the union of the two public teams' `team:` groups, not the empty intersection). |
| Tabs share one replica but subscribe on their own sockets, so a team's rows go stale while no tab follows it, or one tab removes rows another needs | `teamThrough` per team, the reload and sweep on subscribe, and the exclusive `surface-team:<id>` lock for removal (S4c); `team-cursor.test.ts` and the sim's second tab. |
| A partial bootstrap answer undoes a newer packet in the pool, which has no row versions | `writePartialRows` is version-aware and the pool reloads from storage afterwards (S4c); `partial-write.test.ts` on both storages. |
| Moving public issues from `workspace` to `team:<id>` hides them from a query that filters by a socket's groups | One `visibleGroups(actor)` for every read path (S4b); the leak and unit tests check queries, `IssueRef` and `/sync/content` with an unsubscribed public team. |
| The replica diverges after unsubscribes, reassignments, archives or restores | The removal rules live in two places only (`subscriptions.ts`, `deltas.ts`), each with a unit test; `partial.prop.test.ts` compares with a fresh bootstrap with the same subscriptions at 1,000 cases (S8). |
| `IssueContent` rows broadcast to every connection on each save (§10) | Autosave is debounced (SPEC-013); the description fold keeps history small. Measured once perf tests resume. |
| IndexedDB upgrade for the new stores and the `issueId` index blocks or fails in an open older tab | The existing version-change path (`openUnblocked`, "Another Surface tab is using an older version…") handles it; the schema hash change reloads old tabs first. `indexeddb.test.ts` covers creating the content stores and index on upgrade. |
| Eviction removes content another tab has open | Shared Web Lock per open issue; eviction takes the lock exclusively with `ifAvailable` before removing. No eviction without Web Locks. Team rows use the same rule with `surface-team:<id>` (S4c). |
| Cross-plan drift on shared names (`fractionalKeyBetween` vs `keyBefore`/`keyBetween`, `Label.archivedAt`, lifecycle columns) | One key module in `packages/domain/src/order-key.ts` built on PLAN-010's function; S2 alone declares `Label.archivedAt`; S3's migration alone adds `archived_at`, `deleted_at`, `deleted_by_id` on issues (PLAN-015 S1 adds only its own columns). |
| Two meanings of "hydrate" in `sync-client` (the M0 warm start in `hydrate.ts` and content hydration) | Content hydration lives in `content.ts` with its own names (`hydrated`, `hydrating`); `hydrate.ts` keeps its doc comment saying it is the warm start. |
