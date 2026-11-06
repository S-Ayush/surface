# Session D: Client sync engine

Worktree: `/Users/admin/Desktop/Learning/surface-d` · First branch: `p002-s1-protocol` · Guide: [README](README.md)

## Setup

```bash
cd /Users/admin/Desktop/Learning/surface
git worktree add ../surface-d -b p002-s1-protocol main
cd ../surface-d && source ~/.nvm/nvm.sh && nvm use && pnpm install && pnpm check
claude
```

## Scope, in order

Read [PLAN-002](../PLAN-002-sync-engine-v0.md), [SPEC-002](../../06-specs/SPEC-002-sync-engine-v0.md), [sync-protocol.md](../../04-architecture/sync-protocol.md), ADR-0002 and ADR-0003, and [permissions.md](../../03-domain/permissions.md) §1–2 (sync groups).

1. **S1: `packages/sync-protocol`:** wire types and Zod codecs (bootstrap frames, WebSocket messages, mutate request and response), the NDJSON encoder and decoder, and `computeSchemaHash`.
2. **S6: client store:** `defineModel`, the MobX object pool, secondary indexes, the IndexedDB worker, the bootstrap reader, and warm start. Test against fake-indexeddb with recorded or fake bootstrap streams.
   - **Model definitions must be importable by the server** (it builds its sync registry from them, PLAN-002 S3). Put the declarative `defineModel` and its types in a shared package (`packages/sync-protocol` or new files under `packages/domain/src/model/`), not in `sync-client`. Only the runtime pool lives in `sync-client`.
   - Client ref resolvers implement the interface from PLAN-003 S2 (session A). Leave a typed TODO until it is on `main`.
3. **S7: socket client and delta apply:** connection lifecycle and backoff, strict in-order apply, `prev` gap detection, resync, close code 4001. Test against an in-process fake server that speaks the S1 protocol.
4. **S8: mutation queue, overlay and dispatch.** Start only once session A's PLAN-003 S1 (`defineOperation`) is on `main`.

The server half (PLAN-002 S2–S5) belongs to session A. The wire format is the contract between you: any protocol change goes into `packages/sync-protocol` **and** `sync-protocol.md`, with a handoff to A.

## Owns

- `packages/sync-protocol/**`, `packages/sync-client/**`
- New files under `packages/domain/src/model/**` (model-definition types only)
- The S1, S6, S7 and S8 sections of `docs/07-plans/PLAN-002-*.md`; `docs/04-architecture/sync-protocol.md` (changes logged and handed off to A)

## Must not touch

`apps/server/**`, `packages/operations/**`, `packages/domain/src/{refs,filter,permissions}*`, `packages/ui/**`, `.github/**`, `CLAUDE.md`, `.claude/**`.

## Notes

- **Read `.claude/rules/sync.md`** before you start. Exactly-once delivery, strict ordering and the server-authoritative model are non-negotiable.
- **No real sleeps in tests:** use fake timers, deterministic seeds, and an injectable clock and transport.
- **Package boundaries:** `sync-client` may import `domain`, `operations` and `sync-protocol`. `sync-protocol` may import `domain` only (`.dependency-cruiser.cjs`).

## Prompt

```
You are session D of the Surface project, working in the git worktree /Users/admin/Desktop/Learning/surface-d. Your track is the client side of the sync engine: PLAN-002 slices S1, S6 and S7, then S8 once PLAN-003 S1 is on main.
Read, in order:
- CLAUDE.md, .claude/rules/sync.md, docs/07-plans/sessions/README.md, docs/07-plans/sessions/session-d-sync-client.md;
- then PLAN-002, SPEC-002, docs/04-architecture/sync-protocol.md, ADR-0002 and ADR-0003.
Check the Log and Handoffs tables in all four session files before starting.

Implement the scope in session-d-sync-client.md one slice at a time, following .claude/skills/slice/SKILL.md exactly. Start with PLAN-002 S1 on branch p002-s1-protocol.
Edit only the files listed under "Owns". The server side belongs to session A: log every wire-protocol change and send it to A through the Handoffs table.
Before each slice: git rebase main, then pnpm install and pnpm check.
After each slice:
- append a row to the Log in session-d-sync-client.md;
- update PLAN-002's "As built" notes for that slice;
- stop and ask me to run /review and /commit.
Never merge to main unless I ask, and then use docs/07-plans/sessions/README.md §5.
```

## Handoffs (requests from D to other sessions)

