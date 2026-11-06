# Session A: Platform core (critical path)

Worktree: `/Users/admin/Desktop/Learning/surface` (main checkout) · Coordinator for all sessions · Guide: [README](README.md)

## Scope, in order

1. **PLAN-004 S3:** database layer. Built and under review on `p004-s3-db`. Finish the review, commit, and merge to `main`. This unblocks session B.
2. **PLAN-003 S1–S7:** operation registry, refs, actor and predicates, executor, filter engine, HTTP ops, registry lint ([PLAN-003](../PLAN-003-operation-registry-executor.md), [SPEC-003](../../06-specs/SPEC-003-operation-registry-executor.md)).
   - **S1** (`defineOperation`) and **S2** (ref interfaces) unblock session D's S8. Merge them early.
3. **PLAN-002 S2–S5:** sync tables and repo layer, bootstrap endpoint, sync hub/WebSocket, mutate endpoint (server half of [PLAN-002](../PLAN-002-sync-engine-v0.md)).

## Owns

- `packages/operations/**`
- `packages/domain/src/refs*`, `packages/domain/src/filter*`, `packages/domain/src/permissions*`
- `apps/server/src/{executor,handlers,http/ops.ts,jobs,sync}/**`
- `apps/server/src/db/**` and `apps/server/migrations/**` (**the only session that generates migrations in phase 1**)
- `CLAUDE.md`, `.claude/**`, `docs/07-plans/README.md`, this folder's README

## Provides to other sessions

| What | For | When |
|---|---|---|
| PLAN-004 S3 on `main` (`prepareDatabase()` for the CLI `migrate`; `checkPostgresVersion`, `ensureExtensions`, `migrationStatus` for `doctor`; `startServer`) | B (CLI `migrate`, `doctor`) | first |
| `defineOperation`, the op type and the client resolver interface (PLAN-003 S1–S2) | D (S6 resolvers, S8 dispatch) | early in phase 1 |
| Wire contract kept in sync with `packages/sync-protocol` (owned by D) | D | PLAN-002 S3–S5 |

## Prompt

Paste into a new session in this worktree if this session is ever restarted.

```
You are session A of the Surface project, the platform core and critical path. You also coordinate the parallel sessions.
Read, in order: CLAUDE.md, docs/07-plans/sessions/README.md, docs/07-plans/sessions/session-a-platform.md, and docs/07-plans/README.md.
Then check the Log in session-a-platform.md to see where we are.

Work through the scope in session-a-platform.md one slice at a time, following .claude/skills/slice/SKILL.md exactly.
Before each slice: rebase on main, run pnpm install and pnpm check, and read the Handoffs tables in the other session files for requests addressed to A.
Edit only the files listed under "Owns". Shared files follow the README §3 rules.
You are the only session allowed to generate database migrations.
After each slice:
- append a row to the Log in session-a-platform.md;
- update the plan's "As built" notes;
- stop and ask me to run /review and /commit.
Never merge to main unless I ask, and then use README §5.
```

## Handoffs (requests from A to other sessions)

| To | Request | Why / blocking? | Status |
|---|---|---|---|
| B | Add `pnpm test:int` to CI using a Postgres 17 service container. Set `TEST_DATABASE_URL` to a superuser URL. | Integration tests (PLAN-004 S3) must run in CI | open |
| B | `surface doctor`: add a "Collations" check, a problem when `und-x-icu` is missing. Reuse `REQUIRED_COLLATIONS` / `checkCollations()` from `src/db/checks.ts` (on `main` once `p003-s5-queries` merges), and add the row to the SPEC-004 §9 doctor table. | Startup now fails without ICU (SPEC-004 §8 step 3); doctor should report it first | open |
| B | Release workflow (PLAN-004 S7): run `pnpm registry:snapshot` and commit `packages/operations/catalog.snapshot.json` with each release. | Rule 8 diffs against the last released catalog (SPEC-003 §11) | open |
| D | PLAN-002 S2 is ready for the client side: `debug.create/rename/touch/delete` have `optimistic()`; `sync_log.data` is the row as JSON (camelCase, ISO ms timestamps, `syncGroups` included); A/V carry full rows; a groups change is `D` (old groups) then `U` (new groups), consecutive ids (SPEC-002 Q4, Q5). | Client store, delta apply and S8 overlay | open |

## Log (append-only)

