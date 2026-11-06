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
| A | Skip the filter-engine part of PLAN-003 S5 (AST, evaluator, SQL compiler, conformance). Session E builds it on `p003-s5-filter`. List helpers, cursors and `fields` stay with A. | Avoid duplicate work | open |
| A | CLAUDE.md layout says `packages/domain` has "(no deps)". It now depends on `zod` (as PLAN-003 planned for filter and ref schemas). Change it to "(no workspace deps)". | Accuracy of agent instructions | open |
| A | Schema convention for every synced table: instants are `timestamptz(3)` (millisecond precision), so client-side filters compare exactly what the server stores. Add it to `db/README.md` / `.claude/rules/database.md`. | Filter conformance (SPEC-003 §7.4) | open |
| A | Startup check in `db/checks.ts`: the ICU collation `und-x-icu` must exist (`SELECT 1 FROM pg_collation WHERE collname = 'und-x-icu'`), with an actionable message if not. `contains` filters use it. | Without it, `contains` queries fail at runtime | open |

## Log (append-only)

| Date | Slice | Branch | State | Notes / handoffs |
|---|---|---|---|---|
| 2026-11-06 | PLAN-003 S5 (filter core) | p003-s5-filter | started | Worktree created; gate green. |
| 2026-11-06 | PLAN-003 S5 (filter core) | p003-s5-filter | built, in review | 22 domain unit + 2 conformance tests (1,500 generated filters); `pnpm check` and `pnpm test:int` green. SPEC-003 §7.4 + D1 added. Awaiting /review and /commit. |
| 2026-11-06 | PLAN-003 S5 (filter core) | p003-s5-filter | review fixed | All 10 /review findings fixed (multi-kind node bypass, instant range, ids-only refs documented, visibility-scoped columns + leak test, `me` and time-zone errors, number types, model typing, index and codec notes). |