| To | Request | Why / blocking? | Status |
|---|---|---|---|
| A | **Wire-protocol additions from PLAN-002 S1** (sync-protocol.md v0.2, §4 and §11). Build S3–S5 on the codecs in `@surface/sync-protocol`: (1) `deltas.prev` = last packet id sent on this connection (or `since`); packet ids strictly increasing; (2) send `{packets: [], ack: [...]}` when a client's own mutation produced no rows visible to it; never send a message with neither; (3) the WS URL carries `schemaHash` (`decodeSocketConnectParams`); (4) `SEQ_GAP` (400) body adds `lastSeq`; `CLIENT_OUTDATED` is 426; (5) batches are 1–100 mutations with consecutive seqs, and `results` mirror them in order; (6) close codes `CloseCode.ServiceRestart` 1012 and `CloseCode.SessionRevoked` 4001. | Contract for PLAN-002 S3–S5. Not blocking D. Say so here if any of it doesn't work for the server side. | open |
| A | **Protocol v0.3 and shared model definitions (PLAN-002 S6).** (1) Bootstrap `meta.rows` is required: the exact number of `row` frames, counted in the same REPEATABLE READ snapshot; `end.rows` repeats it. (2) Send archived rows in bootstrap with `"archived": true` on the row frame. (3) Build the S3 sync registry from `@surface/domain/model` (`ModelDef`: `name`, `load`, `fields[*].type/nullable`, `rowSchema`) and the `DebugItem` fixture there (`title`, `counter`, `groups: string[]`); the server's schema hash is `computeSchemaHash(models)`. Rows must contain every declared field; extra columns are dropped by the client. (4) `packages/domain/package.json` gains `zod` (same as your S2) and a `./model` subpath export; expect a trivial merge. **Update after S6 review:** (5) `row.archived` is now an optional boolean (`false` is accepted too), so you may always send it. (6) The `enum<…>` type string in the schema hash lists members sorted, and `defineModel` rejects field or ref names such as `toJSON` and `constructor`. Both come for free if the registry uses `@surface/domain/model`. (7) Archived state changes only through `A` and `V` packets: a `U` keeps it. When an edit also unarchives a row (state-machines.md §2), the repo layer must emit `U` and `V` in the same transaction (sync-protocol.md §4.3). (8) `defineModel` also reserves `then`. | Contract for PLAN-002 S3. Not blocking D. | open |
| A | **Protocol v0.4 (PLAN-002 S7).** (1) `GET /sync/ws` without a valid session (none, expired or revoked): accept the upgrade, then close at once with `4001`, sending nothing first. Do not refuse it with `401`: the browser only sees `1006` and the client would retry forever (sync-protocol.md §4.3, SPEC-002 E10). Please add a server test for it. (2) No wire change, for your hub tests: the client treats `prev > lastSyncId` as a gap and skips packets with `id ≤ lastSyncId` when `prev ≤ lastSyncId`, so a resent or overlapping message is harmless. The hub should not rely on that: `prev` stays the last id sent on the connection. | Needed for S4 (hub auth); not blocking D | Open |

## Log (append-only)

