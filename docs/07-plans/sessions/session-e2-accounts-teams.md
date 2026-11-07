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
   - Include user preferences (domain-model §4.2), which PLAN-005 S7 (session C) needs.
   - Add a shared model definition (`packages/domain/src/model/`) and a server registry entry (`apps/server/src/sync/models.ts`, append-only) for each synced model.
   - Add `groupsOf()`.
   - **Leak tests for each synced model are required** (plans README §6): rows in `team:<id>` never reach a user outside that group.
2. **PLAN-001 S8: teams.** The server half starts after S1.
   - The team-key suggestion algorithm lives in `packages/domain`.
   - Operations and handlers: create, rename, join, leave, membership.
   - The web half (create-team modal, team settings, browse) starts once session C's PLAN-005 S4 shell is on `main`.
   - **Command-menu entries for the team ops** (reassigned from PLAN-001 S9 to E by the user, 2026-11-07): `ui` metadata in `ops/team.ts` and `apps/web/src/features/teams/commands.ts`, built with the web half, following session C's handoff to E (`session-c2-web-shell.md`, PLAN-005 S6). Ask C for the form command ids and shortcuts. `team.leave` and `team.removeMember` get `ui` only after session D's store lookup gives them `optimistic` (lint rule 3).
   - Until session A's PLAN-001 S3 lands, test with the executor's test actor.
3. **PLAN-001 S4: mailer, magic link, password reset.** Starts after session A's PLAN-001 S3.
   - Unit tests use a fake SMTP server on `127.0.0.1`.
   - The Mailpit e2e is held.
4. **PLAN-001 S7: Members and Workspace (Admin).** Reassigned from session A to E by the user on 2026-11-07. Starts once A's PLAN-001 S3 is on `main`, and builds on its actor and permission wiring.
   - **Server:** ops `user.list`, `user.get`, `user.setRole` (with the last-Admin guard: INV-01, E6), `workspace.get` and `workspace.update`.
   - **Web:** the Settings → Members and Settings → Workspace screens, registered in C's `SCREENS` (`apps/web/src/features/screens.ts`), never in the router. The Members screen comes before S5 because the invite modal lives on it.
   - `ui` metadata and `commands.ts` entries for these ops come with this slice, as for S8.
   - **Tests:** AC-10 and AC-14.
   - The S7 section of PLAN-001 is edited only when the slice is built.
5. **PLAN-001 S5: invites.**
   - Includes `ui` metadata and `apps/web/src/features/invites/commands.ts` for the invite ops ("Invite member…"), as for S8.
6. **PLAN-001 S6: account settings.**

## Owns

- The PLAN-001 table files under `apps/server/src/db/schema/` and, during S1 only, the migration they generate
- `apps/server/src/mail/**` and the handlers and operations for teams, invites, account settings, members and the workspace (`apps/server/src/handlers/{teams,invites,account,members,workspace}/**`, `packages/operations/src/ops/{team,invite,account,member,workspace}.ts`)
- New domain files for workspace, user and team models and team keys (`packages/domain/src/{model,team-key}*`, new files only)
- From PLAN-005 S4 on: `apps/web/src/features/{teams,account,invites,members,workspace}/**` (including their `commands.ts`; `features/commands.ts` and `features/screens.ts` are shared and append-only)
- PLAN-001 S1, S4, S5, S6, S7 and S8 sections; SPEC-001 changes for those slices (logged)

## Shared registry files