| Date | Slice | Branch | State | Notes / handoffs |
|---|---|---|---|---|
| 2026-11-06 | PLAN-004 S1 | p004-s1-s2-skeleton | merged | Monorepo skeleton |
| 2026-11-06 | PLAN-004 S2 | p004-s1-s2-skeleton | merged | Server skeleton |
| 2026-11-06 | PLAN-004 S3 | p004-s3-db | built, in review | 58 unit + 18 integration tests green. Awaiting /review findings, then /commit + merge. |
| 2026-11-06 | PLAN-004 S3 | p004-s3-db | committed | All 9 review findings fixed (extensions under the migrations lock, `prepareDatabase()`, 28000 message, lock-based AC-9 test, fatal-exit test). Ready to merge to `main`. |
| 2026-11-06 | PLAN-004 S3 | p004-s3-db | merged | Already on `main` (`00c9ef5`) when this session resumed; the worktrees for B, C, D branch from it. |
| 2026-11-06 | PLAN-003 S1 | p003-s1-registry | built, in review | `defineOperation`, registry, `toJsonSchema` / `toCompactSchema`, `OptimisticStore` and `PermissionPredicates` interfaces. 40 unit tests; `pnpm check` green. Shared-file changes: `zod` added to `packages/operations/package.json` via `pnpm add` (lockfile regenerated). For D: S8 can start once this is on `main`; implement `OptimisticStore` from `packages/operations/src/optimistic.ts`. |
| 2026-11-06 | PLAN-003 S1 | p003-s1-registry | committed | `6dd8e12`. Review deferred by the user; S2 continues on the same branch. |
| 2026-11-06 | PLAN-003 S2 | p003-s1-registry | built, review deferred | Ref types + parsers + `ClientRefResolver` in domain; server `resolveRefs` with planner. 13 domain unit, 8 planner unit, 28 resolver integration tests; `pnpm check` and `pnpm test:int` green. Spec: SPEC-003 §4 rules + Q4/Q5. Shared-file changes: `zod` added to `packages/domain/package.json`; CLAUDE.md domain line. For D: `ClientRefResolver` in `packages/domain/src/refs.ts` is the S6 interface. For PLAN-001 S1: table/column names the resolvers expect are in the S2 "As built". |
| 2026-11-06 | PLAN-003 S2 | p003-s1-registry | committed | `53bac42`. Review deferred. |
| 2026-11-06 | PLAN-003 S3 | p003-s1-registry | built, review deferred | `Actor` (+ `memberOf`), predicates and `evaluatePermission` shared via domain/operations; server key-scope checks. `pnpm check` + `pnpm test:int` green. For PLAN-001 S3: build actors with `userActor()` (memberships incl. public teams). |
| 2026-11-06 | PLAN-003 S3 | p003-s1-registry | committed | `2ebbde5`. Review deferred. |
| 2026-11-06 | PLAN-003 S4 | p003-s1-registry | built, review deferred | Executor pipeline, transactions (Q6 isolation), passthrough repo, outbox, `debug.echo`/`debug.touch`. Migration `0001_executor_outbox` (`event_outbox`, `debug_items`). Fixed: DB error params leaking into logs (`loggableError`). `pnpm check` + `pnpm test:int` (76) green. AC-11 p95 1.7 ms under parallel load: watch for flakes. For D/PLAN-002 S2: reuse `debug_items`; replace `passthroughRepo` via `repoFactory`. |
| 2026-11-06 | PLAN-003 S4 | p003-s1-registry | committed | `f7ad182`. |
| 2026-11-06 | PLAN-003 S1–S4 review | p003-s1-registry | fixed | All 15 slice-reviewer findings + nits (see PLAN-003 "Review fixes"). `ApiKeyScope` gained `id` (domain). AC-11 moved to `executor-overhead.perf.int.test.ts`, run alone by `vitest.perf.config.js`; outside the brief's owned paths: `apps/server/package.json` `test:int` script and the server Vitest configs. `pnpm check` + `pnpm test:int` (81 + 2 perf) green. For PLAN-001 S1: set `teamColumn` in `SYNCED_MODELS` for team-owned models. |
| 2026-11-06 | PLAN-003 S1–S4 | main | merged | main fast-forwarded to `5530f76`. One `pnpm test:int` failure (AC-11 timing under load from other sessions); fixed by best-of-3 rounds. |
| 2026-11-06 | PLAN-003 S1–S4 + S5 filter core | main | merged | Session E's `p003-s5-filter` rebased onto main (conflicts in `domain/src/index.ts` and SPEC-003 Decisions, kept both), gate + `test:int` green, main fast-forwarded to `7f7b840`. AC-11 timing test reworked (`35d15b8`): same round trips in the baseline, best of 3 rounds. |
| 2026-11-06 | PLAN-003 S5 | p003-s5-queries | built | Lists (keyset cursors, visibility in SQL, count, groupBy), `fields` projection (AC-7), `debug.listItems`, migration `0002_debug_items_ms`. E's handoffs done: `timestamptz(3)` rule, ICU collation startup check. `pnpm check` + `pnpm test:int` (11 files + perf) green. SPEC-003 §7.1–7.3 + Q7. |
| 2026-11-06 | PLAN-003 S5 | p003-s5-queries | committed | `a6ed7f7`. |
| 2026-11-06 | PLAN-003 S6 | p003-s5-queries | built | `POST /api/ops/:name`, `GET /api/ops`, `/api/openapi.json`; idempotency (migration `0003_api_idempotency`), token-bucket limits, pg-boss 12.38.1 with the hourly prune. New error code `UNAUTHENTICATED` (401). Wired into `app.ts`/`server.ts` (unowned; built by A in PLAN-004). `pnpm check` + `pnpm test:int` (14 files + perf) green; real server booted against postgres:17 and curled. For PLAN-001 S3: `ActorResolver` + CSRF. |
| 2026-11-06 | Session E handoffs | p003-s5-queries | done | (a) `timestamptz(3)` rule and (b) ICU check were built in S5 (`a6ed7f7`); added the SPEC-004 §8 step 3 wording. (c) Flaky AC-9: `startup.int.test.ts` now counts only waiters on `LOCKS.migrations` in its own database; a new test with unrelated waits (another database, another key) failed on the old query (2) and passes on the new one. Also fixed a second intermittent failure seen in `test:int`: `test/db.ts` `drop()` force-dropped while `Pool#end()` sockets were still closing (unhandled FATAL 57P01); it now waits for the database's backends to leave first (`test-db.int.test.ts` failed 2/2 before). Handoff to B: doctor collation check. |
| 2026-11-06 | PLAN-003 S5–S6 + flake fixes | main | merged | Rebased (no-op), gate + `test:int` green, main fast-forwarded to `c895d62`. |
| 2026-11-06 | PLAN-003 S7 | p003-s7-registry | built | Registry lint (8 rules, SPEC-003 §11 + Decision D2), `catalog.snapshot.json`, `pnpm registry:lint` / `registry:snapshot`, one fixture per rule (AC-9), server contract test for examples with a stub seed fixture (PLAN-001 extends it). Handoff to B: snapshot on release. |
| 2026-11-06 | PLAN-003 S7 review | p003-s7-registry | fixed | slice-reviewer: 0 blockers, 1 major, 6 minor. Fixed: rule 8 blind to nullable array items (snapshot now built from JSON Schema, items as `path[]`), input bounds/patterns/strict objects now compared, untested rule 1/7 branches, description length relabelled rule 1, stale PLAN-003 lines, contract-test isolation note. Declined: name prefix must equal `domain` (S1 decision; domain-model §7 files ops across domains). |
| 2026-11-06 | PLAN-003 S7 + review fixes | main | merged | Rebased onto `181d4ba` (PLAN-005 S1–S3, PLAN-004 S6–S7), clean. `pnpm install`, `pnpm check`, `pnpm registry:lint`, `pnpm test:int` (18 files + perf) green; main fast-forwarded. B's CI (`ci.yml`) runs `pnpm test`, so the registry lint gates PRs. PLAN-003 complete. |
| 2026-11-06 | PLAN-002 S2 | p002-s2-repo | built | Migrations `0004_sync_tables`, `0005_seed_sync_state`; `sync/repo.ts` replaces the passthrough; debug create/rename/delete (+ optimistic for all four); lock-hold metric; AC-1 stress (observer + replay, planted bug caught), lock-hold perf, AC-12 lint rule + runtime write audit. SPEC-002 Q4, Q5 + sync-protocol §6. Shared-file changes (additive): `packages/config/eslint.js` (`SYNCED_TABLES` + the `surface/no-synced-table-writes` block), `packages/config/eslint-rules/no-synced-table-writes.{js,d.ts}`, `packages/config/eslint.d.ts`, `packages/config/tsconfig.json` (declarations only), `packages/config/package.json` export. Handoff to D. |