| Date | Slice | Branch | State | Notes / handoffs |
|---|---|---|---|---|
| 2026-11-06 | PLAN-002 S1 | p002-s1-protocol | built, in review | `packages/sync-protocol` codecs, NDJSON, `computeSchemaHash`. 99 tests; `pnpm check` green. Protocol additions handed off to A (Handoffs row 1). Shared-file changes: `pnpm-lock.yaml` (zod, fast-check, @types/node in sync-protocol). |
| 2026-11-06 | PLAN-002 S1 | p002-s1-protocol | committed | bcf5084. S6 branched from it. |
| 2026-11-06 | PLAN-002 S6 | p002-s6-client-store | built, in review | `@surface/domain/model` (defineModel, DebugItem), sync-client pool/indexes/storage/bootstrap/warm start/store. 77 + 17 tests; `pnpm check` green. Protocol v0.3 (`meta.rows`, `row.archived`) handed off to A. Shared-file changes: `pnpm-lock.yaml`; `packages/domain/package.json` (zod, `./model` export). Client ref resolvers left as TODO until PLAN-003 S2 is on main. Spec: SPEC-002 §5.1 module list updated to the as-built layout. |
| 2026-11-06 | PLAN-002 S6 | p002-s6-client-store | review fixes, in review | All `/review` findings fixed test-first, except #18 (perf test left as agreed). Main fixes: worker/RPC can no longer hang start-up (timeouts, error events, `close` terminates the worker; blocked IDB upgrade rejects); cross-tab start-up uses Web Locks (shared for hydrate, exclusive for bootstrap) and separates *fenced* from *lost* storage; hydrate rejects a replica that changed generation mid-read; rows and instances are frozen and views get a `ReadonlyPool`, with the public exports narrowed. Property tests were added for the pool and for two-tab storage, both mutation-checked. 109 sync-client + 20 domain + 101 sync-protocol tests; `pnpm check` green. **New ADR-0015** (Proposed) supersedes ADR-0003's enforcement clause; `docs/04-architecture/adr/README.md` index row added (a shared file). Protocol: `row.archived` widened to boolean (v0.3, unreleased), and the Handoffs row 2 update went to A. `src/refs.ts` placeholder removed; client ref resolvers are now an S8 bullet (PLAN-003 S1 and S2 are on `main`, so S8 is unblocked). |
| 2026-11-06 | PLAN-002 S6 | p002-s6-client-store | second review fixes, in review | Second `/review`: no blockers. Fixed test-first: `close()` waits for the running task, never lets a start report `ready` afterwards, and resets the store to `idle`; a failed worker now falls back to IndexedDB on the main thread rather than memory; the memory `applyChanges` is all-or-nothing; `then` is a reserved model member; the row-count error names every count; the hydrate generation test isolates the generation check (mutation-checked). Protocol: archived state changes only through `A`/`V` (sync-protocol.md §4.3, v0.3); Handoffs row 2 items (7)–(8) go to A. Re-applying the overlay on warm start is now an S8 bullet. ADR-0015 is still Proposed; acceptance is pending before merge. 117 sync-client + 20 domain + 101 sync-protocol tests. |
| 2026-11-06 | PLAN-002 S6 | p002-s6-client-store | committed | be5f5fb. ADR-0015 accepted by the user. Not merged to main. Next: S7 after `git rebase main` (picks up PLAN-003 S1–S5). |
| 2026-11-06 | PLAN-002 S7 | p002-s7-socket | built, in review | Rebased on main (PLAN-003 S1–S5, PLAN-004 S4–S5); S1 and S6 are now 04646b8 and a39e12a on this branch. `SyncSocket` (backoff, ping/pong, silence watchdog, online event, 4001), `planDeltas` (E1 gap, E2 duplicates, G → resync), store wiring (connect when ready, per-message persistence on the serial queue, resync and outdated status). An in-process fake hub for tests. 152 sync-client tests, including a 200-run convergence property test; mutation-checked. `pnpm check` green. Protocol: sync-protocol.md §4.3 clarifies `prev ≤ lastSyncId` (client behaviour only, no wire change, no handoff needed). Spec: SPEC-002 §5.1 module list. |
| 2026-11-06 | PLAN-002 S7 | p002-s7-socket | review fixes, in review | All `/review` findings fixed. Test-first: (#1) a resync no longer runs under a live connection: it stops the socket inside its queued task, and deltas are refused unless `status` is `ready`; (#4) a failed resync re-runs when the next connection opens (new `SyncSocket` `onOpen` option); (#3, client side) `4001` on a connection that never opened is reported as revoked. Also: a behavioural E2 test (an older message re-delivered cannot undo a newer one); the property test also checks storage, via a warm start; a `randomUuid` test; `#closed` clears the watchdog handle. Docs: SPEC-002 E1 (it said `prev ≠ lastSyncId`) and E10; protocol v0.4 (unauthenticated upgrade → `4001`; the S7 clarification now has its own §11 row) and Handoffs row 3 to A. Shared files edited: SPEC-002 (E1, E10, §5.1). Left for others: `.claude/rules/sync.md:15` still says `prev ≠ lastSyncId` (the user's to reword); PLAN-002 §4 should list the client AC-9 test. 157 sync-client tests; `pnpm check` green. |
| 2026-11-06 | PLAN-002 S7 | p002-s7-socket | second review fixes, in review | Rebased on main (S1 = 0a61995, S6 = f066ac5; the `pnpm-lock.yaml` conflict in S6 was resolved by taking main's lockfile and re-running `pnpm install`). Second `/review`: no blockers. Fixed test-first, each mutation-checked: (M1) a start or resync that finishes after `close()` rejects as aborted and does not connect, and close's queued task stops the socket too; (M2) a test that a reload after a schema change keeps `pending` (AC-10); (m1) a bad row reconnects 3 times, then re-bootstraps, and a bad snapshot fails without retrying, with the new `store.error`; (n1) no redial after a revoke; (n2) a connection stopped while it opens is closed; (n4) `start()` on a running store does nothing; (n3) documented in As built. SPEC-002 (shared, Accepted; the user approved the edit): E12 added and a "Changes after acceptance" note for E1, E10 and E12. Still open for others: `.claude/rules/sync.md:15` and the PLAN-002 §4 AC-9 row. 165 sync-client tests; `pnpm check` green. |