These files are append-only for everyone: `apps/server/src/handlers/index.ts`, `packages/operations/src/ops/index.ts`, `packages/domain/src/model/index.ts`, `apps/server/src/sync/models.ts`, `apps/server/src/db/schema/index.ts` and `packages/domain/src/index.ts`, `apps/web/src/features/commands.ts` and `apps/web/src/features/screens.ts` (C's `SCREENS`).
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
| A | PLAN-001 S1 changed your test fixtures: `test/executor.ts` now seeds ENG and SEC as real teams (the `exec_fixture.teams` stand-in would hide the real table on the harness's `search_path`); `list.int.test.ts`, `sync-groups.int.test.ts`, `sync-registry.test.ts` and `sync-hangup.test.ts` were adjusted (PLAN-001 S1 "As built"). Please look them over when you rebase. | Your files; needed for S1's tables. Not blocking. | open |
| A | `ModelInsert` requires `syncGroups`, which the repo overwrites, so S1's seeds pass `[]`. Consider making it optional in `sync/models.ts` (DebugItem's `groupsOf` reads it, so it would need a fallback). | Clarity. Not blocking. | open |
| A | The migration lock passes to you when PLAN-001 S1 is on `main` (README §7). S2 setup can use `teamWorkflow`, `seedTeamWorkflow` and `seedWorkspaceLabels` (`handlers/teams/seed.ts`). | Unblocks PLAN-001 S2 | done 2026-11-07: S1 on `main` (`07f31df`); **A holds the migration lock** |
| A | Defence in depth for `sync_log`: have `repo.ts` store only the model's declared fields plus `syncGroups` in `RowChange.row` (PLAN-002 S2 note). S1 keeps every synced table free of undeclared columns (`workspace-models.test.ts`), so nothing leaks today; a projection would stop the next one. | Review of PLAN-001 S1 (blocker, fixed at the schema). Not blocking. | open |
| C | Your file says PLAN-005 S7 needs "the `users.preferences` column": it is the **`UserPreferences` model** instead (its own row, id = the user's id, `values` json, synced to `user:<id>`). Register `PRODUCTION_MODELS` (`@surface/domain/model`) in the web client's store, so its schema hash matches the server's. `COLOR_HUES` in `@surface/domain` mirrors the UI's `LABEL_HUES`; a test in `packages/ui` comparing them would keep them equal. `UserPreferences.values` is yours to shape in `user.updatePreferences`. | PLAN-005 S4 and S7 | done 2026-11-07: C's reply, `3d16aba` (PLAN-005 S6, on `main`): hue test in `packages/ui`, docs use the `UserPreferences` model; registering `PRODUCTION_MODELS` is a PLAN-005 S4 bullet |
| A | PLAN-001 S8 changed `test/seed.ts` (your example fixture): it now seeds the actor Ada (Admin, member of ENG), team ENG with its workflow, and Iris, once per database, so the contract test runs the team examples. Your later examples can name them. | Your file; needed for S8's examples. Not blocking. | open |
| A | S3: build `actor.memberOf` per request; `team.update`, `addMember` and `removeMember` check it. S9: **E now adds the `ui` metadata and command-menu entries for E's own ops** (teams with the S8 web half, invites with S5; reassigned by the user 2026-11-07, after session C's command-menu handoff to E). S9 keeps the registry lint across every SPEC-001 op and adds `ui` for your remaining ops; the members and workspace ops moved to E with S7 (2026-11-07), so E adds theirs. Please reword S9's `ui` bullet in PLAN-001 to match. | PLAN-001 S3, S9. Not blocking. | in progress: A builds `memberOf` (and private-team groups) per request in S3 (`p001-s3-auth`); close when S3 is on `main` |
| D | The optimistic store (`OptimisticStore` in `packages/operations`, implemented by the sync-client overlay) finds rows by id or reference only. `team.leave` and `team.removeMember` need to remove a membership named by team and user, so they predict nothing yet. Could the store offer a lookup by fields, e.g. `store.find('TeamMembership', { teamId, userId })`, over base plus overlay? The interface file is in `packages/operations` (session A's PLAN-003 area); coordinate there. | PLAN-001 S8 web half: leave and remove show only after the server answers. Not blocking. | open |
| A | Wire the PLAN-001 S4 mailer (`apps/server/src/mail/job.ts`) into your files:<br>- `createEmailQueue(boss)` at startup in every role that sends;<br>- `startEmailWorker(boss, { smtp: config.smtp, sessionSecret: config.sessionSecret, log })` in `startJobs` for the `all` and `worker` roles when `config.smtp` is set; `await worker.stop()` on shutdown, or rely on `boss.stop()`;<br>- **a way to enqueue on the operation's connection.** `HandlerContext` exposes none today (`ctx.query` is read helpers only; `ctx.tx.$client` is typed pool-or-connection). For example `ctx.enqueueEmail(email)`, which calls `enqueueEmail(boss, client, emailSealKey(secret), email)` with the executor's `PoolClient`, plus the same for the auth routes. The `web` role then starts pg-boss for sending only.<br>FYI: E updated SPEC-004 §7 `SMTP_URL` (your spec) for the TLS rule; the row now says `smtp://` requires STARTTLS with credentials and verifies certificates. | PLAN-001 S4 routes and S5 invites need it. Not blocking until then. | accepted 2026-11-07: A wires it (incl. `ctx.enqueueEmail` on the operation's connection) as its own change once the S4 mailer is on `main`, and reviews the SPEC-004 `SMTP_URL` row then |
| A | A way for handlers to end sessions and close their sockets, like `ctx.enqueueEmail`. For example `ctx.closeSessions(userId, { except?: sessionId })`, which deletes the rows and calls `hub.closeSessions` after commit. Handlers also need the current session's id (`actor`) for "Revoke all others". Users: S6 `user.changePassword`, `session.revoke`, `session.revokeOthers` (PLAN-001 S6 test: revoking a session closes its socket) and the S4 `/auth/reset` route (E10). S7 needs none: `user.setRole` takes effect on the next request (SessionAuth reads the role per request). | PLAN-001 S4 routes and S6. Not blocking until then. | accepted 2026-11-07: A does it in one follow-up right after S3, with `ctx.enqueueEmail`; `closeSessions` goes through `pg_notify` to every hub, so it works across replicas |

## Log (append-only)

| Date | Slice | Branch | State | Notes / handoffs |
|---|---|---|---|---|
| 2026-11-07 | PLAN-001 S1 | p001-s1-schema | built, in review | Migrations `0006` (generated) and `0007` (deferrable same-team default-status FK, `setup_state` row): 7 synced and 5 server-only tables with INV-01–05 constraints. 7 shared models + `PRODUCTION_MODELS`, `groupsOf` per model, seeds through the repo. Deviations: preferences are their own `user:<id>` row; status `position` is a fractional key (domain-model updated). Session A's test fixtures switched to real teams (handoff). New tests: 11 domain, 34 server unit, 5 leak (mutation-checked). Held constraint tests checked by hand. `pnpm check` and `pnpm test:int` (184 + 3) green. Shared files: `packages/config/eslint.js` (`SYNCED_TABLES`), `sync/models.ts`, `db/schema/index.ts`, `domain` and `model` index files, A's tests, domain-model §4.2/§4.4. |
| 2026-11-07 | PLAN-001 S1 | p001-s1-schema | review fixed | Blocker: `sync_log` stored password hashes (whole rows). Fixed at the schema: `user_credentials` and `team_issue_counters` (server-only), last seen from sessions; synced tables may hold only declared columns (test, mutation-checked). Also `FOR SHARE` in `groupsOf`, leak test checks `sync_log` and rolls back, INV-02 and SPEC-001 wording, domain-model §4.2/§4.3/§4.16. Reverted my edit to session C's file (handoff instead); projection in `repo.ts` proposed to A. |
| 2026-11-07 | PLAN-001 S1 | main | merged | Rebased onto `99aacd3` (PLAN-005 S5), clean. `pnpm install`, `pnpm check`, `pnpm test:int` (186) green; perf not rerun (`sync-lock.perf` flaky under machine load, also on unchanged `main`, see As built). `main` was checked out in the main checkout (clean), so at the user's request it was fast-forwarded there with `git merge --ff-only` to `07f31df`. **Migration lock passes to session A.** Next for E: PLAN-001 S8 (teams). |
| 2026-11-07 | PLAN-001 S8 (server half) | p001-s8-teams | built, in review | Domain: `suggestTeamKey`, `NEW_TEAM_SETTINGS`, `newTeamWorkflow`, derived status and membership ids (`teamMembershipId`), `timeZoneProblem`. Ops `team.suggestKey/create/update/join/leave/addMember/removeMember` with `optimistic` (no `ui`: S9). Handlers in `handlers/teams/`; taken key → `CONFLICT` with the next suggestion, also on a concurrent create; idempotent membership ops; events. Spec: E11 (key existence is visible), E12 (a private team keeps its last member), §6.2 inputs. Session A's `test/seed.ts` now seeds the examples' users and ENG. New tests: 18 domain, 11 operations, 6 server unit, 8 leak (mutation-checked). Held criteria checked by hand; found and fixed `PST` being accepted. `pnpm check` and `pnpm test:int` (194 + 3) green. Web half waits for PLAN-005 S4. Also moves the S1 merge row, appended below the prompt by mistake, into this table. |
| 2026-11-07 | PLAN-001 S8 (server half) | p001-s8-teams | review fixed | slice-reviewer: 0 blockers, 3 majors, 6 minor, nits; all fixed. User decisions: persisted ids are random UUIDv7 again (derived ids dropped; overlay-only ids stay client-side); SPEC-001 **D2** (a private team's key existence is visible; exception noted in permissions.md §5) and **D3** (a private team keeps its last member). Fixes: `team.leave` is `p.any()` and idempotent; membership ops lock the team `FOR NO KEY UPDATE` (concurrent join/leave idempotent, no internal ids); key rules moved to the handler so malformed and reserved keys also get the next suggestion; Admin non-member in the leak test (mutation-checked); registry lists leave before join (fixture comment fixed); test table rows for E11, E12, leak; `canEndMembership` unit-tested; plan heading without ✅; canonical time zones, UUIDv7 `id`, reserved keys in the description from the constant. Leave and remove lose `optimistic` (handoff to D). Fast-forwarded onto `08f2ccd` (PLAN-002 S4) and ran `pnpm install`. `pnpm check` green (domain 96, operations 115, server 330); `pnpm test:int` 196 + 3 perf green (load ≈ 8). Held behaviour rechecked by hand. |
| 2026-11-07 | Scope | p001-s8-teams | changed | By the user: E adds `ui` metadata and command-menu entries (`features/<feature>/commands.ts`) for its own ops, the team ones with the S8 web half and the invite ones with S5, instead of A in PLAN-001 S9 (handoff to A updated). Session C's command-menu handoff to E applies from then. C's reply to my handoff is done in `3d16aba` (PLAN-005 S6), not yet on `main`: mark my row to C done once it is. |
| 2026-11-07 | PLAN-001 S8 (server half) | p001-s8-teams | rebased | Rebased onto `9ba1eb0` (PLAN-005 S6, command menu, and C's handoff to E); `pnpm install` (lockfile: mobx in web, `@surface/domain` as a ui dev dependency); `pnpm check` green, including `command-operations.test.ts` (the team ops have no `ui` yet). Handoff to C marked done (`3d16aba` on `main`). |
| 2026-11-07 | PLAN-001 S8 (server half) | main | merged | `pnpm check` green on the final branch; `pnpm test:int` (196 + 3) last run before the rebases onto PLAN-005 S6, which brought web code and docs only. `main` was checked out in the main checkout (clean), so at the user's request it was fast-forwarded there with `git merge --ff-only` to `aea1377`. The web half waits for PLAN-005 S4; next: PLAN-001 S4 after A's S3. |
| 2026-11-07 | PLAN-001 S4 (mailer half) | p001-s4-mail | built, in review | Started ahead of A's S3 at the user's request. `apps/server/src/mail/`: Nodemailer mailer (`requireTLS` with credentials), magic-link, reset and invite templates (HTML + text), link builders, sealed job payloads (AES-256-GCM from `SESSION_SECRET`), the `email-send` queue (enqueue on the request's connection; worker with retry/give-up rules). New dependency `nodemailer` 7.0.9 (ADR-0007), typed locally (`@types/nodemailer` would pull in the AWS SES SDK). New tests: 32 server unit against a fake SMTP server on 127.0.0.1. Real pg-boss checked by hand (rollback sends nothing, commit sends, no token stored, retry on SMTP down). `pnpm check` green (server 367). Wiring is A's (handoff). Routes, op, CLI and web after S3. |
| 2026-11-07 | PLAN-001 S4 (mailer half) | p001-s4-mail | review fixed | slice-reviewer: 0 blockers, 1 major, 8 minor, 4 nits; all fixed. Major: the docs pointed handlers at `ctx.query.client`, which does not exist; the handoff to A now asks for an enqueue capability, and `enqueueEmail` takes a `PoolClient` only. Minor: a 5xx on `MAIL FROM` is retried (only `RCPT`/`DATA` are final); the link and token are masked in logged SMTP replies; the last retry logs an error; `startEmailWorker` returns `stop()` (`offWork`); TLS without credentials documented; `nodemailer` ^10.3.1 (security fixes since 7.0.9); SPEC-004 §7 `SMTP_URL` updated (A's spec, noted in the handoff); AC-5 note for the routes. Nits: test counts, retry window, fixed seed, at-least-once delivery noted. Rebased onto `786d60c` (PLAN-001 S2), then onto `c99c862` (PLAN-002 S9 part 1); `nodemailer` re-added on top. |
| 2026-11-07 | Scope | p001-s4-mail | changed | By the user: PLAN-001 S7 (Members and Workspace, Admin; both halves) moves from session A to E. It is now scope item 4, after the rest of S4 and before S5, because the invite modal lives on the Members screen. It needs A's S3 on `main`. Owns now include `handlers/{members,workspace}`, `ops/{member,workspace}.ts` and `features/{members,workspace}`. `features/commands.ts` and `features/screens.ts` are listed as shared registry files. The PLAN-001 S7 section is edited when the slice is built. A updates the README §7 table. |
| 2026-11-07 | PLAN-001 S4 (mailer half) | main | merged | `pnpm check` green on `2b1d149` (server 406); the commit after it, `224eb79`, is docs only. `pnpm test:int` not run: no database code changed; pg-boss behaviour checked by hand. `main` was checked out in the main checkout (clean) at `c99c862`, so at the user's request it was fast-forwarded there with `git merge --ff-only` to `224eb79`. The lockfile changed (`nodemailer`): other sessions run `pnpm install` after rebasing. Next for E: the rest of S4, then S7, S5, S6, all after A's S3; the S8 web half after C's PLAN-005 S4. |
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
