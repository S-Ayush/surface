# PLAN-001: Workspace setup, authentication, members & teams

Implements: [SPEC-001](../06-specs/SPEC-001-workspace-auth-members-teams.md) · Status: **Ready** · Order: **4th** · Depends on: PLAN-002 S5 (mutate) and S8 (client dispatch), PLAN-003 S6 (HTTP ops)

> **UI note:** screens are built with the PLAN-005 primitives when available (S2 and S3 of PLAN-005 run in parallel). Otherwise they use plain functional markup, restyled in PLAN-005 S7. Layouts follow SPEC-001 §7.

---

## 1. Slices

### S1: Domain schema & models · M · ✅ Done 2026-11-07
- Migrations: `workspace`, `users`, `sessions`, `invites` (with `team_ids uuid[]`), `magic_link_tokens`, `password_reset_tokens`, `setup_state`, `teams`, `team_memberships`, `workflow_statuses`, `labels`. All synced tables have `sync_groups`, and server-only tables are marked as such.
- Constraints for the invariants: unique lowercase email, unique display name, team key check `^[A-Z]{2,5}$` plus unique, one active-admin check (enforced in the handler; a DB trigger is not needed), the default status category check.
- `groupsOf()` for each synced model (`workspace` for all in M0; `team:<id>` logic is ready for private teams).
- Shared **model definitions** (`packages/domain/models/*`): Workspace, User (public fields), Team, TeamMembership, WorkflowStatus, Label, UserPreferences. These are registered with sync-client and the server sync registry, which bumps the schemaHash.
- `seedTeamWorkflow(tx, teamId)` (8 statuses per SPEC-001 §4) and `seedWorkspaceLabels(tx)`.
- **Tests:** constraint tests, seed functions satisfy INV-04 and INV-05.

