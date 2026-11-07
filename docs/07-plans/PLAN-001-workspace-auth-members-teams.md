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

### S3: Password auth, sessions, CSRF · L
- `@node-rs/argon2` with m = 19 MiB, t = 2, p = 1 (AC-9). Minimum password length 10.
- `POST /auth/login` with constant-time behaviour for unknown users (a dummy hash verify) (AC-5). `POST /auth/logout`.
- **Session middleware:** cookie `surface_session` (random 32 bytes; SHA-256 stored; HttpOnly, Secure when `SURFACE_URL` is https, SameSite=Lax), 30-day sliding expiry (update `last_used_at` at most every 5 min).
- **CSRF:** double-submit token (`surface_csrf` cookie plus an `X-CSRF-Token` header) on cookie-authenticated POSTs. The web client attaches it automatically.
- **Rate limiting and lockout:** 5 failures per 15 min per account and per IP, stored in Postgres (`auth_attempts`) so it survives restarts (AC-6).
- **Actor wiring:** session → `Actor` for the executor, `/sync/*`, and WebSocket auth. `hub.closeSessions()` on revoke (AC-8).
- `GET /auth/capabilities`.
- Web: login page, auth guard, `?next=` handling, 401 → redirect (E14; keeps the queue).
- **Tests:** AC-5 (identical body and status, timing ±50 ms), AC-6, AC-7 (cookie flags, hash-only storage), AC-8, AC-9.

### S4: Mailer, magic link, password reset · M · mailer half built 2026-11-07; routes after S3
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
- **Tests:** AC-15 (a profile change appears live in another user's client), session revoke closes the socket (with S3).

### S7: Members (Admin) · S
- Ops `user.list`, `user.get`, `user.setRole` (INV-01 guard, E6), `workspace.get`, `workspace.update`.
- Web: Settings → Members (list, role menu, reset-link modal) and Settings → Workspace (name, logo).
- **Tests:** AC-10 (last-admin guard), AC-14 (Members get `FORBIDDEN` from the API, and admin routes return not-found in the UI).

### S8: Teams · L · server half built 2026-11-07; web half pending (after PLAN-005 S4)
- Ops `team.suggestKey`, `team.create` (key validation, reserved keys, seeds the workflow, adds the creator as a member; client-generated ID), `team.update`, `team.join`, `team.leave`, `team.addMember`, `team.removeMember` (destructive). All mutations have `optimistic` implementations.
- The key-suggestion algorithm lives in `packages/domain` (shared, so the client suggests instantly while the user types).
- Web: create-team modal, Settings → Teams (browse with join buttons), team General and Members settings, and the team ⋯ menu join/leave. The sidebar team list comes from PLAN-005 S4.
- **Tests:** AC-11 (key rules and suggestions), AC-12 (create shows in another tab < 150 ms), AC-13 (membership changes live), E11, E12.
- **Unblocks:** PLAN-002 S10 (inspector and UI hooks; its demo e2e is held, SPEC-002 D1).

> **As built, server half (2026-11-07).** The web half (create-team modal, Settings → Teams, team General and Members, ⋯ join/leave) starts when session C's PLAN-005 S4 shell is on `main`. The slice is done, and gets its ✅, only then.
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
| AC-3 | ⏸ held (e2e) `e2e/no-smtp.spec.ts` (full J1 with invite and reset links) |
| AC-4 | ⏸ held (e2e) `e2e/smtp-flows.spec.ts` (Mailpit) |
| AC-5 | ⏸ held (integration) `server/test/login-enumeration.int.test.ts` |
| AC-6 | ⏸ held (integration) `server/test/login-lockout.int.test.ts` |
| AC-7 | ⏸ held (integration) `server/test/session-cookie.int.test.ts` |
| AC-8 | ⏸ held (e2e) `e2e/session-revoke.spec.ts` |
| AC-9 | `server/test/password-hash.test.ts` + `domain/src/auth.test.ts` (minimum length) (S2) |
| AC-10 | `server/test/last-admin-guard.test.ts` (the guard's decision, unit) (+ `server/test/set-role.int.test.ts`, ⏸ held) |
| AC-11 | `domain/src/team-key.test.ts` (suggestions), `server/test/team-handlers.test.ts` (malformed, reserved and taken keys, with the next suggestion) (+ `server/test/team-create.int.test.ts`, ⏸ held) |
| AC-12, AC-13 | ⏸ held (e2e) `e2e/teams-realtime.spec.ts` |
| E11 (S8) | `server/test/team-handlers.test.ts` (`keyProblem`), `server/test/team-ops-leak.int.test.ts` (a private team's key: taken, nothing more) |
| E12 (S8) | `domain/src/team.test.ts` (`canEndMembership`) (+ the handler path, ⏸ held, checked by hand) |
| Private-team leak (S8) | `server/test/team-ops-leak.int.test.ts` (not held: permissions.md §5) |
| AC-14 | ⏸ held (integration + e2e) `server/test/admin-permissions.int.test.ts`, `e2e/admin-routes.spec.ts` |
| AC-15 | ⏸ held (e2e) `e2e/profile-realtime.spec.ts` |
| AC-16 | CI registry lint |

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| A timing side channel on login | A dummy argon2 verify for unknown emails, and a timing test with tolerance |
| SMTP variability (TLS modes, providers) | `SMTP_URL` supports `smtp://` with STARTTLS and `smtps://`. `surface doctor` tests the connection. Documented examples for common free providers. |
| Lockout abused to lock out real users (DoS) | Lockouts are per account **and** IP. Lockouts are short (15 min), and an Admin reset link always works. |
| The avatar pipeline (sharp) bloats the image or breaks arm64 builds | Prebuilt sharp binaries for both architectures are verified in CI. A fallback stores the original without a thumbnail if sharp fails. |
