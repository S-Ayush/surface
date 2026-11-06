# Session E, phase 2: Workspace data, accounts and teams

Worktree: `/Users/admin/Desktop/Learning/surface-e` · First branch: `p001-s1-schema` · Guide: [README](README.md) §7 · Phase 1 log: [session-e-filter.md](session-e-filter.md)

Assigned 2026-11-07. Session E built the filter engine in phase 1. Phase 2 builds the PLAN-001 data model and the account and team features around session A's setup and auth.

## Setup

```bash
cd /Users/admin/Desktop/Learning/surface-e
git switch -c p001-s1-schema main
source ~/.nvm/nvm.sh && nvm use && pnpm install && pnpm check
```

## Scope, in order

Read [PLAN-001](../PLAN-001-workspace-auth-members-teams.md), [SPEC-001](../../06-specs/SPEC-001-workspace-auth-members-teams.md), [domain-model.md](../../03-domain/domain-model.md), [permissions.md](../../03-domain/permissions.md), `.claude/rules/database.md`, and the PLAN-002 S2 and S6 "As built" notes (synced tables, the repo layer, shared model definitions).

1. **PLAN-001 S1: domain schema and models.** It starts now and unblocks A (PLAN-001 S2), C (PLAN-005 S4) and the rest of PLAN-001.
   - **You hold the migration lock** (README §7) until S1 is on `main`. Then it passes to session A.
   - The tables are the ones S1 lists. Synced tables get `sync_groups`. Instants are `timestamptz(3)`.
   - Include `users.preferences` (domain-model §4.2), which PLAN-005 S7 (session C) needs.
   - Add a shared model definition (`packages/domain/src/model/`) and a server registry entry (`apps/server/src/sync/models.ts`, append-only) for each synced model.
   - Add `groupsOf()`.
   - **Leak tests for each synced model are required** (plans README §6): rows in `team:<id>` never reach a user outside that group.
2. **PLAN-001 S8: teams.** The server half starts after S1.
   - The team-key suggestion algorithm lives in `packages/domain`.
   - Operations and handlers: create, rename, join, leave, membership.
   - The web half (create-team modal, team settings, browse) starts once session C's PLAN-005 S4 shell is on `main`.
   - Until session A's PLAN-001 S3 lands, test with the executor's test actor.
3. **PLAN-001 S4: mailer, magic link, password reset.** Starts after session A's PLAN-001 S3.
   - Unit tests use a fake SMTP server on `127.0.0.1`.
   - The Mailpit e2e is held.
4. **PLAN-001 S5: invites.**
5. **PLAN-001 S6: account settings.**

## Owns

- The PLAN-001 table files under `apps/server/src/db/schema/` and, during S1 only, the migration they generate
- `apps/server/src/mail/**` and the handlers and operations for teams, invites and account settings (`apps/server/src/handlers/{teams,invites,account}/**`, `packages/operations/src/ops/{team,invite,account}.ts`)
- New domain files for workspace, user and team models and team keys (`packages/domain/src/{model,team-key}*`, new files only)
- From PLAN-005 S4 on: `apps/web/src/features/{teams,account,invites}/**`
- PLAN-001 S1, S4, S5, S6 and S8 sections; SPEC-001 changes for those slices (logged)

## Shared registry files

These files are append-only for everyone: `apps/server/src/handlers/index.ts`, `packages/operations/src/ops/index.ts`, `packages/domain/src/model/index.ts`, `apps/server/src/sync/models.ts`, `apps/server/src/db/schema/index.ts` and `packages/domain/src/index.ts`.
- Add your own lines only.
- On a rebase conflict, keep both sides.

## Must not touch

- `apps/server/src/{sync,http,executor,auth,setup}/**` (session A, except the registry files above)
- `packages/sync-client/**` and `packages/sync-protocol/**` (session D)
- The rest of `apps/web/**` and `packages/ui/**` (session C)
- Migrations after S1 is merged
- `CLAUDE.md`, `.claude/**`

## Notes

- **Ports:** dev server 3500, web 5175, dev Postgres 5435.
- **Every state change is an operation** run through the executor, and only `sync/repo.ts` writes synced tables (CLAUDE.md rules 1 and 2). New handlers use the repo layer.
- **Private teams never leak:** invisible rows are `NOT_FOUND`, never `FORBIDDEN` (`permissions.md` §5).

## Handoffs (requests from E to other sessions)

| To | Request | Why / blocking? | Status |
|---|---|---|---|

## Log (append-only)

| Date | Slice | Branch | State | Notes / handoffs |
|---|---|---|---|---|

## Prompt

```
You are session E of the Surface project, phase 2, working in the git worktree /Users/admin/Desktop/Learning/surface-e. Your track is the PLAN-001 data model, accounts and teams: PLAN-001 S1, S8, S4, S5 and S6, in that order.
Read, in order:
- CLAUDE.md, .claude/rules/database.md, docs/07-plans/sessions/README.md (especially §7, phase 2), docs/07-plans/sessions/session-e2-accounts-teams.md;
- then PLAN-001, SPEC-001, domain-model.md, permissions.md, and the PLAN-002 S2 and S6 "As built" notes.
Check the Log and Handoffs tables in all phase 2 session files (a2, c2, d2, e2) before starting.

Implement the scope in session-e2-accounts-teams.md one slice at a time, following .claude/skills/slice/SKILL.md exactly. Start with PLAN-001 S1 on branch p001-s1-schema; you hold the migration lock until it is on main.
Edit only the files listed under "Owns", and the shared registry files append-only. Private-team leak tests are required (plans README §6).
Before each slice: git rebase main, then pnpm install and pnpm check.
After each slice:
- append a row to the Log in session-e2-accounts-teams.md;
- update PLAN-001's "As built" notes for that slice;
- stop and ask me to run /review and /commit.
Never merge to main unless I ask, and then use docs/07-plans/sessions/README.md §5.
```
