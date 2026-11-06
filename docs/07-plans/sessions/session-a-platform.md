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

## Log (append-only)

| Date | Slice | Branch | State | Notes / handoffs |
|---|---|---|---|---|
| 2026-11-06 | PLAN-004 S1 | p004-s1-s2-skeleton | merged | Monorepo skeleton |
| 2026-11-06 | PLAN-004 S2 | p004-s1-s2-skeleton | merged | Server skeleton |
| 2026-11-06 | PLAN-004 S3 | p004-s3-db | built, in review | 58 unit + 18 integration tests green. Awaiting /review findings, then /commit + merge. |
| 2026-11-06 | PLAN-004 S3 | p004-s3-db | committed | All 9 review findings fixed (extensions under the migrations lock, `prepareDatabase()`, 28000 message, lock-based AC-9 test, fatal-exit test). Ready to merge to `main`. |
