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

## Log (append-only)

| Date | Slice | Branch | State | Notes / handoffs |
|---|---|---|---|---|
| 2026-11-06 | PLAN-002 S1 | p002-s1-protocol | built, in review | `packages/sync-protocol` codecs, NDJSON, `computeSchemaHash`. 99 tests; `pnpm check` green. Protocol additions handed off to A (Handoffs row 1). Shared-file changes: `pnpm-lock.yaml` (zod, fast-check, @types/node in sync-protocol). |
