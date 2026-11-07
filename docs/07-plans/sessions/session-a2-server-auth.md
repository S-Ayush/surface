# Session A, phase 2: Sync server, setup and auth

Worktree: `/Users/admin/Desktop/Learning/surface-a` (since PLAN-002 S4, at the user's request) · Current branch: `p001-s3-auth` · Guide: [README](README.md) §7 · Phase 1 log: [session-a-platform.md](session-a-platform.md)

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
6. ~~PLAN-001 S7: Members and Workspace (Admin).~~ **Moved to session E** (the user's decision, 2026-11-07, through the coordinator, to shorten the critical path). E builds both halves on S3's actor and permission wiring.
7. **PLAN-001 S9: hardening and lint.** This comes last, after session E's S8. E adds the `ui` metadata and command-menu entries for its own ops (teams, invites, members, workspace), so S9 adds them only for A's remaining ops and keeps the registry lint across every SPEC-001 op.

Since 2026-11-07 the queue is S3 (finish) → PLAN-002 S5 → PLAN-001 S9, plus the small follow-ups under "Open items carried over" (mailer wiring, the shared CSRF constants, E's fixture review, optional `syncGroups` on `ModelInsert`, the `sync_log` projection).

## Owns

- `apps/server/src/{sync,http,executor,cli,jobs}/**`, `apps/server/src/{app,server,lifecycle,config,logger,main}.ts`
- New modules `apps/server/src/auth/**` and `apps/server/src/setup/**`
- `apps/server/src/db/**`, except the PLAN-001 table files session E adds under `db/schema/` and E's S1 migration
- `CLAUDE.md`, `.claude/**`, `docs/07-plans/README.md`, the root `README.md`
- The shared error list in `packages/operations` (`catalog.ts`'s `Error` response), by the user's decision (2026-11-07)
- PLAN-002 S3–S5 and PLAN-001 S2, S3, S9 sections; SPEC-001 and SPEC-002 changes for those slices (logged)

## Shared registry files

These files are append-only for everyone: `apps/server/src/handlers/index.ts`, `packages/operations/src/ops/index.ts`, `packages/domain/src/model/index.ts`, `apps/server/src/sync/models.ts`, `apps/server/src/db/schema/index.ts` and `packages/domain/src/index.ts`.
- Add your own lines only.
- On a rebase conflict, keep both sides.

## Must not touch

- `packages/sync-client/**` and `packages/sync-protocol/**` (session D)
- `apps/web/**` and `packages/ui/**` (session C)
- Session E's PLAN-001 modules (teams, invites, account, mail, and since S7 moved to E: `handlers/{members,workspace}`, `ops/{member,workspace}.ts`, `features/{members,workspace}`)
- Session D's real-server test entry (`@surface/server/testing`): D may edit `apps/server` for that entry only, and sends A a handoff for any change to a server internal (e.g. hub timers). A answers D's questions about the internals.
- Migrations, until E's PLAN-001 S1 is on `main`

## Open items carried over

| Item | From | When |
|---|---|---|
| Root `README.md` step 6: real setup log line and URL | session B handoff | ✅ Done in PLAN-001 S2 (`grep setupUrl`, `surface setup-token`) |
| `.claude/rules/sync.md:15` still says `prev ≠ lastSyncId`; the protocol is now `prev ≤ lastSyncId` (sync-protocol.md §4.3) | session D log | Ask the user, then reword (A owns `.claude/**`) |
| Zod `eval` probe under the CSP | your PLAN-004 S9 handoff | Moved to session C (it owns `apps/web`); mark your row "reassigned to C" |
| Wire in session E's mailer (`apps/server/src/mail/job.ts`): `createEmailQueue(boss)` at startup where mail is sent, `startEmailWorker(boss, { smtp, sessionSecret, log })` in `startJobs` when `config.smtp` is set, and a way for routes and handlers to reach `boss` for `enqueueEmail` | session E (via the coordinator), on `p001-s4-mail` | After S3, once E's S4 is on `main`; blocks E's S4 routes and S5 only |
| ~~Real-server test entry for the sync property suite (`@surface/server/testing`: start/restart/stop, signed-in users, fixtures through `debug.create`, hub timers, no job worker; list the other server timers)~~ | session D handoff ([session-d2](session-d2-sync-tests.md#handoff-to-a-real-server-test-entry)) | **Moved to session D** (the user's decision, 2026-11-07): D builds it and may edit `apps/server` for that entry only; A answers questions and takes handoffs for server internals. Earlier notes for D, still true: Notes: `startServer` already takes `resolveActor`; since PLAN-001 S2 the setup guard answers `503 SETUP_REQUIRED` on `/api/` and `/sync/` until setup is done, so the entry must complete setup on its database (e.g. through `pgSetupStore`) |
| ~~Use session D's shared CSRF names (`CSRF_HEADER`, `CSRF_COOKIE`, `CSRF_INVALID`, `SESSION_PATH` from `@surface/sync-protocol` `src/csrf.ts`, on D's `p002-s8b-csrf`) in `auth/csrf.ts` and `auth/routes.ts` instead of A's literals~~ | session D (via the coordinator) | ✅ Done in the S3 review fixes (D's branch landed first, `073e940`) |
| `packages/operations/src/catalog.ts` (the OpenAPI `Error` response) lists only the operation codes, not `CSRF_INVALID` 403, `SETUP_REQUIRED` 503 or `UNAVAILABLE` 503 (S3 review minor 5) | A's S2 and S3 | **A owns the shared error list** (the user's decision, 2026-11-07, through the coordinator). Add them in the follow-up after S3 |
| Handlers end sessions: `ctx.closeSessions(userId, { except?: sessionId })`, running `hub.closeSessions` after commit, and the current session id on the actor (for "Revoke all others"). Same `HandlerContext` change as `ctx.enqueueEmail`; the close must reach every replica (S3 review M2: `pg_notify` through the hubs' `LISTEN`) | session E (via the coordinator) | Right after S3, with the mailer wiring: E's S4 `/auth/reset` (E10) and S6 (`user.changePassword`, `session.revoke`, `session.revokeOthers`) need it; S7 doesn't |

## Handoffs (requests from A to other sessions)

| To | Request | Why / blocking? | Status |
|---|---|---|---|
| C | PLAN-001 S2 added two hooks in your files: `apps/web/src/main.tsx` renders `SetupPage` on `/setup`, and `vite.config.ts` proxies `/setup/status` and `POST /setup` in dev. When your router lands (PLAN-005 S4), make `/setup` a route that renders `routes/setup/SetupPage` and drop the `main.tsx` switch; keep the proxy. | The user chose that A builds the setup wizard in `apps/web/src/routes/setup/`. Not blocking. | ✅ closed 2026-11-07: C's router (PLAN-005 S4, `5e15968`) renders `routes/setup/SetupPage` on `/setup`; the proxy stays |
| C | **PLAN-001 S3 web half** (the user's decision): login page (`/login`: email, password, and the magic-link button when `GET /auth/capabilities` says `smtp`), the auth guard, `?next=`, and on `401` go to `/login?next=<current>` keeping the queue (E14). The client sends `X-CSRF-Token` = the `surface_csrf` cookie on every cookie-authenticated POST (operations, `/sync/mutate`, `POST /auth/logout`); on `403 CSRF_INVALID` it calls `GET /auth/session` (which sets the cookie again) and resends once. The split (agreed with C and D, 2026-11-07): the sync client already does this for `/sync/mutate` (D's `queue.ts`), so the web app passes it a plain `fetch` with no CSRF handling, and C's own wrapper adds the header and the single retry for `/api/ops` and `POST /auth/logout` only; one retry per request, never nested; a socket closed with `4001` calls `GET /auth/session` first and reconnects if someone is still signed in (another tab signed in again, SPEC-001 Q11), else goes to `/login?next=…` (E10); `next` accepts only a same-origin path (`/…`, not `//…` or a URL); a `429` shows its message as is; when `GET /auth/capabilities` says `setupComplete: false` the login page goes to `/setup`; bodies are SPEC-003's `{ ok: true, result }`; `GET /auth/session` gives `{ userId, workspaceId }` or `401` (SPEC-001 §6.1, Q7–Q10). | Blocks sign-in in the app. The server half is on `p001-s3-auth`. | open |
| E | The setup wizard has a local `suggestTeamKey` (`apps/web/src/routes/setup/wizard.ts`). When PLAN-001 S8 adds `team.suggestKey`, say whether it should replace it (at setup no keys are taken, so the local one is enough there). | Avoid two key-suggestion rules drifting apart. Not blocking. | ✅ closed 2026-11-07: E answered, use the domain's `suggestTeamKey`; done after the rebase onto S8 |

## Log (append-only)

| Date | Slice | Branch | State | Notes / handoffs |
|---|---|---|---|---|
| 2026-11-07 | PLAN-002 S3 + review fixes | main | merged | Built, reviewed and fixed during phase 1 (rows in [session-a-platform.md](session-a-platform.md)). Rebased onto `95c55a8`, clean; `pnpm install`, `pnpm check`, `pnpm registry:lint`, `pnpm test:int` (179 + 3 perf) green; main fast-forwarded to `a76c982`. Also carries session D's docs commit `34e7ed8` (SPEC-002 AC-6 qualifier). Next: PLAN-002 S4. |
| 2026-11-07 | PLAN-002 S4 | p002-s4-hub | built | Sync hub and `GET /sync/ws` (`delta-writer.ts`, `hub.ts`, `hub-source.ts`, `socket-route.ts`), `NOTIFY` in `flush`, `synclog-prune` job; `@fastify/websocket` (ADR-0005). New spec decisions SPEC-002 Q9 (API keys `403` on the socket) and Q10 (`since` ahead of head → `too_old`), awaiting the user's approval. A text-ordering bug in the log reads was found by the manual AC-9 check and is covered by the AC-11 test. `pnpm check` green (server 276 tests), `registry:lint` clean, `test:int` 181 green; **`sync-lock.perf.int.test.ts` failing** (87–90 % under 2 ms), not attributable on an overloaded machine (PLAN-002 S4 As built). Worktree moved to `../surface-a`. |
| 2026-11-07 | PLAN-002 S4 review fixes | p002-s4-hub | built | Fast-forwarded to `99aacd3` first. Fixed every `/review` finding: the AC-11 live test waits for both sockets' catch-up (8/8 runs green); the hub drains on each ping round (half-open `LISTEN`, failed reads) and the listen client has TCP keepalive; catch-up waits for slow readers instead of dropping them; `/sync/ws` refuses a foreign `Origin` (`403`); prefix prune (checked by hand: the old one left a hole); metrics tests; catch-up reads invisible ack rows without data; `start()` and re-listening close their listeners. Perf test now passes (3/3 at load ~2.3). SPEC-002 Q9, Q10, the metric rename and the new §4.3 rules (Origin `403`, 1 MiB catch-up pause, prefix prune) approved by the user. |
| 2026-11-07 | PLAN-002 S4 second review | p002-s4-hub | built | No blockers. Fixed: catch-up held a pool connection and a `REPEATABLE READ` snapshot while waiting for a slow reader (10 slow clients could hold the pool of 10); it now reads each page as its own statement and re-checks retention after each (`sync-hub-source.test.ts`). Docs: "nothing more but pings" after a `resync`, close code `1009`, two As built corrections. To rebase onto `acf0fa1` (PLAN-001 S1): `sync-groups.int.test.ts` conflicts, keep both sides. |
| 2026-11-07 | PLAN-002 S4 | main | merged | Committed as `c7f478b`, rebased onto `acf0fa1` (PLAN-001 S1) as `b2f6963`: `sync-groups.int.test.ts` merged cleanly with both sides (S1's `DebugItem` filter and the harness's real ENG/SEC teams; S4's hub tests). `pnpm install`, `pnpm check` (server 322), `registry:lint`, `pnpm test:int` (188 + 3 perf) green; the AC-11 leak test 3/3 with S1's Team and WorkflowStatus rows in catch-up. Session E's fixture handoff (`test/executor.ts` and the adjusted sync tests): they pass with S4; not yet read line by line (still open). `main` is checked out in the main checkout, so the user fast-forwards it there. **A holds the migration lock** (from E). |
| 2026-11-07 | PLAN-001 S2 | p001-s2-setup | built | Branched from `main` `08f2ccd`. First-run setup: `setup/` (token, store, routes and guard, input, announce), `auth/password.ts` (argon2id) and `auth/session.ts` (session row and cookie), `surface setup-token`, `passwordProblem` in `@surface/domain`; `@node-rs/argon2` ^2.2.2 (ADR-0007). **The wizard UI in `apps/web/src/routes/setup/` was built by A, by the user's decision** (C owns `apps/web`), plus hooks in `main.tsx` and `vite.config.ts` (handoff to C). A holds the migration lock; no migration was needed. New spec decisions SPEC-001 Q4–Q6 and SPEC-003 `SETUP_REQUIRED`, awaiting the user's approval. The hand check against Postgres found that a connection killed mid-setup crashed the process (no `error` listener on a checked-out pg client); fixed in the store. The same hazard likely exists in `sync/bootstrap.ts` and the executor: not fixed here, proposed as a follow-up. Root README step 6 done. Gate results in the PLAN-001 S2 As built and the report. |
| 2026-11-07 | PLAN-001 S2 review fixes | p001-s2-setup | built | Rebased onto `45944a1` (PLAN-005 S6) first: no conflicts, the lockfile merged on its own. Fixed every `/review` finding (PLAN-001 S2 As built, "Review fixes"): no argon2 before the token and state checks; the guard on the decoded path; `setup-store.test.ts` covers the store's checks and the killed-connection crash; time zones canonical, offsets refused; `SURFACE_SETUP_TOKEN` ≤ 128; shared email and name rules (`packages/domain/src/names.ts`, new); the wizard's starting and expired-link cases, and its state in `state.ts`; AC-7 and Q4 wording. Each new test was mutation-checked (8 of 8 caught). SPEC-001 Q4–Q6 marked **proposed**, then approved by the user (2026-11-07). Open: `catalog.ts` error list (no owner in phase 2). |
| 2026-11-07 | PLAN-001 S2 rebase onto S8 | p001-s2-setup | built | Rebased onto `aea1377` (PLAN-001 S8 server half): conflicts in `packages/domain/src/index.ts` and SPEC-001 §11 (E's D2, D3 and my Q4–Q6), both sides kept. Then took S8's domain rules: `suggestTeamKey` in the wizard (E's answer to my handoff, closed), `timeZoneProblem`/`canonicalTimeZone` for the Admin's zone, `NEW_TEAM_SETTINGS` for the setup team, and team names up to 80 like `TEAM_NAME_MAX`. |
| 2026-11-07 | PLAN-001 S2 | main | merged | Committed as `0856540` (test: the shutdown test waits for its request) and `786d60c` (S2); SPEC-001 Q4–Q6 approved by the user. The user fast-forwarded `main` to `786d60c` from the main checkout. Uncached `pnpm check` there: two 1-second exit checks (`cli.test.ts`, `config-exit.test.ts`) failed once at load 12.5 (about 1081 ms), passed alone and on the re-run (load-sensitive, like `sync-lock.perf`). |
| 2026-11-07 | PLAN-001 S3 (server half) | p001-s3-auth | built | By the user's decision A builds the server half and C the web half (handoff below). Sign-in, sign-out, `GET /auth/session` (C's request), capabilities, CSRF (HMAC of the session id), the lockout in Postgres (migration `0008_auth_attempts`; A holds the lock), the session as the default actor resolver with `memberOf` built per request (E's handoff), sign-out closing sockets. New spec decisions SPEC-001 Q7–Q10, awaiting the user's approval. 15 mutation checks caught; held AC-5–AC-8 checked by hand against Postgres. Gate results in the report. |
| 2026-11-07 | Scope change | p001-s3-auth | — | By the user's decision (through the coordinator), to shorten the critical path: PLAN-001 S7 (Members and Workspace, Admin) moved to session E (its order: rest of S4 → S7 → S5 → S6; S7 starts once S3 is on `main`), which builds both halves on S3's actor and permission wiring; the real-server test entry (`@surface/server/testing`) moved to session D, which may edit `apps/server` for that entry only and hands off any change to a server internal. A's queue: S3 (finish) → PLAN-002 S5 → PLAN-001 S9, plus the follow-ups in "Open items". Scope, Owns, Must not touch and README §7 updated. Checked that S7 isn't tangled into S3: the actor's role is read from the database on every request, so a role change applies at once with no session work. |
| 2026-11-07 | PLAN-001 S3 review fixes | p001-s3-auth | built | Rebased onto `224eb79` (E's mailer half; PLAN-001 conflict in the S3/S4 boundary, both sides kept) and then `073e940` (D's CSRF constants, now used). Fixed every `/review` finding, each bug test first (7 failed before their fix): the lockout reserves an attempt under a per-key lock before the password check (B1); CSRF and the setup guard apply while draining (B2); sliding expiry resends the cookies (M1); sign-out reaches every replica through `NOTIFY session_revoked` (M2); tests of the real stores and of the socket wiring (M3); minors and nits (PLAN-001 S3 "Review fixes"). Migration `0008` regenerated with an index on `attempted_at`. 12 mutations caught; B1 and M2 checked by hand against Postgres 17. GET `/auth/session` body: SPEC-001 §6.1 now says bodies are SPEC-003's `result` (D's note). Not taken: `__Host-` prefix. Session id on the actor: the follow-up, by the user's decision. |
| 2026-11-07 | PLAN-001 S3 second review fixes | p001-s3-auth | built | Rebased onto `5e15968` (C's app shell: its router serves `/setup`, the dev proxy covers `/auth/`; nothing to change here; my S2 handoff to C closed). Fixed every finding of the second `/review` (PLAN-001 S3 "Second review fixes"): the private-team leak test against Postgres with real sessions (M1); the address limit 20 by the user's decision on Q8 (M2); `Lifecycle.everReady` so an early shutdown answers `503` (m1); workers send `session_revoked` too (m2); SPEC-002 E10 and sync-protocol.md (m3); SPEC-001 Q11 proposed (m4); tests for capabilities before setup (m5) and the nits. The user gave A the operations error list (Owns). |

## Prompt

```
You are session A of the Surface project, phase 2, working in the main checkout /Users/admin/Desktop/Learning/surface. Your track is the sync server, then setup and auth: finish PLAN-002 S3–S5, then PLAN-001 S2, S3, S7 and S9. (2026-11-07: S7 moved to session E and the real-server test entry to session D; see Scope.)
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
