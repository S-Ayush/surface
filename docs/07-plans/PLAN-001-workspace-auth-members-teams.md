# PLAN-001: Workspace setup, authentication, members & teams

Implements: [SPEC-001](../06-specs/SPEC-001-workspace-auth-members-teams.md) · Status: **Ready** · Order: **4th** · Depends on: PLAN-002 S5 (mutate) and S8 (client dispatch), PLAN-003 S6 (HTTP ops)

> **UI note:** screens are built with the PLAN-005 primitives when available (S2 and S3 of PLAN-005 run in parallel). Otherwise they use plain functional markup, restyled in PLAN-005 S7. Layouts follow SPEC-001 §7.

---

## 1. Slices

### S1: Domain schema & models · M
- Migrations: `workspace`, `users`, `sessions`, `invites` (with `team_ids uuid[]`), `magic_link_tokens`, `password_reset_tokens`, `setup_state`, `teams`, `team_memberships`, `workflow_statuses`, `labels`. All synced tables have `sync_groups`, and server-only tables are marked as such.
- Constraints for the invariants: unique lowercase email, unique display name, team key check `^[A-Z]{2,5}$` plus unique, one active-admin check (enforced in the handler; a DB trigger is not needed), the default status category check.
- `groupsOf()` for each synced model (`workspace` for all in M0; `team:<id>` logic is ready for private teams).
- Shared **model definitions** (`packages/domain/models/*`): Workspace, User (public fields), Team, TeamMembership, WorkflowStatus, Label, UserPreferences. These are registered with sync-client and the server sync registry, which bumps the schemaHash.
- `seedTeamWorkflow(tx, teamId)` (8 statuses per SPEC-001 §4) and `seedWorkspaceLabels(tx)`.
- **Tests:** constraint tests, seed functions satisfy INV-04 and INV-05.

### S2: First-run setup · M
- On startup, if `setup_state.completed_at` is null: generate a token (or use `SURFACE_SETUP_TOKEN`), store its hash, and log the setup URL as a prominent block.
- `surface setup-token` CLI (regenerate and print).
- `GET /setup/status`, `POST /setup` (token check, row lock on `setup_state`, one transaction: workspace + admin + team + membership + statuses + labels, then a session cookie).
- A setup guard on every route while setup is incomplete (API returns 503 `SETUP_REQUIRED`; web redirects).
- **Setup wizard UI** (3 steps, keyboard-advance) in `apps/web/src/routes/setup`.
- **Tests:** AC-1 (token required), AC-2 (atomic, with a kill-mid-setup integration test using fault injection), E1 (concurrent setup).
- Unblocks PLAN-004 S8 (install smoke).

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

### S4: Mailer, magic link, password reset · M
- Mailer service (Nodemailer, from `SMTP_URL`). Sending happens **via the outbox and a job** (`email.send`), never inside request transactions. Plain HTML templates plus text alternatives (magic link, reset, invite).
- `POST /auth/magic-link` (always 200; invalidates older unused links, E9) and `GET /auth/magic` (consume, then session).
- `POST /auth/forgot`, `POST /auth/reset` (revokes other sessions, E10).
- `user.createResetLink` op (🛡) and `surface reset-password <email>` CLI.
- Web: forgot, reset, check-email pages. Magic-link and forgot options are hidden when `smtp=false`.
- **Tests:** AC-3 (no-SMTP path), AC-4 (with a **Mailpit** container in CI: read the emails via its API and follow the links).

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

### S8: Teams · L
- Ops `team.suggestKey`, `team.create` (key validation, reserved keys, seeds the workflow, adds the creator as a member; client-generated ID), `team.update`, `team.join`, `team.leave`, `team.addMember`, `team.removeMember` (destructive). All mutations have `optimistic` implementations.
- The key-suggestion algorithm lives in `packages/domain` (shared, so the client suggests instantly while the user types).
- Web: create-team modal, Settings → Teams (browse with join buttons), team General and Members settings, and the team ⋯ menu join/leave. The sidebar team list comes from PLAN-005 S4.
- **Tests:** AC-11 (key rules and suggestions), AC-12 (create shows in another tab < 150 ms), AC-13 (membership changes live), E11, E12.
- **Unblocks:** PLAN-002 S10 (team-rename demo e2e).

### S9: Hardening & lint · S
- Registry lint passes for every SPEC-001 op (AC-16): summaries, keywords, examples, and `ui` metadata for command-menu use ("Create team", "Invite member…", "Rename team…", "Join team…").
- Log events for the M7 audit log: `auth.*`, `user.*`.
- Install smoke (PLAN-004 S8) is enabled with a full setup and first team.
- A security review of the auth slice (checklist: enumeration, timing, CSRF, cookie flags, token single-use, rate limits, log redaction).

## 2. Modules touched
`packages/domain/models/*`, `packages/domain/team-key.ts`, `packages/operations/{workspace,user,session,invite,team}/*`, `apps/server/src/{auth,mail,files,setup}/*`, handlers for the ops above, migrations, `apps/web/src/routes/{setup,login,forgot,reset,invite,settings}/*`, `e2e/auth-*.spec.ts`, `e2e/teams-*.spec.ts`.

## 3. Migration & rollback
Additive tables only. A rollback before any release is a code revert. After a release, tables are kept (forward-only policy).

## 4. Test plan (AC → test)

| AC | Test |
|---|---|
| AC-1 | `e2e/setup-token.spec.ts` |
| AC-2 | `server/test/setup-atomic.int.test.ts` |
| AC-3 | `e2e/no-smtp.spec.ts` (full J1 with invite and reset links) |
| AC-4 | `e2e/smtp-flows.spec.ts` (Mailpit) |
| AC-5 | `server/test/login-enumeration.int.test.ts` |
| AC-6 | `server/test/login-lockout.int.test.ts` |
| AC-7 | `server/test/session-cookie.int.test.ts` |
| AC-8 | `e2e/session-revoke.spec.ts` |
| AC-9 | `server/test/password-hash.test.ts` |
| AC-10 | `server/test/set-role.int.test.ts` |
| AC-11 | `domain/test/team-key.test.ts` + `server/test/team-create.int.test.ts` |
| AC-12, AC-13 | `e2e/teams-realtime.spec.ts` |
| AC-14 | `server/test/admin-permissions.int.test.ts` + `e2e/admin-routes.spec.ts` |
| AC-15 | `e2e/profile-realtime.spec.ts` |
| AC-16 | CI registry lint |

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| A timing side channel on login | A dummy argon2 verify for unknown emails, and a timing test with tolerance |
| SMTP variability (TLS modes, providers) | `SMTP_URL` supports `smtp://` with STARTTLS and `smtps://`. `surface doctor` tests the connection. Documented examples for common free providers. |
| Lockout abused to lock out real users (DoS) | Lockouts are per account **and** IP. Lockouts are short (15 min), and an Admin reset link always works. |
| The avatar pipeline (sharp) bloats the image or breaks arm64 builds | Prebuilt sharp binaries for both architectures are verified in CI. A fallback stores the original without a thumbnail if sharp fails. |
