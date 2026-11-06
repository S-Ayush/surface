# Session E: Filter engine

Worktree: `/Users/admin/Desktop/Learning/surface-e` · First branch: `p003-s5-filter` · Guide: [README](README.md)

Added 2026-11-06, when session A (main checkout) took PLAN-003 S1–S3. The filter engine is the part of PLAN-003 S5 that doesn't depend on the executor, so it runs here in parallel.

## Scope, in order

Read [PLAN-003](../PLAN-003-operation-registry-executor.md) S5 and risks, [SPEC-003](../../06-specs/SPEC-003-operation-registry-executor.md) §7, and [domain-model §5](../../03-domain/domain-model.md#5-filter-model).

1. **PLAN-003 S5 (filter core):** the Filter AST and Zod schema, field types, resolution of relative values, the client evaluator `matches()`, the SQL compiler, and the conformance harness (AC-6).
2. **Not in this session:** list helpers, cursors, and `fields` projection (AC-7). They need the S4 executor and stay with session A unless reassigned.

## Owns

- `packages/domain/src/filter/**`, plus the one-line export in `packages/domain/src/index.ts`
- `apps/server/src/executor/filter-sql.ts`, `apps/server/test/filter-*.test.ts`
- The S5 section of `docs/07-plans/PLAN-003-*.md`; SPEC-003 §7.4 (filter semantics, new)

## Must not touch

Everything session A owns, except the files above: `packages/operations/**`, `packages/domain/src/{refs,permissions}*`, the rest of `apps/server/src/executor/**`, `apps/server/src/db/**`, migrations, `CLAUDE.md`, `.claude/**`.

## Handoffs (requests from E to other sessions)

| To | Request | Why / blocking? | Status |
|---|---|---|---|
| A | Skip the filter-engine part of PLAN-003 S5 (AST, evaluator, SQL compiler, conformance). Session E builds it on `p003-s5-filter`. List helpers, cursors and `fields` stay with A. | Avoid duplicate work | done 2026-11-06 (filter core merged at `7f7b840`; A builds S5 on it in `p003-s5-queries`) |
| A | CLAUDE.md layout says `packages/domain` has "(no deps)". It now depends on `zod` (as PLAN-003 planned for filter and ref schemas). Change it to "(no workspace deps)". | Accuracy of agent instructions | done 2026-11-06 (CLAUDE.md: "no workspace deps; Zod only") |
| A | **Millisecond timestamps.** Every synced table stores instants as `timestamptz(3)`, never plain `timestamptz` (µs). Record it in `.claude/rules/database.md` (and `db/README.md` when it exists), and use it in the first real tables (PLAN-002 S2 `DebugItem`, PLAN-001 S1). | The client compares filters at ms precision (SPEC-003 §7.4). With µs in the database, `createdAt > X` can differ between the client and SQL. **Needed before the first synced table.** | done 2026-11-06 (`c895d62` and earlier on `main`) |
| A | **ICU collation startup check.** In `db/checks.ts`, add a check that runs with the extension check (SPEC-004 §8 step 4): `SELECT 1 FROM pg_collation WHERE collname = 'und-x-icu'`. If it is missing, fail startup with a `StartupError` like: "PostgreSQL was built without ICU, which Surface needs for case-insensitive search. Use the official postgres:17 image, or a PostgreSQL build with ICU support." Add an int test (simulated: a check function over a pool where the query returns no row) and a row in the SPEC-004 §8 list. | `contains` filters use `lower(… COLLATE "und-x-icu")` (SPEC-003 §7.4). Without ICU every text search is a 500. The official image has ICU, so this protects external databases. | done 2026-11-06 (`c895d62` and earlier on `main`) |
| A | **Flaky AC-9 test.** `apps/server/test/startup.int.test.ts:80-84` waits until `pg_locks` shows exactly one waiting advisory lock, but doesn't filter by database or key. When several test files run at once, another file's waiter (e.g. `createTestDatabase` on `LOCKS.testDatabases`) can satisfy it before the server is waiting, so the "waiting for another instance to finish migrations" assertion runs too early. Failed 1 of 4 full `pnpm test:int` runs on `main` `bd1a4cd`; passes alone. Fix: poll `SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database()) AND ((classid::bigint << 32) \| objid::bigint) = $1::bigint` with `[LOCKS.migrations]`, and `return rowCount === 1`. Prove it first: a test that holds an unrelated advisory-lock wait in another database must not satisfy the poll. | CI flakiness; it will get worse as more integration test files are added | done 2026-11-06 (`c895d62` and earlier on `main`) |

## Log (append-only)

| Date | Slice | Branch | State | Notes / handoffs |
|---|---|---|---|---|
| 2026-11-06 | PLAN-003 S5 (filter core) | p003-s5-filter | started | Worktree created; gate green. |
| 2026-11-06 | PLAN-003 S5 (filter core) | p003-s5-filter | built, in review | 22 domain unit + 2 conformance tests (1,500 generated filters); `pnpm check` and `pnpm test:int` green. SPEC-003 §7.4 + D1 added. Awaiting /review and /commit. |
| 2026-11-06 | PLAN-003 S5 (filter core) | p003-s5-filter | review fixed | All 10 /review findings fixed (multi-kind node bypass, instant range, ids-only refs documented, visibility-scoped columns + leak test, `me` and time-zone errors, number types, model typing, index and codec notes). |
| 2026-11-06 | PLAN-003 S5 (filter core) | p003-s5-filter | merged | On `main` at `7f7b840`. Verified `main` `bd1a4cd`: `pnpm check` green; `pnpm test:int` 119/119 in 3 of 4 runs (AC-9 flake → handoff to A). Handoffs 1–2 done; 3–5 open. |
| 2026-11-06 | — | p003-s5-handoffs | closed | Session A completed handoffs 3–5: `timestamptz(3)` rule, `und-x-icu` startup check, AC-9 poll scoped to the lock key. No open handoffs. |
| 2026-11-06 | — (process) | p003-s5-handoffs | built, in review | **Ownership exception, assigned by the user to session E:** the testing hold (plans README §6, SPEC-001/002/005 D1, ⏸ rows in PLAN-001/002/005, METHODOLOGY DoD, CLAUDE.md, `.claude/rules`, slice skill, reviewer agent) and the unit-test network guard (`packages/config/vitest-no-network.js`). These files are session A's; rebased on `main` `94efbfb` so PLAN-002 S2's tests (AC-1, AC-12) stay un-held. Sync property suite and private-team leak tests are excluded from the hold (user's choice). |