> **As built (2026-11-07).**
> - **Versions:** no new packages.
> - **Migrations:** `0006_workspace_identity_teams` (generated) and `0007_team_default_status_and_setup` (custom). Schema in `apps/server/src/db/schema/workspace.ts`; sync scope per table in `apps/server/src/db/README.md`. Session E held the migration lock (sessions README §7); it passes to session A when this merges.
>   - **Synced:** `workspace`, `users`, `user_preferences`, `teams`, `team_memberships`, `workflow_statuses`, `labels`. **Server-only:** `user_credentials` (password hashes), `team_issue_counters`, `sessions`, `invites` (`team_ids uuid[]`), `magic_link_tokens`, `password_reset_tokens`, `setup_state` (one row, seeded by `0007`).
>   - **A synced table has no column its model doesn't declare** (apart from `sync_groups`, `archived_at`): the repo logs whole rows to `sync_log` and every write is a delta, so a password hash on `users` would sit in the log and each password change would be broadcast to the workspace (found in review). So the password hash, the issue counter and "last seen" (= the latest `sessions.last_used_at`) are not on `users`/`teams`. `workspace-models.test.ts` enforces it.
>   - **Constraints:** INV-01 one workspace (unique index on `(true)`); INV-02 email stored lowercase (CHECK) and unique, display name unique ignoring case; INV-03 key format, reserved keys (`NEW`, `API`, `MCP`, `SYNC`, `AUTH`) and uniqueness; INV-04 at most one Triage and one Duplicate status per team (partial unique index; "at least one per category" is `workflowProblems`); INV-05 `teams.default_status_id` → `workflow_statuses (id, team_id)`, so it must be the same team's status, **DEFERRABLE INITIALLY DEFERRED** (custom SQL: a team and its statuses refer to each other, so the check runs at commit). Enums are text with CHECKs, typed in Drizzle with `$type<>()`. Status names are unique per team and label names per scope and parent, ignoring case. The one-active-Admin rule (INV-01) stays in the handler, as planned.
> - **Domain (`packages/domain`):** `workspace.ts` has `COLOR_HUES` (the 12 palette hues), `USER_ROLES`, `SIGNUP_POLICIES`, `ESTIMATE_SCALES`, `teamKeyProblem` (format and reserved keys; S8 adds suggestions), `DEFAULT_TEAM_WORKFLOW`, `DEFAULT_WORKSPACE_LABELS` and `workflowProblems(statuses, defaultStatusId)` for INV-04/05. `model/workspace-models.ts` has the seven shared model definitions and `PRODUCTION_MODELS`, the list the client store must register (sync-client `createStore({ models })`) to get the server's schema hash.
> - **Server:** `SYNCED_MODELS` gains the seven models with `groupsOf` (permissions.md §2: workspace and users `workspace`; preferences `user:<id>`; a team `workspace` while public, `team:<id>` when private; memberships, statuses and team labels read their team's groups in the transaction; workspace labels `workspace`) and `teamColumn`; the team-scoped ones read the team `FOR SHARE`, so a child written while the team turns private waits for it and gets the new groups. `SYNCED_TABLES` in `packages/config/eslint.js` lists the tables. `handlers/teams/seed.ts`: `teamWorkflow(teamId)` makes the 8 statuses with fresh ids and picks Backlog as default; `seedTeamWorkflow(repo, workflow)` and `seedWorkspaceLabels(repo)` write through the repo.
> - **Deviations:**
>   - **Preferences are their own synced row** (`UserPreferences`, table `user_preferences`, id = the user's id, `values` json), not a `users.preferences` column (domain-model §4.2): a row has one set of groups, and `users` is `workspace` while preferences are `user:<id>` (SPEC-001 §5). domain-model §4.2 updated. Its `values` shape belongs to `user.updatePreferences` (PLAN-005 S7, session C).
>   - **`WorkflowStatus.position` is a fractional-index string** (`a0`, `a1`, …), not a float: the model fields have no float kind, and domain-model §1 already orders manual lists this way. domain-model §4.4 updated.
>   - The seed functions take the **repo**, not `tx` (planned `seedTeamWorkflow(tx, teamId)`): only the repo may write synced tables. Make the workflow first (`teamWorkflow`), insert the team with its `defaultStatusId`, then seed the statuses.
>   - Team rows declare every domain-model field (cycle settings included), with defaults, so later slices need no migration for them.
>   - **Server-only fields are tables, not columns** (domain-model §4.2, §4.3, §4.16 updated): `UserCredentials` (password hash), `TeamIssueCounter` (upserted per issue), and "last seen" from sessions. SPEC-001 §4 updated; Feature's colour is `violet` (the palette has no purple).
> - **Test fixtures changed (session A's files, needed by this slice):** `test/executor.ts` now creates ENG (public) and SEC (private) as **real teams** through the repo and `seedTeamWorkflow`, instead of a stand-in `exec_fixture.teams` table, which would now hide the real one on the harness's `search_path`. `list.int.test.ts` references `public.teams`. `sync-groups.int.test.ts` checks its debug items only (the teams arrive too) and parses each row with its own model. `sync-registry.test.ts` expects the production models. `sync-hangup.test.ts` uses a one-model registry, because its fake pool answers for one model.
> - **Review fixes (2026-11-07):** the password hash, issue counter and last-seen time moved off the synced tables (above; a blocker: `sync_log` stored every hash); team reads in `groupsOf` lock `FOR SHARE`; the leak test rolls back a failed setup and checks `sync_log`; the column test allows only sync bookkeeping; INV-02 and SPEC-001 wording; session C's file is left to C (handoff).
> - **Tests:**
>   - `domain/src/workspace.test.ts` (11): the default workflow and labels, INV-04/05 cases, a fast-check property (`workflowProblems` accepts exactly the valid workflows), team key format and reserved keys.
>   - `server/test/team-seed.test.ts` (5): `teamWorkflow` satisfies INV-04/05 with Backlog as default; positions; seeding goes through the repo in order.
>   - `server/test/workspace-models.test.ts` (29): client and server register the same models and hash; for each model, every field has a column of matching type and nullability, no table has a column outside its model but `syncGroups`/`archivedAt` (fails if `password_hash` is put back on `users`; checked), the secret and counter tables aren't synced, and `groups` is declared exactly by team-scoped models; `groupsOf` for row-only models.
>   - `server/test/team-groups.int.test.ts` (7, **leak test, not held**): through `/sync/bootstrap`, a user outside private team SEC gets none of SEC's team, statuses, label or membership, and only their own preferences; a SEC member gets all 11 SEC rows with SEC's group; a password hash reaches no bootstrap row and is never stored in `sync_log`; every row passes its client model. Mutation-checked: with every team public, 3 fail.
> - **Held criteria, checked by hand** (README §6), with a temporary test against Postgres 17, not committed: duplicate and uppercase emails, display names differing in case, bad roles, team key format, reserved and duplicate keys, a default status of another team and a missing one (both fail at commit with `teams_default_status_fk`), a second Triage and Duplicate status, status names differing in case, a bad category, label name per scope ignoring case, a label as its own parent, a bad colour, a second workspace, `domain` signup without a domain, the seeded `setup_state` row and a second one, a duplicate membership. All behaved as designed.
> - **Verified:** `pnpm check` green; `pnpm test:int` 186 green. Perf: green before the review fixes; after them `sync-lock.perf` (2 ms p95 budget) passed 5 of 8 runs while other sessions loaded the machine (load ≈ 6), and unchanged `main` failed it 3 of 5 runs under the same load, so it is the environment, not this slice (the lock path doesn't touch team groups).
> - **Notes for later slices:**
>   - **S2 (setup):** in one transaction: `workspace`, the admin `users` row and its `user_preferences` row, `seedWorkspaceLabels`, then the first team (`teamWorkflow` → insert `Team` → `seedTeamWorkflow`) and its membership; set `setup_state.completed_at` (server-only, plain SQL). `ModelInsert` requires `syncGroups`; pass `[]`, the repo computes them. The admin's password goes into `user_credentials` with plain SQL (server-only).
>   - **S8 (teams):** check `teamKeyProblem` and `workflowProblems` before inserting, so users get a sentence instead of a constraint name.
>   - **M7 (private teams):** making a team private changes its children's groups; the repo recomputes groups only for the row it writes, so that operation must update its memberships, statuses and labels too.
>   - **C (PLAN-005):** register `PRODUCTION_MODELS` in the web client's store. `COLOR_HUES` (domain) must stay equal to the UI's `LABEL_HUES` tokens.

### S2: First-run setup · M · ✅ Done 2026-11-07
- On startup, if `setup_state.completed_at` is null: generate a token (or use `SURFACE_SETUP_TOKEN`), store its hash, and log the setup URL as a prominent block.
- `surface setup-token` CLI (regenerate and print).
- `GET /setup/status`, `POST /setup` (token check, row lock on `setup_state`, one transaction: workspace + admin + team + membership + statuses + labels, then a session cookie).
- A setup guard on every route while setup is incomplete (API returns 503 `SETUP_REQUIRED`; web redirects).
- **Setup wizard UI** (3 steps, keyboard-advance) in `apps/web/src/routes/setup`.
- **Tests:** AC-1 (token required), AC-2 (atomic, with a kill-mid-setup integration test using fault injection), E1 (concurrent setup).
- Unblocks PLAN-004 S8 (install smoke; deferred, SPEC-004 D4).

> **As built (2026-11-07).**
> - **Versions:** `@node-rs/argon2` ^2.2.2 (ADR-0007 names it; prebuilt binaries, no install script). No migration: `setup_state`, `sessions` and `user_credentials` came with S1.
> - **Structure (server):**
>   - `setup/token.ts`: 160-bit tokens as eight groups of four Crockford base32 characters, SHA-256 hash, constant-time match, `setupUrl`.
>   - `setup/store.ts` (`pgSetupStore`, behind `SetupStore`): `isComplete`, `tokenValid`, `issueToken`, and `complete`, the one transaction. The password is hashed before `BEGIN`; then `setup_state` is locked `FOR UPDATE` (E1: a second setup waits, then sees `completed_at` → `complete`), the token checked, and Workspace, User (admin), UserPreferences, the 3 workspace labels, Team (`teamWorkflow` → Team → `seedTeamWorkflow`) and the TeamMembership go through the repo, then `user_credentials`, `setup_state` (completed, token cleared) and the session by plain SQL (server-only tables). It listens for `error` on its checked-out client: pg-pool removes its own listener while a client is out, so a connection killed between statements was an uncaught exception that ended the process (found by the hand check below).
>   - `setup/routes.ts`: `GET /setup/status`, `POST /setup`, and `SetupGate`, which remembers once setup is done (so the guard then costs nothing) and asks the database each time until then (so another replica's setup is noticed). The guard is an `onRequest` hook, registered before every other route (SPEC-001 Q5). `/setup/` is not in `SERVER_PREFIXES`, because that would also keep the wizard page from the SPA fallback.
>   - `setup/input.ts`: the body's Zod schema (email lowercased, key uppercased, `passwordProblem`, `teamKeyProblem`, an IANA time zone) and `displayNameFor` (Q6).
>   - `setup/announce.ts`: startup step 5 (SPEC-004 §8) on every role but `worker`: issue a token and log the link at `warn`, in the message and a `setupUrl` field (Q4). JSON logs can't show a banner, so the README says `grep setupUrl`.
>   - `auth/password.ts` (argon2id m = 19 MiB, t = 2, p = 1; `Algorithm` is a const enum the package can't export under `verbatimModuleSyntax`, so the value is written out and the test checks the PHC string) and `auth/session.ts` (`createSession`: random 256-bit token, SHA-256 stored, 30-day expiry; `sessionCookie`: `HttpOnly; SameSite=Lax`, `Secure` on an https `SURFACE_URL`).
>   - `cli/setup-token.ts`: `surface setup-token` prints a fresh link (stdout) and exits 1 once setup is complete; errors are sentences without the connection string.
> - **Structure (shared):** `@surface/domain` `auth.ts`: `PASSWORD_MIN_LENGTH` (10, AC-9), `PASSWORD_MAX_LENGTH` (256, bounds argon2's work) and `passwordProblem`, counted in code points.
> - **Structure (web, by the user's decision: session A builds the wizard although C owns `apps/web`):** `apps/web/src/routes/setup/`: `wizard.ts` (step checks, `suggestTeamKey`, the two requests, safe `next`), `SetupView.tsx` (the three steps, progress, inline and form errors; each step is a `<form>`, so Enter advances; Esc does nothing), `SetupPage.tsx` (state and effects). Outside that folder, two small hooks: `main.tsx` renders `SetupPage` on `/setup` until the router exists, and `vite.config.ts` proxies `/setup/status` and `POST /setup` to the server in dev.
> - **Spec decisions (SPEC-001 §11):** Q4 (token format, a new one per start, the logged link), Q5 (what the guard closes: `503 SETUP_REQUIRED`, added to SPEC-003's error table), Q6 (display name and time zone at setup). §3.1 and §6.1 describe the routes; SPEC-004 §9 the CLI.
> - **Deviations:** the "prominent block" is one JSON line with a `setupUrl` field (logs are JSON). The redirect after setup goes to `/team/<key>`, the team home SPEC-005 defines; the issues page comes in M1.
> - **Tests:**
>   - `server/test/setup-routes.test.ts` (17): the guard (API, sync, auth, files and MCP `503 SETUP_REQUIRED`, also percent-encoded; pages → `/setup`; the wizard served; health, readiness, static files and status open; nothing read before ready), status, **AC-1** (no token → `403`, no cookie, the password never hashed), a complete setup (`201`, the cookie's attributes per AC-7, normalised input incl. the time zone, the app opens without another database read, `/setup` → `/`, no password or token in the logs), a second setup → `409` without hashing, the store's own `complete` answer → `409`, `Secure` only on https, and seven invalid inputs → `400` with the fix in the message. **E1** here is the route's answer only; the queueing under the row lock is `setup-store.test.ts` (the check) and the hand check (the concurrency).
>   - `server/test/setup-store.test.ts` (3), `pgSetupStore.complete` against a fake pool: a wrong token and a completed setup each roll back with no write (**AC-1**, **E1**); a connection that dies mid-transaction fails the request without ending the process, and the connection is discarded (the regression test for the crash below).
>   - `server/test/setup-token.test.ts` (10): token format and alphabet, hash and match, the link; **AC-1, unit part**: the link logged at `warn` with its stored token, `SURFACE_SETUP_TOKEN`, nothing once complete; `surface setup-token` (fresh link replaces the old; says when it overrides `SURFACE_SETUP_TOKEN`; refuses once complete). `cli.test.ts`: `setup-token` with a bad config; `config.test.ts`: `SURFACE_SETUP_TOKEN` over 128 characters.
>   - `server/test/password-hash.test.ts` (3, **AC-9**), `domain/src/auth.test.ts` (7: password length, email) and `domain/src/names.test.ts` (3).
>   - `web/test/setup-wizard.test.tsx` (34): key suggestions, the key following the name until edited, each step's checks with the server's limits, the request body, the link check (incl. a server that is starting), every answer of `POST /setup` (incl. a `//host` `next` refused), offline; the page's state (`state.ts`): steps, back, one send at a time, each answer's screen, a refused link keeping what was typed and finishing with a pasted newer one; and the screens.
>   - **Mutation-checked**, each caught: no API closure, no page redirect, the gate not marked complete, a cookie without `HttpOnly`, any token matching, the link logged at `info`, weaker argon2, no password rule.
> - **Held criteria, checked by hand** (README §6), with a temporary test against Postgres 17, not committed:
>   - **AC-2:** a fault injected before `COMMIT`, and the connection killed (`pg_terminate_backend`) before `COMMIT`, each left every table and `sync_log` as before, and the token still valid.
>   - **E1:** three concurrent setups with the right token: one `ok`, two `complete`; then exactly 1 workspace, 1 user, 1 preferences row, 1 credential, 1 team, 8 statuses, 3 labels, 1 membership, 1 session, and 16 `sync_log` rows.
>   - **AC-1 and the flow, through `startServer()`:** the link was logged; `/api` answered `503` and `/` redirected to `/setup`; a wrong token got `403`; the right one `201` with the cookie, whose SHA-256 is the session's `token_hash`. The Admin is `ada@example.com`, display name `ada`, `admin`, `Europe/Berlin`; team `ENG` defaults to Backlog; labels Bug (red), Feature (violet), Improvement (blue); preferences synced to `user:<id>`; the password is argon2id and in neither `sync_log` nor the logs; `setup_state` completed with the token cleared. Then `/api` opened and `/setup` redirected to `/`; a restart logged no link.
> - **Review fixes (2026-11-07):**
>   - `POST /setup` answers `409` and `403` before hashing: argon2 (19 MiB) ran for any request, setup done or not, wrong token or not.
>   - The guard matches the percent-decoded path, as the router does: `/%61pi/ops` reached the API before setup.
>   - Time zones: offsets (`+05:00`) are refused, and names are stored canonically (`europe/berlin` → `Europe/Berlin`), with S8's `timeZoneProblem` and `canonicalTimeZone` (`@surface/domain`) after the rebase onto it.
>   - `SURFACE_SETUP_TOKEN` is capped at 128 characters, the most the routes read (SPEC-004 §7, `docker/.env.example`).
>   - Shared rules in `@surface/domain`: `emailProblem`, and `NAME_MAX_LENGTH` with `nameProblem` (`names.ts`; workspace 64 from domain-model §4.1, team 80 as S8's `TEAM_NAME_MAX`, person 80 set here). The wizard and the server use the same ones, so errors show on the step that has the field.
>   - After the rebase onto S8 (`aea1377`): the wizard uses S8's `suggestTeamKey` from `@surface/domain` (session E's advice; the `team.suggestKey` op needs a signed-in actor), and the setup team is inserted with `NEW_TEAM_SETTINGS` like `team.create`.
>   - The wizard: a server that is starting or unreachable gets its own screen, checked again every 5 s, instead of "find the link"; a link refused on Finish keeps everything typed and asks for the newest link. The page's state moved to `state.ts` (pure, tested).
>   - Messages: `surface setup-token` and the startup line say that a CLI token overrides `SURFACE_SETUP_TOKEN` until the next start. README: `SURFACE_SETUP_TOKEN` for several containers, and no link at `LOG_LEVEL=error`. SPEC-001 AC-7 now says `Secure` on https only (as SPEC-004 §7 allows), and Q4 the multi-container case.
>   - Kept as is: the store's statements use pg's `$n` placeholders like the executor (`executor/transaction.ts`) and the migration runner, rather than Drizzle's `sql` template; `beforeCommit` stays for the held AC-2 integration test.
>   - Open: `packages/operations/src/catalog.ts`'s OpenAPI error list lacks `SETUP_REQUIRED` and `UNAVAILABLE` (no phase 2 session owns that file).
> - **Notes for later slices:**
>   - **S3:** read the session cookie back (`hashSessionToken`, `sessions.token_hash`), slide `expires_at`, add CSRF, and replace `noSignedInActor`. `/auth/capabilities` (`setupComplete`) is S3's. The session made at setup has no CSRF token yet.
>   - **C (PLAN-005 S4):** take over `/setup` as a route of the router and drop the `main.tsx` switch; the server-side guard already redirects pages.
>   - **Open, outside this slice:** other code that holds a checked-out client across awaits (`sync/bootstrap.ts` while it streams to a slow client, and the executor's transactions) has the same missing `error` listener (see store above).

### S3: Password auth, sessions, CSRF · L · ✅ Done 2026-11-07 (server; the web half went to session C)
- `@node-rs/argon2` with m = 19 MiB, t = 2, p = 1 (AC-9). Minimum password length 10.
- `POST /auth/login` with constant-time behaviour for unknown users (a dummy hash verify) (AC-5). `POST /auth/logout`.
- **Session middleware:** cookie `surface_session` (random 32 bytes; SHA-256 stored; HttpOnly, Secure when `SURFACE_URL` is https, SameSite=Lax), 30-day sliding expiry (update `last_used_at` at most every 5 min).
- **CSRF:** double-submit token (`surface_csrf` cookie plus an `X-CSRF-Token` header) on cookie-authenticated POSTs. The web client attaches it automatically.
- **Rate limiting and lockout:** 5 failures per 15 min per account and per IP, stored in Postgres (`auth_attempts`) so it survives restarts (AC-6).
- **Actor wiring:** session → `Actor` for the executor, `/sync/*`, and WebSocket auth. `hub.closeSessions()` on revoke (AC-8).
- `GET /auth/capabilities`.
- Web: login page, auth guard, `?next=` handling, 401 → redirect (E14; keeps the queue).
- **Tests:** AC-5 (identical body and status, timing ±50 ms), AC-6, AC-7 (cookie flags, hash-only storage), AC-8, AC-9.

> **As built (2026-11-07).**
> - **Split by the user's decision:** session A built the server half; the login page, the auth guard, `?next=`, the redirect on `401` (E14) and sending the CSRF header are session C's (handoff in session-a2), on the server API below.
> - **Migration** `0008_auth_attempts` (A holds the lock): `auth_attempts (id identity, key, attempted_at)`, indexed on `(key, attempted_at)` and on `attempted_at` (the prune). Server-only. No new dependency.
> - **Structure (`apps/server/src/auth/`):**
>   - `store.ts` (`pgAuthStore`, behind `AuthStore`): credentials of an active user; the session by token hash with, in one query, the user's role, the workspace id and every team membership with its privacy; `touch` (sliding expiry); `deleteSession`.
>   - `sessions.ts`: `SessionAuth` reads the cookie once per request (memoised in a `WeakMap`), so the CSRF check, the route and the socket share one lookup. It builds the actor from the database each time: `memberOf` is every team, `groups` adds private teams (`syncGroupsFor`), so membership and role changes apply to the next request (session E's handoff). It extends the session when `last_used_at` is 5 minutes old or more. Its `resolveActor` and `sessionIdOf` are now the server's defaults (`startServer` still takes a `resolveActor` for tests).
>   - `routes.ts`: `POST /auth/login`, `POST /auth/logout`, `GET /auth/session` (new, SPEC-001 Q9, for session C), `GET /auth/capabilities` (open before setup), and the CSRF `onRequest` hook, registered after the setup guard. A CSRF refusal is `403 CSRF_INVALID` (added to SPEC-003's list), so clients refresh the token instead of retrying (session D's request: the sync client retries any `403` from mutate).
>   - `attempts.ts`: the lockout policy as a pure function (`lockedForSeconds`) and `pgAttemptStore`, which reserves an attempt before the password check and prunes rows older than the window whenever it does (no job); see "Review fixes".
>   - `csrf.ts`: the token is HMAC-SHA256(`SESSION_SECRET`, session id), so nothing is stored (Q7). `session.ts` gained `readCookie` and `clearedCookie` (no cookie plugin).
>   - Setup (S2) now sets the CSRF cookie with its session.
> - **Spec decisions (SPEC-001 §11, approved by the user 2026-11-07):** Q7 (CSRF token), Q8 (what the lockout counts), Q9 (`GET /auth/session`), Q10 (sign-in refuses another `Origin`). §6.1 describes the routes and the CSRF rule.
> - **Deviations:** none from the spec. From the plan: sign-out is the only revocation so far; `session.revoke`/`revokeOthers` and password changes (later slices) should delete the rows and call the hub's `closeSessions`, as `POST /auth/logout` does.
> - **Tests:**
>   - `server/test/auth-routes.test.ts` (20 at first; see "Review fixes" for what was added), against fake stores with the real argon2id: sign-in with the cookies' attributes and only the hash stored (**AC-7**); a wrong password and an unknown email answered alike after one argon2id verify each with the same parameters (**AC-5**); E2; the lockout for an account and for an address, its end, guesses while locked not counted, success clearing the account (**AC-6**, E13); login CSRF by `Origin`; `400`; no password or token in the logs; `GET /auth/session`; the actor from every membership, read per request; sliding expiry; an expired session (E14); CSRF refused without the token, with a forged one or another session's, and not needed to read; sign-out ending the session and closing its sockets (**AC-8**, unit part), and needing the token; capabilities.
>   - `server/test/auth-attempts.test.ts` (4): the lockout window. `setup-routes.test.ts`: both cookies at setup.
>   - **Mutation-checked**, each caught (15): no dummy verify, no lockout check, failures not recorded, no address key, the account not cleared, no CSRF check, no `Origin` check, sign-out keeping sockets or the session, the email not normalised, touching every request or never, `memberOf` without public teams, an `HttpOnly` CSRF cookie, the lockout off by one.
> - **Held criteria, checked by hand** (README §6) with a temporary test against Postgres 17 and the real server, not committed: setup set both cookies; sign-in stored only the token's SHA-256 (30-day expiry); `GET /auth/session` gave the real user and workspace ids; `team.suggestKey` over HTTP was `403` without the CSRF header, `200` with it, `401` without a cookie; **AC-5**: medians 13.9 ms (wrong password) and 14.8 ms (unknown email) over 12 rounds, identical bodies; **AC-6**: 5 failures → `429`, still `429` after a restart, signed in once the failures were 15 minutes old; sliding expiry: a session used after 6 minutes was extended to 30 days; **AC-8**: sign-out closed the session's socket with `4001` in 9 ms, then `401`; an expired session and a deactivated user `401`; no password or token in the logs.
> - **Review fixes (2026-11-07, after `/review`; every bug test failed before its fix):**
>   - **Lockout under parallel guesses (B1):** the route checked, verified, then recorded, so guesses sent at once all passed the check. `AttemptStore` is now `reserve` (per-key `pg_advisory_xact_lock(LOCK_CLASSES.authAttempts, hashtext(key))`, keys in sorted order, read, then insert, in one transaction) before the password check, and `succeeded` (forgets the attempt and the account's failures). `LOCK_CLASSES` is new in `db/locks.ts` (two-key locks, a space apart from `LOCKS`). Checked by hand against Postgres 17: 20 concurrent attempts on one account, exactly 5 through; mixed key order, no deadlock.
>   - **CSRF and the setup guard while draining (B2):** both skipped every state but `ready`, though operations still run while draining. Both now skip only while `starting`; the auth routes answer `503` only then too.
>   - **Sliding expiry in the browser (M1):** an `onSend` hook sets both cookies again when the request extended its session (`SessionAuth.extended`), unless the response sets or clears the session itself.
>   - **Sign-out on every replica (M2):** `closeSessions` closes this replica's sockets and sends `NOTIFY session_revoked` (`notifySessionsRevoked`, 100 ids per notification); every hub's listen connection also listens on that channel. Checked by hand through real `LISTEN`/`NOTIFY`. Limit: a replica whose listen connection is down at that moment misses it, and those sockets stay open until they disconnect.
>   - **Tests of the real code (M3):** `auth-store.test.ts` (`createSession` stores only the hash; `pgAuthStore`'s filters and writes, on a recording client); `auth-socket.test.ts` (a real socket, the real `SessionAuth`, sign-out → `4001` for that session only).
>   - **Smaller:** the domain's `userActor` instead of a copy; `auth.login` and `auth.login_failed` log events (`reason: incorrect | locked`, the user id when the account exists, never the email); `auth_attempts_attempted_at_idx` for the prune (migration `0008` regenerated, not yet committed); signing in again ends the browser's previous session; IPv6 counted by /64; `normaliseEmail` in `@surface/domain` (setup and sign-in); the password bound is `PASSWORD_MAX_LENGTH * 2` UTF-16 units; `no-store` on sign-out; `noSignedInActor` removed. Not taken: the `__Host-` cookie prefix (it needs https, so names would differ between http and https installs).
>   - **Shared names:** `CSRF_HEADER`, `CSRF_COOKIE`, `CSRF_INVALID` and `SESSION_PATH` now come from `@surface/sync-protocol` (session D's `p002-s8b-csrf`), so client and server use one source.
>   - **Mutation-checked**, each caught (12): the socket wiring forgetting the session, the raw token stored, locks unsorted, no per-key lock, the hub or the listener ignoring revocations, the refresh overriding sign-out, no refresh, the previous session kept, IPv6 by full address, the setup guard off while draining, success forgetting nothing.
> - **Second review fixes (2026-11-07):**
>   - **Private-team leak test (M1):** `session-groups-leak.int.test.ts` (Postgres; leak tests aren't held) resolves real sessions through `pgAuthStore` and `SessionAuth` and bootstraps with them: a member of public ENG and an Admin outside private SEC get no `team:SEC` group and none of SEC's rows; SEC's member gets both. Mutation-checked: memberships of every user, every team treated as private (both caught).
>   - **Address limit 20 (M2, the user's decision on Q8):** `LOCKOUT.maxAddressFailures`; the account stays at 5.
>   - **Shutdown before ready (m1):** `Lifecycle.everReady`. The setup guard, the CSRF hook, the setup and auth routes and `signedIn` (`http/ops.ts`) answer `503` until startup has finished, even if draining began meanwhile, and keep working while draining after it.
>   - **Workers notify too (m2):** `sessionCloser` (`sync/hub-source.ts`) closes local sockets if the replica has a hub and always sends the `NOTIFY`.
>   - **Docs (m3, m4):** SPEC-002 E10 and sync-protocol.md §4.3 describe `session_revoked`; SPEC-001 Q11 (approved) covers signing in again; the C handoff checks `GET /auth/session` on `4001`.
>   - **Tests (m5, nits):** capabilities before setup (`setup-routes.test.ts`, setup and auth routes together); `no-store` whenever the session cookie is sent again; the email bound is `EMAIL_MAX_LENGTH * 2`; the server's copy of the domain's `userActor` test removed.
> - **Notes for later slices:**
>   - **C (login page, guard):** send `X-CSRF-Token` from the `surface_csrf` cookie on every POST (operations, `/sync/mutate`, logout); on `403 CSRF_INVALID` call `GET /auth/session` (it sets the cookie again) and resend once, in C's own wrapper for `/api/ops` and logout only: the sync client already does it for `/sync/mutate` (D's `queue.ts`), so it gets a plain `fetch` (one retry per request, never nested); call `GET /auth/session` at start; on `401` go to `/login?next=…` keeping the queue (E14); on a socket closed with `4001` call `GET /auth/session` first and reconnect if someone is still signed in (signing in again in another tab, Q11), else go to `/login?next=…` (E10); accept only a same-origin path in `next` (`/…`, not `//…` or a URL); on `429` show the message as is; when `GET /auth/capabilities` says `setupComplete: false`, go to `/setup`.
>   - **S4–S6 (session E):** a new session (magic link, invite) is `store.createSession` plus both cookies, as in `routes.ts`; revoking sessions should delete them and call `closeSessions`, which reaches every replica. Handlers get it as `ctx.closeSessions`, with the session id on the actor (built in the follow-up below).
>   - **S5 (PLAN-002):** `POST /sync/mutate` is covered by the CSRF hook as it is; it gets the actor from `resolveActor`.
>
> **Follow-up after S3 (2026-11-07, `p001-s3-followup`).** Session E's two handoffs, the error list, and two fixes from session C's check of the web half against the real server.
> - **Email wiring** (`jobs/email.ts`, `jobs/index.ts`, `server.ts`): `startJobs` takes `work` and `mail`. The `all` and `worker` roles run the jobs and, with SMTP configured, the email worker (`startEmailWorker`). With SMTP, the `web` role starts pg-boss only to queue: `createEmailQueue`, no maintenance (`supervise: false`), no cron (`schedule: false`). Without SMTP it starts nothing, as before. `registerJobs(boss, options)` holds what each role sets up, unit-tested against a stand-in.
>   - `EmailOutbox` (`emailOutbox({ enabled, sessionSecret, sender })`): `enqueue(client, email)` queues on the caller's transaction through E's `enqueueEmail` and resolves to `true`; without SMTP it queues nothing and resolves to `false`. Routes get it as `deps.email` (`AuthDeps.email`) with `deps.withTransaction(fn)` (`transactionRunner`, the executor's `inTransaction`: one connection, `READ COMMITTED`, retried on serialization failures) so their writes and the email commit together; handlers get `ctx.enqueueEmail(email)`. Both throw for an address the email schema refuses (see E's AC-5 note).
>   - Checked by hand against Postgres and real pg-boss (scratch test, deleted): the `web` role's queue has no schedules; a rolled-back enqueue leaves no job; a committed one appears only after the commit, stays `created` (no worker in that role) and holds neither the address nor the link.
> - **Ending sessions from handlers** (`executor/context.ts`, `execute.ts`, `auth/store.ts`): `ctx.closeSessions(userId, which)` with `which` = `{ all: true }`, `{ except: id }` or `{ only: id }`, always explicit, so an actor without a session id can't turn "all but mine" into "all". It deletes the rows on the operation's transaction (`deleteUserSessions`, only `userId`'s own; ids compared as text, so a malformed or foreign id ends nothing) and resolves to the count. The executor closes their sockets through `sessionCloser` (every replica) only after the commit, and only for the attempt that committed. `Actor.sessionId` (domain `userActor({ sessionId })`, set by `SessionAuth`; never on API or MCP actors) is the session to keep for "Revoke all others" and a password change. `deleteUserSessions` checked by hand against Postgres (scratch test, deleted): only, except, someone else's, malformed, rolled back.
> - **Error list** (`packages/operations/src/catalog.ts`): the OpenAPI `Error` response lists `INVALID_REQUEST` 400 (Fastify's own refusals; also 413, 415), `CSRF_INVALID` 403, `SETUP_REQUIRED` 503 and `UNAVAILABLE` 503 next to the executor's codes; `http/errors.ts` `ROUTE_ERROR_STATUS` holds the routes' codes, the routes take their statuses from it, and a test checks the description lists every code with its status. SPEC-003 §9 already lists them.
> - **Signing in again signed every tab out** (C's check on `7863ebc`; fixed test first, both tests failed before the fix): the other tabs got `4001` and rechecked `GET /auth/session` with the old cookie before the browser stored the new one, and that `401` cleared the cookies, the new session's included. Now the `401` leaves the cookies alone, and the replaced session's sockets close on the response's `close` event, after the sign-in response has gone out (checked by hand over real HTTP with keep-alive). If the connection dropped before the listener was attached (during the password check), they close at once (review M1). SPEC-001 §6.1 and Q11 say so; the `401` change is approved by the user. Still possible and accepted: a request on the old cookie that extends the session (at most once every 5 minutes) sends the old token back; C's client already gives a `401` after `4001` a second look, which covers it.
> - **The dev server refused the web app** (C's check against `pnpm dev`): the sync registry counted `DebugItem` outside production, so the schema hash never matched the web client's `PRODUCTION_MODELS`. Fixtures are now synced only when a test asks: `startServer(config, { syncFixtures: true })` (session D's real-server entry), in every environment (`serverSyncRegistry`). SPEC-002 §4.5 and Q8 changed, approved by the user. Internal operations still run outside production; the hub skips `DebugItem` rows it doesn't sync.
> - **Docs:** `sync-react` (PLAN-002 S10, ADR-0017) listed in CLAUDE.md and architecture.md §3 (D's handoff). E's SPEC-004 `SMTP_URL` row reviewed against `mail/smtp.ts` and `config.ts`; it matches, unchanged.
> - **Tests:** `executor-context.test.ts` (6 at first; the review fixes add a failing socket close and `transactionRunner`: the delete in the transaction keeping the caller's session, sockets closed after commit only, nothing on failure, the committed attempt only on retry, none when nothing matched, the email on the operation's connection, `false` without SMTP); `jobs-email.test.ts` (6: each role's queues and workers, the outbox); `auth-routes.test.ts` (the actor's own session; closes after the response; a `401` sets no cookie); `auth-store.test.ts` (`deleteUserSessions`); `executor-unit.test.ts` (every code in the `Error` response); `sync-registry.test.ts` (fixtures only on request); domain `permissions.test.ts` (`sessionId`, never via a key). Mutation-checked (each caught): closing before commit, ended sessions kept across attempts, no session id on the actor, enqueuing on another connection, workers in the `web` role, the outbox ignoring `enabled`, fixtures on by default.
> - **Review fixes (2026-11-07, `/review` of the follow-up):** a sign-in dropped during the password check closed nothing, since `close` had fired before the listener (M1; test first, it failed); routes had no transaction for `deps.email` (M2: `withTransaction`); `INVALID_REQUEST` in the error list and statuses from `ROUTE_ERROR_STATUS` (m1); SPEC-003 §6 lists `enqueueEmail` and `closeSessions` (m2); explicit `SessionSelection` (m3); SPEC-001's `401` change marked proposed (m4), then approved by the user; handoff rows to D and C (m5); `enqueueEmail` documents its throw (m6); the held `session-delete.int.test.ts` row (m7); nits: the email queue created once, `JobSetup` without `databaseUrl`, `emailPollingIntervalSeconds`, a failing socket close after commit logged instead of answering 500 (tested), `serverSyncRegistry` moved to `sync/registry.ts`. Kept: `executor-context.test.ts` asserts the exact statements, since that is what shows the delete ran between `BEGIN` and `COMMIT`.
> - **For session E:** `/auth/magic-link`, `/auth/forgot` and `/auth/reset` run their writes and `deps.email.enqueue(client, …)` inside `deps.withTransaction(async (client) => …)`; `/auth/reset` ends the user's sessions with `deleteUserSessions(client, userId, { all: true })` there and calls `deps.closeSessions(ids)` after it resolves, as the executor does. `user.changePassword` and `session.revokeOthers` call `ctx.closeSessions(ctx.actor.userId, { except: sessionId })`, refusing an actor without `ctx.actor.sessionId` rather than ending every session; `session.revoke` uses `{ only: id }` and answers `NOT_FOUND` on 0. `invite.create`'s `emailed` is `ctx.enqueueEmail`'s result (queued, not delivered; E7).

> **As built, web half (session C, 2026-11-07, branch `p001-s3-web-login`).**
> - **`app/http.ts`:**
>   - `csrfFetch` sends `X-CSRF-Token` from the `surface_csrf` cookie on writes, and on `403 CSRF_INVALID` gets `GET /auth/session` and resends once. It is used for `POST /auth/logout`, and later for any `/api/ops` call from the web app.
>   - `watchSession` only reports a `401` (E14). It wraps the sync client's fetch, which renews its own CSRF token (session D), so there is never a second retry.
>   - Names come from `@surface/sync-protocol` (new workspace dependency of `apps/web`).
> - **`app/auth.ts`:** `httpAuthClient` reads `{ ok, result }` from `/auth/capabilities` and `/auth/session`.
>   - `GET /auth/session`: a `401` is no session, and so is `503 SETUP_REQUIRED` (the guards send every page to `/setup` then). Anything else is "can't reach the server".
>   - Login: a refusal (`4xx`) shows the server's message as it is (AC-5's generic text, E13's "Try again in N minutes"). A `5xx` or no answer says to check the connection and try again.
>   - `AuthState.login` reads the session back, then the guards send the user on to `next` or home (`followAuth`).
>   - On a 4001 (E10) or a `401` from the sync client (E14), `AuthState.recheck(epoch)` asks `GET /auth/session`. Both go through the same check: after re-signing in elsewhere, an old-cookie request's `401` arrives alongside the 4001 (review M1).
>     - Someone signed in: the shell reopens with a new store (Q11; the snapshot's `epoch` keys the shell).
>     - Nobody: one more look after 1 s, because the signal can arrive before the browser holds the new cookie. Still nobody, and it is `/login?next=…`, the queue kept.
>     - A check is tied to the session its store was opened for (`epoch`). One from an earlier store, or answered after the session changed, does nothing. Nor does one answered while the user's own logout is in flight (logout closes this tab's socket too; a counter, as logouts can overlap).
>   - A logout whose answer is lost checks the session: gone means the logout happened (review m3).
> - **`app/session-store.ts`:** `sessionAuthHooks` (the sync client's fetch and 4001 handler, both checking their session) and `runStore` (start and close through `StoreSequence`), so `ShellRoute`'s wiring is tested (review m1).
> - **`app/stores.ts`:** `StoreSequence`, so a new session's store starts only after the previous one has closed and released its queue (SPEC-002 E5, session D's request).
> - **`pages/LoginPage.tsx`** at `/login` (no longer a `ScreenId`):
>   - email (`autocomplete=username`) and password, with a check before sending;
>   - errors in a `role=alert` line;
>   - while sending, the button shows `loading`;
>   - `LoginSubmit` holds the one-at-a-time flag outside React state (two Enters in one frame would sign in twice, and under Q11 end each other) and turns an unexpected failure into the try-again message (review m4).
>   - The magic-link button and "Forgot password?" come with S4's routes, and with them AC-3's SMTP test (both ways).
> - **Tests:** `web/test/app-http.test.ts` (7), `app-auth.test.ts` (25: the late-answer races, the second look, checks tied to their session, a lost logout, overlapping logouts), `app-stores.test.ts` (4), `session-store.test.ts` (5) and `login-page.test.tsx` (7: `next` through the real route tree, the submit flow). Mutation-checked: 11 mutants, then 11 more after the review, all caught. Web tests 297 on this branch; 341 with E's S8 web half after rebasing onto `15e589b`.
> - **Review (slice-reviewer, 0 blockers, 1 major, 4 minors, 5 nits), all fixed test-first:**
>   - M1: the 401 path skipped the Q11 check.
>   - m1: the wiring was untested.
>   - m2: the AC-3 row overstated the test.
>   - m3: a lost logout left a dead shell.
>   - m4: the submit flow was untested, with no error path.
>   - Nits: the logout counter, the submit flag, one `errorOf` in `http.ts` for both callers, a dead test branch, and this note.
> - **Checked by hand** against the real server on `7863ebc`, with Postgres 17 in a throwaway container (removed):
>   - a signed-out deep link went to `/login?next=` with the query kept;
>   - the form's own check showed, then the server's wrong-password message;
>   - a mixed-case email signed in, landing on `next` with the replica loaded;
>   - the session survived a server restart;
>   - logout sent the CSRF token (`200`, no retry) and landed on `/login` without `next`;
>   - after 5 failures the page showed "Too many sign-in attempts. Try again in 15 minutes."
> - **Found by that check, fixed by A on `p001-s3-followup`:**
>   - Re-signing in, all tabs signed out. Q11's 4001 reached the tabs before the new cookie, and their `401` cleared it. Fix: no cookies on `GET /auth/session`'s `401`, and the replaced sockets close after the response.
>   - Against `pnpm dev`, the client was always outdated: the dev registry hashed the engine fixtures. Fix: fixtures off unless a test opts in.
>   - Until `p001-s3-followup` is on main:
>     - signing in again while other tabs are open still signs them all out, as the `401` clears the new cookie;
>     - run the server with `NODE_ENV=production` to try the web app.
>   - The shell reopening after a 4001 was not seen by hand for these reasons; unit tests cover it. Check it by hand once the follow-up merges.

### S4: Mailer, magic link, password reset · M · ✅ Done 2026-11-07
- Mailer service (Nodemailer, from `SMTP_URL`). Sending happens **via the outbox and a job** (`email.send`), never inside request transactions. Plain HTML templates plus text alternatives (magic link, reset, invite).
- `POST /auth/magic-link` (always 200; invalidates older unused links, E9) and `GET /auth/magic` (consume, then session).
- `POST /auth/forgot`, `POST /auth/reset` (revokes other sessions, E10).
- `user.createResetLink` op (🛡) and `surface reset-password <email>` CLI.
- Web: forgot, reset, check-email pages. Magic-link and forgot options are hidden when `smtp=false`.
- **Tests:** AC-3 (no-SMTP path), AC-4 (with a **Mailpit** container in CI: read the emails via its API and follow the links).

> **As built, mailer half (2026-11-07).** Built ahead of S3 at the user's request. The routes (`/auth/magic-link`, `/auth/magic`, `/auth/forgot`, `/auth/reset`), `user.createResetLink`, the CLI and the web pages come once S3 is on `main`. The slice gets its ✅ only then.
> - **Structure** (`apps/server/src/mail/`): `smtp.ts` (mailer), `templates.ts` (magic link, reset, invite: HTML and a text alternative), `links.ts` (`magicLinkUrl`, `passwordResetUrl`, `inviteUrl` on `SURFACE_URL`), `seal.ts`, `job.ts` (queue and worker).
> - **Dependency:** `nodemailer` ^10.3.1, which has no dependencies of its own and needs Node ≥ 20. ADR-0007 names it. The latest major was taken for the security fixes since 7.x, including STARTTLS hardening and a `requireTLS` fix; its changelog shows no break in the calls we make.
>   - Not `@types/nodemailer`: it depends on the AWS SES SDK (about 25 packages) to type a transport Surface never uses. `mail/nodemailer.d.ts` declares the few calls we make instead.
>   - The test SMTP server is ~150 lines on `node:net` (`test/fake-smtp.ts`), not a package.
> - **"Via the outbox", as built:**
>   - A request enqueues on **its own transaction's connection**: `enqueueEmail(boss, client, key, email)` hands pg-boss's `send` a `db` over that connection. The job commits or rolls back with the request, and the SMTP conversation happens only in the worker.
>   - `client` is a `pg.PoolClient`, never the pool: on the pool the job would commit at once, whatever the request does.
>   - `event_outbox` is not used. Its rows are a public event contract (webhooks), and an email job carries a credential.
>   - The queue is named `email-send` (pg-boss style, like `synclog-prune`) for ADR-0010's `email.send`.
> - **Sealed payloads:** the job data is `{ sealed }`, AES-256-GCM under a key derived from `SESSION_SECRET` (HKDF). Neither `pgboss.job` nor a backup of it holds a readable link, token or address. Changing `SESSION_SECRET` makes queued emails unreadable: they are logged and dropped.
> - **TLS rule** (SPEC-004 §7 `SMTP_URL`, updated):
>   - `smtps://` is TLS from the first byte.
>   - `smtp://` with a user name *requires* STARTTLS (`requireTLS`), so a password never crosses plain SMTP.
>   - `smtp://` without credentials still upgrades whenever the server offers STARTTLS, and the server's certificate is always verified. Plain SMTP happens only with a relay that offers no STARTTLS; a relay with a self-signed certificate fails every send (retried, then logged). No opt-out in v1.
>   - Ports default to 587 and 465.
> - **Nodemailer settings:** logging off, and file and URL access off (rule 5).
> - **Retries and delivery:**
>   - `EMAIL_QUEUE_OPTIONS`: 5 retries, jittered exponential backoff from 15 s capped at 5 min (roughly 4–12 minutes in all), 120 s per attempt; settled jobs are deleted after a day.
>   - Only a 5xx refusal of a recipient (`RCPT TO`) or of the message (`DATA`) is final (`rejected`, logged as an error).
>   - Everything else throws, so pg-boss retries: a refused sender (`MAIL FROM`, usually a wrong `SMTP_FROM`), a refused login or TLS upgrade, connection trouble, timeouts and 4xx. The thrown error names only the SMTP error code, because pg-boss stores it.
>   - The last retry's failure is logged as an error ("gave up"), the others as warnings (SPEC-001 E7).
>   - Delivery is at least once, not idempotent (ADR-0010): a lost `250` reply, or an attempt that outlives the 120 s expiry, can send a duplicate.
>   - Logs carry the job id, the template, the attempt and the SMTP error fields. The link, its token and the SMTP credentials are masked even when the server quotes them back. The recipient's address can appear, since SMTP replies routinely quote it.
>   - `startEmailWorker` returns `stop()`, which calls `boss.offWork` (`boss.stop()` covers it too).
> - **For the rest of S4 and for S5:**
>   - **Wiring is session A's** (`jobs/`, `server.ts`, `executor/`; handoff):
>     - `createEmailQueue(boss)` must run at startup in every role that enqueues;
>     - `startEmailWorker(boss, { smtp, sessionSecret, log })` runs in `all`/`worker` when `config.smtp` is set;
>     - handlers and routes need a way to enqueue on the operation's connection. `HandlerContext` exposes no connection today (`ctx.query` is read helpers only), so the handoff asks for a capability such as `ctx.enqueueEmail(email)`. The `web` role then starts pg-boss for sending only.
>   - Link lifetimes in the email copy are `LINK_LIFETIME_TEXT` (15 min, 1 h, 7 days). Keep them equal to the token lifetimes S4 and S5 set.
>   - **Routes, AC-5:** `EmailJobSchema.to` is `z.email()`, which rejects some addresses a user row could hold (IDN domains, quoted local parts). `/auth/magic-link` and `/auth/forgot` must still answer generically when enqueueing fails validation, or user creation must share the same email schema. Otherwise an account with such an address answers 500, which reveals that it exists.
>   - **S5, E7:** sending is asynchronous, so `invite.create`'s `emailed` can only mean "queued". "Email failed. Copy the link instead" needs the job's outcome later, for example via `boss.getJobById` or a status on the invite. S5 decides, and amends SPEC-001 E7 if needed.
> - **Tests** (unit, fake SMTP on 127.0.0.1; 38 declared, 42 run):
>   - `mail-content.test.ts` (9, 13 run): templates, escaping, subject line breaks, nothing remote, links;
>   - `mail-seal.test.ts` (5, incl. a tamper property with a fixed seed);
>   - `mail-smtp.test.ts` (14): transport options, a multipart message from `SMTP_FROM`, no AUTH without STARTTLS, final vs retried refusals (`RCPT`, `DATA`, `MAIL FROM`, 4xx, an unreachable server), credential masking;
>   - `mail-job.test.ts` (10): enqueue on the given connection, sealed-only payload, invalid emails refused before queueing, sent, rejected, retried, error on the last retry, link masked in logged replies, unreadable, worker end to end and `stop()`.
> - **Checked by hand against real pg-boss 12.38.1 on Postgres** (scratch integration test, deleted; new integration tests are held). All four with Nodemailer 7.0.9; the first three again with 10.3.1 after the review fixes:
>   - a rolled-back enqueue leaves no job and sends nothing;
>   - a committed one is invisible to other connections until the commit, then is sent;
>   - the stored job holds neither the token nor the address;
>   - with SMTP down the job goes to `retry`, and its stored error is `SMTP send failed (ESOCKET)`.
> - AC-3 and AC-4 stay ⏸ held (e2e).

> **As built, routes, op, CLI and pages (2026-11-07, branch `p001-s4-routes`).** On S3 and A's follow-up (`ctx.enqueueEmail`, `ctx.closeSessions`, `deps.withTransaction`).
> - **Decisions:**
>   - SPEC-001 **D4** (the user's decision): the emailed link opens the page `/login/magic?token=`, which asks first and then sends `POST /auth/magic`. Not `GET /auth/magic`, which mail scanners would use up and which allows login CSRF.
>   - The page was first planned at `/auth/magic` (C's router had it), but `/auth/*` is the server's API: the server's static fallback answers it with JSON 404, and so does the dev proxy. Found in the hand check; moved to `/login/magic` by the user's decision.
>   - SPEC-001 **D5** (approved by the user, 2026-11-07): link requests answer before the lookup, a 60 s cooldown per user and kind, and a newest-only rule for reset links too.
> - **Server:**
>   - `mail/link-tokens.ts`: `issueLink` locks the user's row (`FOR NO KEY UPDATE`), applies the cooldown, deletes the earlier links and stores the SHA-256. `useLink` is one `UPDATE … WHERE used_at IS NULL AND expires_at > now`, for active users only. Also the email lookup, the workspace name and `setPasswordHash`, plus `handlerLinks`. `LINK_TTL_MS` is tested against `LINK_LIFETIME_TEXT`.
>   - `handlers/account/routes.ts`: `registerAccountRoutes` with `POST /auth/magic-link`, `/auth/forgot`, `/auth/magic` and `/auth/reset` (SPEC-001 §6.1).
>     - Link requests run their work in the background (`deps.background` for tests). An address the email schema refuses fails `emailProblem` for everyone, which settles the mailer half's AC-5 note.
>     - `/auth/magic` and `/auth/reset` check `Origin` like sign-in. They end the browser's previous session (Q11) and close sockets after the response, as sign-in does.
>     - Reset hashes before its transaction. In it: use the link, set the password, end all the user's sessions (E10), create the new session.
>   - `user.createResetLink` (`ops/account.ts`, `p.admin()`, output `{ url, expiresAt }`; no `ui` yet, it arrives with the Members screen in S7) and `handlers/account/create-reset-link.ts`.
>   - **`ctx.links.passwordReset(userId)`**, a new `HandlerContext` capability (A's executor, the user's decision): issues on the operation's transaction and builds the URL from `ExecutorDeps.publicUrl` (`server.ts` passes `config.publicUrl`). Without a `publicUrl` it throws. S5 adds `invite` there.
>   - `app.ts` registers the routes when `AuthDeps` has `email` and `withTransaction` (the user's decision; A's file, one call).
>   - `surface reset-password <email>` (`cli/reset-password.ts`) replaces B's stub, as B's note asked. `Invocation` now carries the positional `args`. `cli.test.ts` checks it refuses a bad configuration like the other commands.
> - **Web** (`features/account/`):
>   - `api.ts`: `httpAccountApi` over `csrfFetch`, because a signed-in browser sends a session cookie. A `5xx` message is never shown. `AccountApiContext` serves tests.
>   - `submit.ts`: `AccountSubmit`, one request at a time, and `newPasswordProblem`.
>   - `AccountScreens.tsx`: check-email, forgot (no SMTP: ask an Admin), reset, and the login-link page with a focused **Log in** button. Registered in `features/screens.ts`.
>   - `LoginOptions.tsx` in C's `LoginPage.tsx` (the user's decision): "Email me a login link" with SMTP, "Forgot password?" always. The spec's §3.3 keeps `/forgot` useful without SMTP, so the plan's "hidden when `smtp=false`" applies to the login link only.
>   - After a link sign-in or reset the page loads `/` again, so C's `AuthState` needed no change.
>   - C's `app-router.test.tsx` placeholder case now uses `/invite/…`, because `/forgot` has a screen. C's `app/router.tsx` and `app/screens.ts` changed `auth/magic` to `login/magic`. SPEC-005's public-route row was updated.
> - **Tests** (unit): `server/test/account-routes.test.ts` (21), `server/test/link-tokens.test.ts` (12), `web/test/account-pages.test.tsx` (18), `cli.test.ts` adjusted. `registry-contract.int.test.ts` (A's) gives its executor a `publicUrl`, so `user.createResetLink`'s example runs against Postgres there. Mutation-checked: 19 mutants, all caught (answer before lookup, E10, both `Origin` checks, the SMTP gate, cooldown, previous sessions, short password, single use, newest only, hash only, active users, CLI normalising, double submit, the SMTP-dependent UI, `5xx` text).
> - **Checked by hand** against `pnpm dev` (Postgres 17, real pg-boss) with SMTP pointed at the test fake SMTP server on 127.0.0.1 (scratch script, deleted):
>   - Magic link: one email for the account, none for a repeat within 60 s or an unknown address, all answered `200 {}`. Used once, then `401`; another `Origin` `403`.
>   - Reset: only the hash stored. The Admin's `user.createResetLink` turned off the emailed link (`401`). An expired link was `401`, then usable once its expiry was moved back. A short password `400` kept the link. Reset ended Ada's 3 sessions (old cookie `401`, new `200`) and the new password signed in.
>   - The CLI against the database: a mixed-case address found the user, an unknown one exited 1.
>   - In Chrome: the login page's two options; "Enter your email." with none typed; check-email; the emailed `/login/magic` link (Log in, then the app); an expired link's message; the reset page's mismatch message, then setting the password, which signed in.
>   - Not checked: a Member refused by `user.createResetLink` (no Member exists before S5's invites; unit-tested with `evaluatePermission`).
> - **Notes for later:**
>   - S5: add `invite` to `ctx.links`.
>   - S7: the Members ⋯ "Generate reset link" calls `user.createResetLink`. (S7 as built: it gets no `ui`; the command menu has no per-user context.)
>   - Clearing the lockout on reset is not done: reset signs in by itself.

### S5: Invites · M
- Ops `invite.create` (returns `{url, emailed}`; E3 conflict), `invite.list`, `invite.revoke`.
- `GET /invite/:token`, `POST /invite/:token/accept` (create the user, add memberships from `team_ids`, mark accepted, start a session). Handles E4 and E5.
- Invite expiry (7 days) is checked on read. An `invites.expire` cleanup job is optional.
- Web: invite modal in Settings → Members, accept-invite page.
- **Tests:** accept flow, a reused, revoked, or expired link, duplicate email, display-name collision with a suggestion.

### S6: Account settings · M
- Ops `user.me`, `user.updateProfile` (with `optimistic`), `user.changePassword` (revokes other sessions), `session.list`, `session.revoke`, `session.revokeOthers`.
- **Minimal `BlobStore`** (ADR-0014, local volume) plus `POST /files` and `GET /files/:id` for **avatars only** in M0: size ≤ 2 MB, image sniffing, square crop, thumbnails via sharp. It is generalised for attachments in M1.
- Web: Settings → Account → Profile and Security pages.
- Settings → Workspace: the **logo** (moved here from S7 on 2026-11-07: it needs this slice's `POST /files`). `workspace.update` gains `logoFileId`.
- **Tests:** AC-15 (a profile change appears live in another user's client), session revoke closes the socket (with S3).

### S7: Members (Admin) · S · ✅ Done 2026-11-07
- Ops `user.list`, `user.get`, `user.setRole` (INV-01 guard, E6), `workspace.get`, `workspace.update`.
- Web: Settings → Members (list, role menu, reset-link modal) and Settings → Workspace (name, logo).
- **Tests:** AC-10 (last-admin guard), AC-14 (Members get `FORBIDDEN` from the API, and admin routes return not-found in the UI).

> **As built (2026-11-07, session E).** Both halves. No migration, no new dependency.
> - **Ops** (`packages/operations/src/ops/member.ts`, `workspace.ts`): `user.list` (any; `listInput` with filters `role`, `active`, `name`, `displayName`, `email`, `createdAt`, sorted by name by default; deactivated users are listed, filter on `active`), `user.get` (any), `user.setRole` (🛡, optimistic role patch), `workspace.get` (any), `workspace.update` (🛡, name only). No `ui` on any of them: the command menu has no per-user context, and none of these is a command-menu action in S9's list. `user.createResetLink` keeps no `ui` either.
> - **INV-01 guard** (`packages/domain/src/members.ts`: `leavesNoAdmin`, `LAST_ADMIN_MESSAGE`, shared by the server and the web). `handlers/members/set-role.ts` locks every active Admin row (`FOR NO KEY UPDATE`) before counting. Two Admins demoting each other at once run one after the other, and the second, re-reading the locked rows under READ COMMITTED, is refused. Setting the role a user already has writes nothing. The actor's role is read when a request is signed in (`auth/sessions.ts`), and the handler also refuses an actor who is no longer among the locked Admins, so a demotion holds even against that user's request already in flight. Admin rows are locked in id order. The `active` filter matters from M7 and, like the locking SQL, is checked by hand until the held integration test. Emits `user.role_changed` and `workspace.updated` (events.md).
> - **Deviations:** (1) **The logo moved to S6**: it needs `POST /files` (ADR-0014), which S6 builds. `workspace.get` already returns `logoFileId` (null). (2) **`workspace.update` predicts nothing**, an exception to SPEC-003 §3.1 (recorded as SPEC-001 D6, with S4's `team.leave` and `team.removeMember`): the client store finds rows by id or reference, and the workspace has no reference type. Settings → Workspace waits for the server, and offline keeps the edit with a note. Handoff to D (session-e2) for a way to name a singleton's row. (3) The E6 message gained how to fix it: "Surface needs at least one Admin. Make someone else an Admin first." (SPEC-001 E6 updated).
> - **Web** (`apps/web/src/features/members/`, `features/workspace/`): Members lists active users from the store (live), with role badge, teams, join date and a role filter. Each row's ⋯ menu has a Role radio, where Member is disabled for the last Admin and the reason is shown above the list, and "Generate reset link…". Making yourself a Member asks first, then goes to Profile. The reset-link modal asks, then shows the link once. It can't be closed while the link is being generated, because the link would be made anyway and never seen. Copy is confirmed in the modal, since a toast over an open dialog waits until it closes (overlay manager), and it says when the browser can't copy (no clipboard on plain http). The link comes from `POST /api/ops/user.createResetLink` (`members/api.ts`, `csrfFetch`), not the store, because the mutation queue keeps no results and a queued link would only turn off the earlier one. Workspace: name form, the operation's own validation messages. Not-found for Members stays C's `SettingsPage` guard; C's `settings-page.test.tsx` now checks that an Admin gets the section rather than the placeholder (approved edit, coordinated with C).
> - **Tests:** `server/test/last-admin-guard.test.ts` (AC-10: the rule, a fast-check property that any allowed sequence keeps an Admin, the handler on a fake transaction (refusal, lock before read, no-op, events, a demoted actor in flight), and AC-14's permission split). `web/test/members-screens.test.tsx` covers the list model, the menu, the role-menu actions (`members/actions.ts`), the reset-link flow (one request at a time, stays open while busy, copy fallback), the HTTP client, the Workspace save outcomes (`workspace/save.ts`) and both screens. The fake transaction ignores the WHERE clause: which rows count is checked by hand. The seed fixture gained the workspace for the contract test. 13 deliberate mutations, all caught.
> - **Checked by hand** (dev stack, `e.localhost:5175`, users seeded through the repo):
>   - AC-14 over HTTP: a Member reads `user.list`, `user.get` and `workspace.get`, and gets `FORBIDDEN` for `user.setRole`, `workspace.update` and `user.createResetLink`.
>   - AC-10 in Postgres: two Admins demoted each other while a psql session held the Admin rows' lock. Both requests waited on it; one succeeded and the other got `CONFLICT`. The last Admin demoting themselves gets `CONFLICT`. The demoted user gets `FORBIDDEN` on the next request.
>   - One `sync_log` row and one event per change; none for a no-op.
>   - In Chrome: role changes from another client appear live, the last-Admin option is disabled and does nothing, self-demotion asks and then leaves Members, Workspace and Members show not-found to a Member, and the rename shows in the sidebar.

### S8: Teams · L · ✅ Done 2026-11-07
- Ops `team.suggestKey`, `team.create` (key validation, reserved keys, seeds the workflow, adds the creator as a member; client-generated ID), `team.update`, `team.join`, `team.leave`, `team.addMember`, `team.removeMember` (destructive). All mutations have `optimistic` implementations.
- The key-suggestion algorithm lives in `packages/domain` (shared, so the client suggests instantly while the user types).
- Web: create-team modal, Settings → Teams (browse with join buttons), team General and Members settings, and the team ⋯ menu join/leave. The sidebar team list comes from PLAN-005 S4.
- **Tests:** AC-11 (key rules and suggestions), AC-12 (create shows in another tab < 150 ms), AC-13 (membership changes live), E11, E12.
- **Unblocks:** PLAN-002 S10 (inspector and UI hooks; its demo e2e is held, SPEC-002 D1).

> **As built, server half (2026-11-07).** The web half is recorded below.
> - **Versions:** no new packages.
> - **Domain (`packages/domain`):**
>   - `team-key.ts`: `suggestTeamKey(name, isTaken)` and `teamKeyCandidates(name)`. Initials of up to 3 words, or the first 3 letters of one word, A–Z only (accents dropped). On a collision or reserved key it grows from the name a letter at a time (`ENG` → `ENGI` → `ENGIN`; `MP` → `MPL` …), then tries the name's first letters. `undefined` when nothing fits (the user picks).
>   - `team.ts`: `NEW_TEAM_SETTINGS` (equal to the `teams` column defaults; a server test keeps them so) and `canEndMembership(team, memberCount)` (E12, D3).
>   - `workspace.ts`: `timeZoneProblem(zone)` accepts `UTC` or `Area/Location` names, in any case, that Intl knows. ICU also accepts legacy ids (`PST`, `EST5EDT`) and offsets, which are rejected; this was found while hand-checking, test first. `canonicalTimeZone(zone)` gives one spelling per zone (`europe/berlin` → `Europe/Berlin`). The reserved-key message no longer suggests a key it hasn't checked.
> - **Operations (`packages/operations/src/ops/team.ts`):**
>   - The ops: `team.suggestKey`, `team.create`, `team.update`, `team.join`, `team.leave`, `team.addMember`, `team.removeMember` (`destructive`).
>   - Inputs: names are trimmed and keys trimmed and uppercased. Time zones are checked, then stored canonically. `team.create`'s `id` must be a UUIDv7 (SPEC-003 §8).
>   - **Key rules live in the handler**, not the input schema, so a malformed, reserved or taken key each gets the next free suggestion for the name (E11, AC-11).
>   - Permissions per permissions.md §3.2: `p.admin() || p.teamMember(team)` for settings and membership, `p.any()` to create, join or leave. **Leave is `p.any()`** (review), so a leave replayed after someone removed you succeeds, and leaving a team you're not in changes nothing.
>   - The registry lists `team.leave` before `team.join`, so the examples leave the seed's actor a member of ENG.
> - **Optimistic updates (SPEC-003 §8):**
>   - `team.create` (given an `id` and a valid `key`) shows the team with `NEW_TEAM_SETTINGS` and the creator's time zone, and the creator's membership. It does not show the statuses: they are server-computed and not simulated, and the team's `defaultStatusId` is a placeholder (the team's own id) until the server row arrives.
>   - `team.join` and `team.addMember` show the membership. `team.update` patches the given fields.
>   - **`team.leave` and `team.removeMember` have no `optimistic`:** the store finds rows by id only, and a membership is named by team and user (handoff to session D). They show once the server answers.
>   - Membership rows that only live in the overlay get a deterministic id (the XOR of team and user ids, stamped v8), so replays agree. These ids are never sent to the server; the server's row, with its own UUIDv7, replaces them.
>   - **Review change:** the first build derived persisted status and membership ids from the team id, which contradicted domain-model §1 and SPEC-003 §8 (UUIDv7, server-computed rows not simulated). It was dropped by decision of the user. Every persisted id is a UUIDv7 again.
> - **No `ui` metadata yet:** session E adds it with the web half, together with the command-menu entries in `apps/web/src/features/teams/commands.ts` (PLAN-005 S6's operation commands). This was reassigned from S9 by the user on 2026-11-07, and S9 keeps the registry lint. Adding `ui` to `team.leave` or `team.removeMember` needs `optimistic` (lint rule 3), so it waits for session D's store lookup.
> - **Server (`apps/server/src/handlers/teams/`):** one file per op, plus `shared.ts`.
>   - **Create:** `team.create` reads every key (private and archived teams included: keys are unique) and checks the key with `keyProblem`:
>     - malformed or reserved keys: `INVALID_INPUT`;
>     - taken keys: `CONFLICT`, including a concurrent create's `teams_key_idx` violation.
>     
>     Each answer carries the next suggestion (message and `hint`) and never names the team that has the key (D2). It then inserts the team with `NEW_TEAM_SETTINGS` (time zone defaulting to the creator's), seeds the workflow (`seed.ts`, random ids as in S1), emits `team.created`, and adds the creator.
>   - **Membership changes** lock the team row `FOR NO KEY UPDATE` before reading, so concurrent joins or leaves serialize and stay idempotent (review: they had surfaced a primary-key conflict or an internal id). Join, add and remove change nothing when there is nothing to change.
>   - A private team keeps its last member (`canEndMembership`; SPEC-001 E12 and D3).
>   - `team.update` writes and reports only fields that differ (`team.updated` with `changes`). Membership changes emit `team.member_added` / `team.member_removed` with `data.userId`.
> - **Spec and domain docs:**
>   - SPEC-001 §6.2 (inputs, idempotency), E11 and E12, and new decisions **D2** (a private team's key existence is visible to non-members; the rule-4 exception, also recorded in permissions.md §5) and **D3** (a private team keeps its last member), both confirmed by the user.
> - **Test fixtures (session A's files):** `test/seed.ts` (the examples' seed fixture) now holds the actor Ada (Admin, member of ENG), ENG with its workflow, and Iris. They are seeded once per database, so `registry-contract.int.test.ts` runs every team example through the real handlers.
> - **Tests:**
>   - `domain/src/team-key.test.ts` (9, AC-11 suggestions): the algorithm's cases, accents and symbols, reserved and taken keys, no suggestion. fast-check properties: only free, valid keys made of the name's letters, always the first free candidate.
>   - `domain/src/team.test.ts` (7): `canEndMembership` (E12); time zones (IANA in any case, legacy ids and offsets rejected, canonical spelling).
>   - `operations/src/ops/team.test.ts` (13): input trimming and canonical zones, UUIDv7 ids, `destructive`. Each optimistic update runs against a fake store whose rows must pass the shared client models: create shows the team and my membership but no statuses, is the same on replay, and predicts nothing without an id or a valid key; join adds once; add; update. Leave and remove have no prediction.
>   - `server/test/team-handlers.test.ts` (8, AC-11, E11): `NEW_TEAM_SETTINGS` equals the column defaults; `keyProblem` for free, taken, malformed and reserved keys, each with the next suggestion and never the rejected key; unique-violation detection.
>   - `server/test/team-ops-leak.int.test.ts` (8, **leak test, not held**):
>     - A non-member Member *and* a non-member Admin call `team.update/join/leave/addMember/removeMember` on private SEC, by key and by id. Each answers exactly like an unknown team and writes nothing to `sync_log`.
>     - `team.create` with key SEC says only that the key is taken (D2). `team.suggestKey` skips SEC.
>     - A SEC member's update and add succeed (the control).
>     - Mutation-checked: with SEC visible to the Member, and separately to the Admin, the 5 op tests fail.
> - **Held criteria, checked by hand** (temporary tests against Postgres 17, not committed):
>   - **Create:**
>     - Without a key: suggested `DO`, the creator's time zone, `team.created` then `team.member_added`.
>     - Bad keys: a taken key, a lowercase taken key, a malformed key and a reserved key each answered with the next suggestion; a name with no key gives `INVALID_INPUT`.
>     - A duplicate id gives `CONFLICT`; a v4 id gives `INVALID_INPUT`.
>     - Two concurrent creates with one key: one succeeds, the other gets the taken-key `CONFLICT`.
>   - **Time zones:** `europe/berlin` is stored as `Europe/Berlin`; `PST` is rejected.
>   - **Membership:**
>     - 3 concurrent joins: all succeed, one row. Then 3 concurrent leaves: all succeed.
>     - Leaving as a non-member succeeds and changes nothing.
>     - The last member leaves a public team: the team stays, and another user joins.
>     - The last member of SEC leaving or being removed gets `CONFLICT`; leaving works once someone else is added.
>     - Removing a non-member changes nothing.
>     - The system actor joining gets `FORBIDDEN`.
>   - **Update:** a no-op update makes no write and no event; updates by a member and by a non-member Admin both succeed.
>   - AC-12 and AC-13 (changes appearing live in other clients) stay held: they need the web client.
> - **Verified:** see the session log row "review fixed" for the commands and counts.
> - **Notes for later slices:**
>   - **Web half (E, after PLAN-005 S4):**
>     - The modal suggests a key with `suggestTeamKey(name, key => the store has it)` while the user types, and checks it with `teamKeyProblem`.
>     - It dispatches `team.create` with a fresh UUIDv7 `id` and the `key`, so the team and my membership appear at once.
>     - A `key` error carries the next suggestion in its message and `hint`; the client can compute it itself.
>   - **S3 (auth, A):** `actor.memberOf` must be read per request; `team.update`, `addMember` and `removeMember` check it.
>   - **M7 (private teams):** Admins can't see private teams yet (permissions.md §3.2 says "metadata only"). The leak test pins today's behaviour (`NOT_FOUND`). D3 should be revisited then.


> **As built, web half (2026-11-07).** Built on C's PLAN-005 S4 shell and its feature hosts (`f6d5030`, `features/hosts.ts`). Three hooks connect the feature to the shell: `TeamsHost` in `SHELL_HOSTS` answers the `form:create-team` command (command menu and the sidebar "+") with the create-team dialog, offered only once the replica is ready and someone is signed in (`canCreateTeam`); `TEAM_MENU = TeamMenu` (the ⋯ menu in the team page header); and `ui` on `team.create` (`Create team…`, `contexts: ['global']`, entry `opens: 'form:create-team'`).
> - **Versions:** no new packages.
> - **Domain:** `teamKeyIssue(key, name, isTaken)` in `team-key.ts` gives the key problem (`invalid` or `taken`) and the next suggestion in the server's exact words. The server's `keyProblem` now wraps it, so the dialog's inline error and the server's refusal read the same (AC-11, E11).
> - **Operations:** `team.create` has `ui` and opens the form (above). `team.join` has `ui` (`Join team`, `contexts: ['team']`), with a `run` in `features/teams/commands.ts` that joins the targeted team. `team.leave` and `team.removeMember` still have no `ui`: lint rule 3 needs `optimistic`, which waits for session D's store lookup.
> - **Domain:** `uuidv7(now?, random?)` in `uuid.ts`, a client UUIDv7 for create ops (`team.create`'s `id`), moved from the feature after review since every create op will need one. The server keeps its own monotonic generator (`apps/server/src/db/uuidv7.ts`, A's).
> - **Web (`apps/web/src/features/teams/`):** pure read models and forms, tested without a DOM, and thin components over them.
>   - `model.ts` (row types extend the shell's in `app/workspace.ts`): `browseTeams` (every visible team by name, member count, my membership), `teamMembers`, `addableUsers` (active non-members), `teamAccess` (edit and manage members, from the ops' own `permission` functions, so the UI can't drift from the server), `canEndMembershipOf` (E12, D3), `memberCountText`.
>   - `create-team.ts`: the create form. The key is suggested as the name is typed (`suggestTeamKey` against the keys in the store, archived teams included) until the user edits it; clearing it resumes suggesting. Problems are checked inline in the server's words; a server refusal of the key lands on the key field (`placeServerError`), and a key refused as taken (a private team's, D2) counts as taken for the rest of that opening (`withRefusedKey`), so it isn't suggested again.
>   - `team-settings.ts`: General's form keeps only the fields the user edited, over the live saved values (`withEdits`), and `teamSettingsChanges` sends only those. A field another member changes meanwhile shows their value and is never overwritten. (Review fix: the first build copied every field into the draft on the first keystroke, so Save reverted concurrent changes.)
>   - `submit.ts`: `submitMutation` waits for the server's answer while online, and stops waiting (`queued`) when the connection drops meanwhile: the outcome only settles on the server's answer, so the button would otherwise spin until reconnect (review fix). A change the store didn't take at all is `failed`; buttons with no form toast it (`toastIfFailed`), since the shell only toasts server refusals.
>   - Create dialog (`CreateTeamDialog.tsx`, `useCreateTeamDialog`): a refusal shows inline; success navigates to `/team/$key`; offline it closes and the team shows optimistically. Cancel is disabled while waiting, and an answer that arrives after the dialog was closed is ignored (no jump to the team). Each opening mounts a fresh form, so its defaults (the creator's time zone, taken keys) come from the replica as it is then: hosts mount before it is ready.
>   - Screens, registered in `features/screens.ts`: `TeamsScreen` (Settings → Teams: Join or Leave per team; Create team runs the shell's `form:create-team`, so it is enabled only when `TeamsHost` offers it; empty and loading states), `TeamGeneralScreen` (editable for members and Admins; read-only with a note otherwise, the color as a static swatch rather than an inert picker; the key is read-only), `TeamMembersScreen` (Add member menu; Remove with a confirmation; Leave as below). Both team screens share `TeamSettingsLayout`, which shows not-found for a team the user can't see (permissions.md §5).
>   - `TeamMenu.tsx`: Join or Leave team, and Team settings (`teamMenuItems`, a plain function so tests can read the items: Radix menus don't render server-side).
>   - `useLeaveTeam.tsx`: leaving works the same from Settings → Teams, the ⋯ menu and Members. A private team asks first (only a member can add you back); a public team is one click to rejoin, so it doesn't.
>   - For the last member of a private team (E12, D3), Leave and Remove are disabled and the reason is visible text the button points to (`aria-describedby`), since a disabled button takes no focus; menu items have no description, so the ⋯ menu's label says it ("Leave team (add a member first)"). Joins and adds show at once; leaves and removes show when the server confirms them (no `optimistic`, see above).
>   - "Join team" in the command menu is listed on every team page, because an operation entry has no `when` of its own yet (handoff to C). On a team the user is in, it says "You're already a member of ENG." instead of doing nothing.
> - **Not unit-testable without a DOM** (server rendering runs no effects, and Radix portals and menus render nothing): the dialog's fresh form per opening, ignoring a late answer, and the leave confirmation. Check them by hand (below).
> - **Known issue:** a refused `team.create` shows both the shell's rejection toast (`ShellRoute`'s `onRejected`) and the dialog's inline error. The rejection doesn't say who dispatched it, so the fix is a per-dispatch flag on D's `dispatch`; C logged it as a PLAN-005 S7 follow-up with D (2026-11-07).
> - **Found in self-review, test first:** the dialog left archived teams out of the taken keys, so it could suggest a key the server refuses. `createTeamContext` now counts them (mutation-checked).
> - **Tests (unit, no DOM):**
>   - `domain/src/team-key.test.ts` (+4, 13): `teamKeyIssue` for free, taken, malformed and reserved keys, with the server's wording and suggestion.
>   - `web/test/teams-model.test.ts` (7): browse, archived rows, members, addable users, `teamAccess` for members, Admins, non-members and no actor, `canEndMembershipOf` (E12).
>   - `domain/src/uuid.test.ts` (2): UUIDv7 that Zod's v7 check accepts, ordered by time, version and variant bits.
>   - `web/test/teams-forms.test.ts` (21, AC-11 and E11 unit parts): key suggestion while typing, a typed key kept, archived keys taken, the default time zone, inline problems in the server's words, every `teamKeyIssue` message placed on the key field, a refused key not suggested again, the team being created not counted as taken, nothing unsaved once submitted, a `team.create` input the op accepts; General sends only edited fields and keeps another member's concurrent change; `submitMutation` online, offline, on a connection drop while waiting (`queued`) and on a store failure (`failed`).
>   - `web/test/teams-commands.test.ts` (3): Join team dispatches for the focused team, says so on a team the user is in, and toasts a store failure.
>   - `web/test/teams-screens.test.tsx` (15, server-rendered with a fake store; every "not disabled" check first requires exactly one such button): Settings → Teams lists teams with counts and Join or Leave; Leave disabled on a private team's last member with the visible reason it points to (E12); Create team enabled only while the command is available; loading and empty states; General editable for a member and an Admin, read-only with a swatch for a non-member, not found for an invisible team; Members lists members with Add member, Remove and Leave for a member, Leave disabled with the visible reason on a private team's last member, no controls for a non-member; the ⋯ menu renders only for a visible team and its items (Join, Leave, blocked Leave with its reason); `SHELL_HOSTS` holds `TeamsHost`, `TEAM_MENU` is `TeamMenu`, and `canCreateTeam` needs a ready replica and a session.
> - **Held, not checked by hand:** AC-12 and AC-13 (changes live in another tab) are e2e and held. The screens have not been clicked through: S3's server is on `main`, but the web sign-in page is session C's (S3's web half). **To do (E, tracked in the session file):** once it lands, check by hand the create dialog's defaults and late answers, the leave confirmation, and General with two clients editing.
> - **Hand-checked (2026-11-07, on `5b1fd3b`, Chrome against `pnpm dev` with `NODE_ENV=production`):** setup, then sign-in. The create dialog opens from the sidebar "+" with the creator's time zone (not UTC) and knows taken keys (`Engineering` suggests `ENGI`). The team ⋯ menu is in the team header. Settings → Teams lists teams with Join or Leave, and the created team shows at once (optimistic). General shows the form with Save and Discard disabled until an edit.
>   - **Blocked:** the server has no `POST /sync/mutate` yet (PLAN-002 S5, A): it answers 404, and the client retries with backoff, so no web change is confirmed. Navigating to a created team, the leave confirmation, saving General with two clients and the late-answer path wait for S5.
>   - **Found and fixed** (`p001-s8-fix-create-dialog`, test first, rechecked in Chrome): (1) while `team.create` waited, the dialog's own optimistic team made its key count as taken ("Team key PLA is taken. Try PLAT"): `createTeamContext` now leaves out the team being created (`creatingId`); (2) Escape while waiting asked "Discard changes? Your unsaved changes will be lost." although the team was queued and would be created: once submitted the form has nothing unsaved (`hasUnsavedChanges`), so it closes at once; unsubmitted typing still asks.
> - **Verified:** see the session log row "review fixed" for the commands and counts.

### S9: Hardening & lint · S
- Registry lint passes for every SPEC-001 op (AC-16): summaries, keywords, examples, and `ui` metadata for command-menu use ("Create team", "Invite member…", "Rename team…", "Join team…").
- Log events for the M7 audit log: `auth.*`, `user.*`.
- ~~Install smoke (PLAN-004 S8) is enabled with a full setup and first team.~~ Held with PLAN-004 S8 (SPEC-004 D4).
- A security review of the auth slice (checklist: enumeration, timing, CSRF, cookie flags, token single-use, rate limits, log redaction).

## 2. Modules touched
`packages/domain/models/*`, `packages/domain/team-key.ts`, `packages/operations/{workspace,user,session,invite,team}/*`, `apps/server/src/{auth,mail,files,setup}/*`, handlers for the ops above, migrations, `apps/web/src/routes/{setup,login,forgot,reset,invite,settings}/*`, `e2e/auth-*.spec.ts`, `e2e/teams-*.spec.ts`.

## 3. Migration & rollback
Additive tables only. A rollback before any release is a code revert. After a release, tables are kept (forward-only policy).

## 4. Test plan (AC → test)

> ⏸ **Tests that need a browser, a running stack or Postgres are held** since 2026-11-06 (SPEC-001 D1, [plans README §6](README.md#6-testing-hold-e2e-smoke-and-integration)): rows marked held get no test for now, and the markers override the slices' "Tests:" bullets. Unit and property tests in the same row are still written, and so are the sync property suite and private-team leak tests.

| AC | Test |
|---|---|
| AC-1 | `server/test/setup-token.test.ts` (the link is logged, matches the stored hash) + `server/test/setup-routes.test.ts` "without the setup token cannot complete" + `server/test/setup-store.test.ts` "refuses a token that is not the current one" (unit parts, S2) + ⏸ held (e2e) `e2e/setup-token.spec.ts` (checked by hand in S2) |
| AC-2 | ⏸ held (integration) `server/test/setup-atomic.int.test.ts` (checked by hand in S2, with a fault and a killed connection before `COMMIT`) |
| AC-3 | ⏸ held (e2e) `e2e/no-smtp.spec.ts` (full J1 with invite and reset links). Unit parts (S4): `web/test/account-pages.test.tsx` (the login link shown with SMTP and hidden without; `/forgot` says to ask an Admin), `web/test/login-page.test.tsx`, `server/test/account-routes.test.ts` (without SMTP the link routes say what to do, looking nothing up), `server/test/link-tokens.test.ts` (`user.createResetLink` is Admin-only and returns a 1-hour link on `SURFACE_URL`; `surface reset-password`) |
| AC-4 | ⏸ held (e2e) `e2e/smtp-flows.spec.ts` (Mailpit). Unit parts (S4): `server/test/account-routes.test.ts` (each link emailed on `SURFACE_URL`, used once; reset sets the password and signs in), `web/test/account-pages.test.tsx`; magic link and reset checked by hand end to end (S4 As built) |
| AC-5 | `server/test/auth-routes.test.ts` "answers a wrong password and an unknown email alike, after the same work" (unit part, S3) + `server/test/account-routes.test.ts` "answers an account and an unknown email alike, before looking either up" (link requests, S4) + ⏸ held (integration) `server/test/login-enumeration.int.test.ts` (timing checked by hand in S3) |
| E9, E10 (S4: links, reset) | `server/test/link-tokens.test.ts` (newest link only, hash stored, single use, active users, cooldown) + `server/test/account-routes.test.ts` (an older link refused; reset ends every session and closes their sockets) + ⏸ held (integration): the SQL, checked by hand (S4) |
| AC-6 | `server/test/auth-routes.test.ts` "after 5 failures in 15 minutes refuses even the right password…" + `server/test/auth-attempts.test.ts` (unit parts, S3) + ⏸ held (integration) `server/test/login-lockout.int.test.ts` (checked by hand in S3, across a restart) |
| AC-7 | `server/test/auth-routes.test.ts` "signs in with the right password…" and "sets HttpOnly on the session cookie only…" + `server/test/setup-routes.test.ts` (unit parts) + ⏸ held (integration) `server/test/session-cookie.int.test.ts` (checked by hand in S3) |
| AC-8 | `server/test/auth-routes.test.ts` "ends the session, closes its sockets, and the next request is 401" (unit part, sign-out) + ⏸ held (e2e) `e2e/session-revoke.spec.ts` (sign-out checked by hand in S3; `session.revoke` comes with the account slice) |
| AC-8, E10 (handlers ending sessions, S3 follow-up) | `server/test/executor-context.test.ts` (deleted in the operation's transaction, sockets closed after the commit only, the committed attempt only) + `server/test/auth-store.test.ts` (`deleteUserSessions`, unit part) + ⏸ held (integration) `server/test/session-delete.int.test.ts`: only the user's own sessions end, a foreign or malformed id ends nothing (checked by hand in the follow-up) |
| AC-9 | `server/test/password-hash.test.ts` + `domain/src/auth.test.ts` (minimum length) (S2) |
| AC-10 | `server/test/last-admin-guard.test.ts` (S7: the rule, a property test over role-change sequences, the handler's lock, refusal and no-op) + `web/test/members-screens.test.tsx` (the last Admin's Member option disabled, with the reason) (+ `server/test/set-role.int.test.ts`, ⏸ held; concurrent demotions checked by hand in S7) |
| AC-11 | `domain/src/team-key.test.ts` (suggestions, `teamKeyIssue`), `server/test/team-handlers.test.ts` (malformed, reserved and taken keys, with the next suggestion), `web/test/teams-forms.test.ts` (suggested while typing, checked inline in the server's words) (+ `server/test/team-create.int.test.ts`, ⏸ held) |
| AC-12, AC-13 | ⏸ held (e2e) `e2e/teams-realtime.spec.ts` |
| E11 (S8) | `server/test/team-handlers.test.ts` (`keyProblem`), `server/test/team-ops-leak.int.test.ts` (a private team's key: taken, nothing more), `web/test/teams-forms.test.ts` (a refused key shows on the key field; archived keys are taken) |
| E12 (S8) | `domain/src/team.test.ts` (`canEndMembership`), `web/test/teams-model.test.ts`, `web/test/teams-screens.test.tsx` (Leave and Remove disabled) (+ the handler path, ⏸ held, checked by hand) |
| Private-team leak (S8) | `server/test/team-ops-leak.int.test.ts` (not held: permissions.md §5) |
| AC-14 | Unit parts (S7): `server/test/last-admin-guard.test.ts` (`user.setRole`, `workspace.update` Admin-only; reads for anyone), `server/test/link-tokens.test.ts` (`user.createResetLink`), `web/test/settings-page.test.tsx` (not-found for Members) + ⏸ held (integration + e2e) `server/test/admin-permissions.int.test.ts`, `e2e/admin-routes.spec.ts` (checked by hand in S7) |
| AC-15 | ⏸ held (e2e) `e2e/profile-realtime.spec.ts` |
| AC-16 | CI registry lint |

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| A timing side channel on login | A dummy argon2 verify for unknown emails, and a timing test with tolerance |
| SMTP variability (TLS modes, providers) | `SMTP_URL` supports `smtp://` with STARTTLS and `smtps://`. `surface doctor` tests the connection. Documented examples for common free providers. |
| Lockout abused to lock out real users (DoS) | Lockouts are per account **and** IP. Lockouts are short (15 min), and an Admin reset link always works. |
| The avatar pipeline (sharp) bloats the image or breaks arm64 builds | Prebuilt sharp binaries for both architectures are verified in CI. A fallback stores the original without a thumbnail if sharp fails. |
