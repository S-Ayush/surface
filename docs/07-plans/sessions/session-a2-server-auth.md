# Session A, phase 2: Sync server, setup and auth

Worktree: `/Users/admin/Desktop/Learning/surface` (main checkout) · Current branch: `p002-s3-bootstrap` · Guide: [README](README.md) §7 · Phase 1 log: [session-a-platform.md](session-a-platform.md)

Assigned 2026-11-07. Session A stays on the critical path: finish the sync server, then setup and login, which unblock the app shell (session C) and the account features (session E).

## Scope, in order

Read [PLAN-002](../PLAN-002-sync-engine-v0.md) S3–S5, [PLAN-001](../PLAN-001-workspace-auth-members-teams.md), [SPEC-001](../../06-specs/SPEC-001-workspace-auth-members-teams.md), [SPEC-002](../../06-specs/SPEC-002-sync-engine-v0.md), [sync-protocol.md](../../04-architecture/sync-protocol.md) and [permissions.md](../../03-domain/permissions.md).

1. **PLAN-002 S3: bootstrap endpoint** (in progress on `p002-s3-bootstrap`).
2. **PLAN-002 S4: sync hub and WebSocket.**
3. **PLAN-002 S5: mutate endpoint.** Phase 1 ends when S5 is on `main` (README §6).
   - S3–S5 need no migration. If one turns out to be needed, ask session E first (README §7, migrations).
   - **Leak tests are required, not held:** AC-11 for bootstrap (S3), and for catch-up and live deltas (S4), against Postgres (plans README §6).
4. **PLAN-001 S2: first-run setup.** Starts once session E's PLAN-001 S1 (tables) is on `main`.
   - Also close session B's open handoff: update the root `README.md` step 6 with the real setup log line and URL.
5. **PLAN-001 S3: password auth, sessions, CSRF.** It unblocks session C (PLAN-005 S4) and session E (PLAN-001 S4–S6). Tell the user when it merges.
6. **PLAN-001 S7: Members (Admin).**
7. **PLAN-001 S9: hardening and lint.** This comes last, after session E's S8.

## Owns

- `apps/server/src/{sync,http,executor,cli,jobs}/**`, `apps/server/src/{app,server,lifecycle,config,logger,main}.ts`
- New modules `apps/server/src/auth/**` and `apps/server/src/setup/**`
- `apps/server/src/db/**`, except the PLAN-001 table files session E adds under `db/schema/` and E's S1 migration
- Handlers and operations for the members slice (S7)
- `CLAUDE.md`, `.claude/**`, `docs/07-plans/README.md`, the root `README.md`
- PLAN-002 S3–S5 and PLAN-001 S2, S3, S7, S9 sections; SPEC-001 and SPEC-002 changes for those slices (logged)

## Shared registry files

These files are append-only for everyone: `apps/server/src/handlers/index.ts`, `packages/operations/src/ops/index.ts`, `packages/domain/src/model/index.ts`, `apps/server/src/sync/models.ts`, `apps/server/src/db/schema/index.ts` and `packages/domain/src/index.ts`.
- Add your own lines only.
- On a rebase conflict, keep both sides.

## Must not touch

- `packages/sync-client/**` and `packages/sync-protocol/**` (session D)
- `apps/web/**` and `packages/ui/**` (session C)
- Session E's PLAN-001 modules (teams, invites, account, mail)
- Migrations, until E's PLAN-001 S1 is on `main`

## Open items carried over

| Item | From | When |
|---|---|---|
| Root `README.md` step 6: real setup log line and URL | session B handoff | PLAN-001 S2 |
| `.claude/rules/sync.md:15` still says `prev ≠ lastSyncId`; the protocol is now `prev ≤ lastSyncId` (sync-protocol.md §4.3) | session D log | Ask the user, then reword (A owns `.claude/**`) |
| Zod `eval` probe under the CSP | your PLAN-004 S9 handoff | Moved to session C (it owns `apps/web`); mark your row "reassigned to C" |

## Handoffs (requests from A to other sessions)

| To | Request | Why / blocking? | Status |
|---|---|---|---|

## Log (append-only)

| Date | Slice | Branch | State | Notes / handoffs |
|---|---|---|---|---|

## Prompt

```
You are session A of the Surface project, phase 2, working in the main checkout /Users/admin/Desktop/Learning/surface. Your track is the sync server, then setup and auth: finish PLAN-002 S3–S5, then PLAN-001 S2, S3, S7 and S9.
Read, in order:
- CLAUDE.md, docs/07-plans/sessions/README.md (especially §7, phase 2), docs/07-plans/sessions/session-a2-server-auth.md;
- then PLAN-002, PLAN-001, SPEC-001, SPEC-002, sync-protocol.md and permissions.md.
Check the Log and Handoffs tables in all phase 2 session files (a2, c2, d2, e2) before starting.

Implement the scope in session-a2-server-auth.md one slice at a time, following .claude/skills/slice/SKILL.md exactly. Continue PLAN-002 S3 on p002-s3-bootstrap.
Edit only the files listed under "Owns", and the shared registry files append-only. Don't generate migrations until session E's PLAN-001 S1 is on main. Private-team leak tests are required (plans README §6).
Before each slice: git rebase main, then pnpm install and pnpm check.
After each slice:
- append a row to the Log in session-a2-server-auth.md;
- update the plan's "As built" notes for that slice;
- stop and ask me to run /review and /commit.
Never merge to main unless I ask, and then use docs/07-plans/sessions/README.md §5.
```
