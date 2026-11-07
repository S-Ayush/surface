# SPEC-001: Workspace setup, authentication, members & teams

Status: **Accepted** (2026-11-06) · Milestone: **M0** · Date: 2026-11-06
Implements: FR-AUTH-01, 02, 03, 04, 05, 07, 08, 09 · FR-MEM-01, 02 · FR-TEAM-01, 02, 03, 04 (team creation seeds the workflow) · NFR-13
Depends on: SPEC-002 (sync v0), SPEC-003 (Operation Registry), SPEC-004 (packaging)
Related: [domain-model §4.1–4.4, 4.16](../03-domain/domain-model.md) · [state-machines §6](../03-domain/state-machines.md) · [ADR-0007](../04-architecture/adr/0007-auth.md)

---

## 1. Problem & goal

A team that has just run `docker compose up` must be able to claim the install, log in, invite colleagues, and create teams, **with or without an email server**. That covers PRD journey J1 up to "first team created". Everything else in Surface builds on the users, sessions, and teams defined here.

## 2. Scope

**In scope**
- First-run setup wizard, protected by a setup token
- Email + password login, magic-link login (when SMTP is configured), logout
- Password reset by email, or by an Admin-generated link
- Invites by link or email, with role and optional teams. Accepting an invite creates the account.
- Session listing and revocation, login rate limiting and lockout
- Profile (name, display name, avatar, timezone)
- Roles: Admin and Member. Promote and demote, guarding the last Admin.
- Teams: create (seeding default statuses), update general settings, join and leave, add and remove members
- Seed data: workspace labels *Bug*, *Feature*, *Improvement*

**Out of scope (later specs)**
- Deactivating users and the signup-by-domain policy (M7)
- Private teams (M7). The `private` column exists but is always `false` in M0.
- Workflow and label editing UI (SPEC-010), team triage and cycle settings (M3/M4)
- 2FA (v2), SSO (never)

## 3. User flows

### 3.1 First-run setup (no workspace exists)
1. On first boot, the server generates a **setup token** and logs it prominently:
   `Open https://surface.example.com/setup?token=XXXX-XXXX-… to …`, at `warn` and with the link in a `setupUrl` field (Q4). Alternatively, the operator sets `SURFACE_SETUP_TOKEN`. `surface setup-token` prints a fresh link.
2. Every route redirects to `/setup` until setup is complete (Q5). `/setup` without a valid token shows *"Find the setup link in the server logs"*.
3. **Step 1, Workspace:** workspace name.
4. **Step 2, Admin account:** name, email, password (twice).
5. **Step 3, First team:** team name. The key is auto-suggested (e.g. "Engineering" → `ENG`) and editable.
6. Submit. In one transaction the server creates the Workspace, the Admin user, the Team (with default statuses), the TeamMembership, and the seed labels. The setup token is invalidated, a session is created, and the user is redirected to the team's issues page.

Keyboard: `Enter` advances each step. `Esc` does nothing (setup can't be skipped).

### 3.2 Login
- `/login` shows email and password, plus a **"Email me a login link"** button (only when SMTP is configured).
- Password login: on success, create a session and redirect to `?next=` or home. On failure show the generic *"Email or password is incorrect"*.
- Magic link: `POST /auth/magic-link {email}` **always** answers *"If an account exists, we sent a link"*, so it can't be used to discover accounts. The link `/auth/magic?token=…` creates a session.

- *As built (PLAN-001 S3 web half, 2026-11-07):* the page shows a refused sign-in's message as the server sends it, the lockout's "Try again in N minutes" included (E13). A server failure or no answer says to check the connection and try again. The magic-link button arrives with PLAN-001 S4's routes.

### 3.3 Password reset
- **With SMTP:** `/forgot` takes an email and always answers the generic message. The email contains `/reset?token=…`, where the user sets a new password. Using it logs out all other sessions.
- **Without SMTP:** `/forgot` explains *"Ask an Admin for a reset link"*. Admin: Settings → Members → ⋯ → **Generate reset link** → copy. The link is valid for 1 hour and single-use.

### 3.4 Invites
1. Admin: Settings → Members → **Invite**. Fields: email (optional when there is no SMTP), role (Member by default), teams (optional, multi-select).
2. **With SMTP and an email given:** the invite is emailed, and the link can also be copied. **Otherwise:** the link is shown for copying.
3. The invitee opens `/invite/:token` (valid 7 days) and enters name, display name, and password. (Email is prefilled and locked if the invite has one; otherwise it is entered.)
4. On submit: create the User, add the chosen team memberships, mark the invite accepted, start a session, and land on home.
5. Admins can **revoke** pending invites. Revoked or expired links show *"This invite is no longer valid"*.

### 3.5 Account settings
- **Profile:** name, display name, avatar upload (≤ 2 MB image, cropped square), timezone (default: browser timezone at signup).
- **Security:** change password (requires the current password, and logs out the other sessions) and a **sessions** list (device, IP, last active, "this device") with *Revoke* and *Revoke all others*.

### 3.6 Members (Admin)
- List of users: avatar, name, email, role, teams, joined date. Filter by role.
- Actions: change role (Member ↔ Admin), generate reset link. *Deactivate* comes in M7.

### 3.7 Teams
- **Create team** (any member): from the sidebar *+*, or `Cmd+K` → "Create team". Name, key (suggested), icon and color, timezone (defaults to the creator's). The creator becomes a member.
- **Team settings → General:** name, icon, color, timezone. The key is shown read-only (changing it is v2).
- **Team settings → Members:** list, plus *Add member* (members of the team, and Admins) and *Remove*.
- **Join / leave:** the team ⋯ menu offers *Join team* (non-member) or *Leave team* (member). The browse list at Settings → Teams shows all teams with a member count and a Join button.

## 4. Domain changes

| Entity | Notes |
|---|---|
| Workspace | Created at setup. `signupPolicy = invite_only`. |
| User | `role`, `active = true`, `timezone`. The password hash is in **UserCredentials 🔒** (`userId`, `passwordHash`), a server-only table: a synced row's every write is broadcast (PLAN-001 S1). |
| Session 🔒 | `tokenHash`, `userAgent`, `ip`, `lastUsedAt`, `expiresAt` (30-day sliding) |
| Invite 🔒 | Adds **`teamIds uuid[]`** (an addition to domain-model §4.16) |
| MagicLinkToken 🔒, PasswordResetToken 🔒 | 15 minutes / 1 hour, single-use |
| SetupState 🔒 | **New:** `tokenHash`, `completedAt`. A singleton. |
| Team, TeamMembership | As in the domain model |
| WorkflowStatus | **Seeded per team:** Triage (triage) · Backlog (backlog, *default*) · Todo (unstarted) · In Progress (started) · In Review (started) · Done (completed) · Canceled (canceled) · Duplicate (duplicate, system) |
| Label | **Seeded at setup:** workspace labels Bug (red), Feature (violet), Improvement (blue). The palette has no purple (design-system §2.2). |

**Key suggestion algorithm:** take the initials of the words (up to 3); for a single word, the first 3 letters, uppercased (`Engineering` → `ENG`, `Mobile Platform` → `MP`). If the key is taken, append a digit-free variation (`ENGI`), else ask the user.
**Reserved keys:** `NEW`, `API`, `MCP`, `SYNC`, `AUTH`.

Invariants enforced: INV-01 (at least one active Admin), INV-02 (unique email and display name), INV-03 (key format and uniqueness), INV-04/05 (seeded statuses, default status).

## 5. Sync & permissions

| Model | Sync group | Notes |
|---|---|---|
| Workspace | `workspace` | |
| User (public fields: id, name, displayName, avatar, timezone, role, active) | `workspace` | Email is synced too: it is an internal tool and everyone is a colleague |
| User preferences | `user:<id>` | |
| Team, TeamMembership, WorkflowStatus, Label | `workspace` | `team:<id>` once private teams exist (M7) |
| Session, Invite, tokens, SetupState | server-only | Read through operations (`session.list`, `invite.list`) |

Permissions follow [permissions §3.1–3.2](../03-domain/permissions.md): invites, roles, workspace settings, and reset links are 🛡 Admin. Team member management is for team members and Admins. Anyone can create, join, or leave a team.

## 6. API

### 6.1 Unauthenticated HTTP routes (outside the registry)

Answers use SPEC-003's HTTP shapes: `{ ok: true, result }` on success and `{ ok: false, error: { code, message, correlationId } }` otherwise. The bodies below are the `result`.

| Route | Purpose |
|---|---|
| `GET /setup/status` · `POST /setup` | Setup state and completion (needs the token). `GET /setup/status?token=` → `{ complete, tokenValid }`. `POST /setup` takes `{ token, workspace: { name }, admin: { name, email, password, timezone? }, team: { name, key } }` and answers `201` with the session cookie and `{ next: "/team/<key>" }`; `400 INVALID_INPUT`, `403 FORBIDDEN` (wrong or old token), `409 CONFLICT` (already set up, E1), `503 UNAVAILABLE` while starting |
| `POST /auth/login` | `{email, password}` → `200 { userId }` with the session and CSRF cookies. A session the browser already had ends, and its sockets close (Q11). `401 UNAUTHENTICATED` "Email or password is incorrect" for a wrong password and an unknown email alike (AC-5); `429 RATE_LIMITED` with `Retry-After` while locked (AC-6, E13, Q8); `403 FORBIDDEN` from another `Origin` (Q10); `400 INVALID_INPUT` |
| `POST /auth/logout` | Ends the current session, closes its sockets with `4001` on every replica, and clears both cookies. Needs the CSRF header like any cookie-authenticated POST. `200` even when already signed out |
| `GET /auth/session` | Who is signed in: `{ userId, workspaceId }`, and the CSRF cookie set again. `401 UNAUTHENTICATED` when signed out, clearing a cookie that no longer works (Q9) |
| `POST /auth/magic-link` · `GET /auth/magic?token=` | Request and consume a magic link |
| `POST /auth/forgot` · `POST /auth/reset` | Request a reset; reset with `{token, password}` |
| `GET /invite/:token` · `POST /invite/:token/accept` | Show and accept an invite |
| `GET /auth/capabilities` | `{ smtp: bool, setupComplete: bool }`, so the UI can show or hide options. Open before setup too |

**CSRF (Q7).** Every cookie-authenticated `POST`, `PUT`, `PATCH` or `DELETE` (the operations, `/sync/*`, `POST /auth/logout`) sends the header `X-CSRF-Token` with the value of the `surface_csrf` cookie, which the server sets at sign-in and setup, and again on `GET /auth/session`. Without it, or with another session's, the answer is `403 CSRF_INVALID` "This request is missing its security token. Reload the page and try again." The client then calls `GET /auth/session`, which sets the cookie again, and resends once: one retry per request, never nested (the sync client does it for `/sync/mutate`, the web app for its other requests). `POST /auth/login` and `POST /setup` need none: there is no session yet (sign-in checks the `Origin` instead, Q10). Requests without a session cookie aren't checked; they get `401`. API keys (M6) don't use cookies, so CSRF doesn't apply to them.

**Sliding expiry.** A request whose session was last used 5 minutes ago or more extends it to 30 days from now, and its response sets both cookies again, so the browser keeps them as long as the server does. A response that sets or clears the session itself (sign-in, sign-out) is left alone.

### 6.2 Operations (registry)
| Operation | Kind | Permission | Notes |
|---|---|---|---|
| `workspace.get` / `workspace.update` | q / m | any / 🛡 | name, logo |
| `user.me` / `user.list` / `user.get` | q | any | |
| `user.updateProfile` | m | self | name, displayName, avatarFileId, timezone |
| `user.changePassword` | m | self | `{currentPassword, newPassword}` |
| `user.setRole` | m | 🛡 | Guards INV-01 |
| `user.createResetLink` | m | 🛡 | Returns a URL (shown once) |
| `session.list` / `session.revoke` / `session.revokeOthers` | q / m / m | self | |
| `invite.create` / `invite.list` / `invite.revoke` | m / q / m | 🛡 | `create` returns `{url, emailed: bool}` |
| `team.create` | m | any | `{id?, name, key?, icon?, color?, timezone?}` → seeds statuses, adds the creator. `id` is the client's UUIDv7 (SPEC-003 §8); `key` defaults to a suggestion |
| `team.update` | m | team member, 🛡 | name, icon, color, timezone |
| `team.join` / `team.leave` | m | any (public) / member | Joining as a member, or leaving as a non-member, changes nothing |
| `team.addMember` / `team.removeMember` | m | team member, 🛡 | `removeMember` is flagged `destructive` for API keys. Adding a member or removing a non-member changes nothing |
| `team.suggestKey` | q | any | `{name}` → `{key}`; `key` is null when the name suggests none |

## 7. UI

| Screen | Route | Notes |
|---|---|---|
| Setup wizard | `/setup` | 3 steps with a progress indicator |
| Login | `/login` | Magic-link button hidden when `smtp=false` |
| Magic link sent / Forgot / Reset | `/login/check-email`, `/forgot`, `/reset` | |
| Accept invite | `/invite/:token` | Shows the workspace name and who invited |
| Settings: Account | `/settings/account/profile`, `/settings/account/security` | |
| Settings: Members 🛡 | `/settings/members` | Invite modal, role menu, reset-link modal |
| Settings: Workspace 🛡 | `/settings/workspace` | Name, logo |
| Settings: Teams | `/settings/teams`, `/settings/teams/:key/general`, `/settings/teams/:key/members` | |

States: loading skeletons, inline field errors, a toast for network errors. Before the design system (SPEC-005) these screens use plain, functional styling; their layout is final.

## 8. Edge cases

| # | Case | Behaviour |
|---|---|---|
| E1 | Two people submit setup at once | Only the first succeeds (row lock on SetupState). The second gets "Setup already completed". |
| E2 | Email in a different case at login or invite | Emails are normalised to lowercase |
| E3 | Invite for an email that already has an account | `invite.create` → `CONFLICT: "A user with this email already exists"` |
| E4 | Invite accepted twice, or after revoke or expiry | "This invite is no longer valid" |
| E5 | Display name already taken | Inline error with a suggestion (`iris2`) |
| E6 | The last Admin demotes themselves | `CONFLICT: "Surface needs at least one Admin"` |
| E7 | SMTP configured but sending fails | The invite is still created. The UI shows "Email failed. Copy the link instead" and the copyable link. Magic-link requests fail silently to the user, but are logged and alerted on the System page later. |
| E8 | Magic link opened on a different device | Works (token-based). That device gets a new session. |
| E9 | Several magic links requested | Only the newest is valid. Older unused links are invalidated. |
| E10 | Password changed or reset | All other sessions are revoked. Their open sockets close with code `4001 session_revoked`, and the clients go to `/login`. |
| E11 | Team key collides, or is reserved or invalid | Inline error, plus the next suggestion for the name. Keys are unique across the workspace, so a private team's key reads as taken to non-members (D2) |
| E12 | The last member leaves a team | Allowed for a public team: it stays and can be joined. The last member of a **private** team cannot leave or be removed (`CONFLICT`) (D3) |
| E13 | Login attempts exceed the rate limit | 429 with a "Try again in N minutes" message. An audit entry is added (in M7). |
| E14 | The session expires while the app is open | The next request or socket gets 401, and the app redirects to `/login?next=<current>`. Queued offline mutations are kept until the same user logs in again. |

## 9. Acceptance criteria

> **Held (2026-11-06): tests that need a browser, a running stack or Postgres are not written for now** (D1 in §11): criteria whose test is `e2e`, `e2e perf`, `perf`, `smoke`, `manual / e2e` or `integration` are held until the hold is lifted. Still written: unit and property tests, the sync property suite (SPEC-002 AC-2/AC-3) and private-team leak tests (SPEC-002 AC-11, `permissions.md` §5).

| AC | Criterion | Test |
|---|---|---|
| AC-1 | On a fresh install the setup token appears in the logs. `/setup` without the token cannot complete. | e2e |
| AC-2 | Setup creates the workspace, Admin, first team with 8 seeded statuses (Backlog default), membership, and 3 workspace labels in one transaction. Killing the server mid-setup leaves no partial data. | integration |
| AC-3 | With `SMTP_URL` unset: the login page shows no magic-link option, invites return a copyable link, and the Admin can generate a working reset link. J1 completes. | e2e |
| AC-4 | With SMTP set (a MailHog-style test container): magic-link login, password reset, and emailed invites work end to end. | e2e |
| AC-5 | Wrong-password and unknown-email login responses are identical in body and status, and their timing is within ±50 ms. | integration |
| AC-6 | After 5 failed logins in 15 minutes for an account, a 6th correct login is refused until the lockout ends. | integration |
| AC-7 | Session cookies are `HttpOnly; SameSite=Lax`, plus `Secure` when `SURFACE_URL` is https, and only the hash of the token is stored in the DB. (Changed 2026-11-07, PLAN-001 S2: was always `Secure`, which a plain-http install allowed by SPEC-004 §7 could never sign in with.) | integration |
| AC-8 | Revoking a session closes that session's WebSocket within 1 s, and its next HTTP call returns 401. | e2e |
| AC-9 | Passwords are stored with argon2id (m = 19 MiB, t = 2, p = 1) and a minimum length of 10. | unit |
| AC-10 | `user.setRole` cannot leave zero active Admins. | unit + integration |
| AC-11 | `team.create` rejects a duplicate, reserved, or malformed key, and suggests a valid key for the given name. | unit |
| AC-12 | Creating a team in tab A shows it in tab B's sidebar within 150 ms on a LAN, without a reload (via SPEC-002). | e2e |
| AC-13 | Join, leave, add, and remove membership changes appear live in other clients. | e2e |
| AC-14 | Members cannot reach Admin routes or operations: the UI hides them, and the API returns `FORBIDDEN`. | integration |
| AC-15 | Profile changes (name, avatar) appear live for other users. | e2e |
| AC-16 | Every operation in §6.2 is registered with a summary, keywords, an example, and a permission (registry lint passes). | CI |

## 10. Metrics & performance

- `POST /auth/login` p95 < 300 ms. Argon2 dominates; that cost is intended.
- Setup to first screen < 2 s.
- Log events (audit-ready for M7): `auth.login`, `auth.login_failed`, `auth.password_reset`, `user.invited`, `user.joined`, `user.role_changed`.

## 11. Decisions (open questions resolved with the proposed defaults, 2026-11-06)

| # | Question | Decision |
|---|---|---|
| Q1 | Allow password-less accounts (magic link only) when SMTP is configured? | No: a password is always required in v1, and magic link is an *additional* way to log in |
| Q2 | Should email addresses be visible to all members? | Yes (internal tool) |
| Q3 | Should Admins be able to edit other users' profiles? | No: only roles and reset links |
| D1 | (2026-11-06) Write e2e (Playwright), smoke and integration tests now? | No, by decision of the user, for faster development; they are added later. Tests that need a browser, a running stack or Postgres (`e2e`, `e2e perf`, `perf`, `smoke`, `manual / e2e`, `integration`) are **held**: no test is written for them yet, and the slice notes in "As built" whether the behaviour was checked by hand. Not held: unit and property tests (including the unit parts listed for held criteria), the sync property suite (SPEC-002 AC-2/AC-3) and private-team leak tests (SPEC-002 AC-11, `permissions.md` §5), which may use Postgres. Existing integration tests are kept. See [plans README §6](../07-plans/README.md#6-testing-hold-e2e-smoke-and-integration). |
| D2 | (2026-11-07) May a non-member learn that a private team's key exists? | Yes, by decision of the user (PLAN-001 S8 review): keys are unique across the workspace (INV-03), so `team.create` with a private team's key is `CONFLICT` and `team.suggestKey` skips it. The answer names the key only, never the team's name, id or anything else. An exception to "private teams never leak", recorded in permissions.md §5. |
| D3 | (2026-11-07) Can the last member of a private team leave or be removed? | No, by decision of the user (PLAN-001 S8 review): nobody else can see a private team (Admins included, until M7), so nobody could rejoin it. `team.leave` and `team.removeMember` answer `CONFLICT` and ask to add someone first. A public team's last member may leave (E12). |
| Q4 | (2026-11-07, PLAN-001 S2; approved by the user) How is the setup token issued and shown? | 160 random bits as eight groups of four Crockford base32 characters; only its SHA-256 is stored, and it is compared in constant time. While setup is incomplete, each start issues a new one (the old link stops working), unless `SURFACE_SETUP_TOKEN` is set; `surface setup-token` issues a fresh one at any time. Completing setup clears it. The server logs the link at `warn` as one JSON line, in the message and in a `setupUrl` field: the one secret the logs carry, because the operator has no other way to get it. With more than one container serving HTTP, set `SURFACE_SETUP_TOKEN`: otherwise each start replaces the token and only the last logged link works. `surface setup-token` replaces even a configured token, until the next start. If the token changes while the wizard is open, Finish asks for the newest link and keeps what was typed. |
| Q5 | (2026-11-07, PLAN-001 S2; approved by the user) What does setup close until it is done? | `/api/`, `/sync/` (the WebSocket too), `/auth/`, `/files/` and `/mcp` answer `503 SETUP_REQUIRED`; a browser asking for any page is redirected to `/setup`. Health, readiness, metrics, static files and the setup routes stay open. Once setup is done, `/setup` redirects to `/`. |
| Q6 | (2026-11-07, PLAN-001 S2; approved by the user) What are the Admin's display name and time zone at setup? | The wizard asks only what §3.1 lists. The display name comes from the first word of the name (else the email's local part), as lowercase letters and digits (`Ada Lovelace` → `ada`); the Admin can change it in their profile. The browser's time zone is used for the Admin and the first team (UTC if it sends none). |
| Q7 | (2026-11-07, PLAN-001 S3; approved by the user) How is the CSRF token made and checked? | A signed double-submit token: HMAC-SHA256 of the session id under `SESSION_SECRET` (SPEC-004 §7), so nothing is stored and a token is good for one session only. The `surface_csrf` cookie carries it (`SameSite=Lax`, `Secure` on https, not `HttpOnly`, so the page can read it); the client copies it into `X-CSRF-Token`. Checked in constant time on every cookie-authenticated unsafe method (§6.1). A refusal is `403` with its own code, `CSRF_INVALID`, not `FORBIDDEN`: the sync client retries a `403` from mutate with backoff, so a stale token must be told apart, refreshed through `GET /auth/session` and resent once (session D's request). |
| Q8 | (2026-11-07, PLAN-001 S3; approved by the user) What exactly does the lockout count? | Failed sign-ins per account (the email as typed, normalised, whether or not an account has it, so a lockout reveals nothing) and per IP address (an IPv6 client by its /64, which it usually holds whole). 5 failures in 15 minutes lock an account, and 20 lock an address, until the oldest of them leaves the window. The address limit is higher by the user's decision (2026-11-07): a small team often signs in from one office or proxy address, where 5 typos would lock everyone out; the account limit is what protects a password. An attempt is recorded under a per-key lock **before** the password is checked, and stays as a failure unless the sign-in succeeds, so guesses sent at once count too: at most 5 are checked. Attempts while locked are refused without checking the password and aren't counted, so guessing can't keep an account locked. A successful sign-in clears the account's count (not the address's). Stored in `auth_attempts`, so restarts and replicas share it. |
| Q9 | (2026-11-07, PLAN-001 S3, session C's request; approved by the user) How does the web app learn who is signed in? | `GET /auth/session` → `{ ok: true, result: { userId, workspaceId } }` (the ids it opens its replica with), or `401`. |
| Q10 | (2026-11-07, PLAN-001 S3; approved by the user) What protects sign-in itself, which has no session to check CSRF against? | A browser `Origin` other than `SURFACE_URL`'s is refused with `403` and logged at `warn` (SPEC-004 E3), so another site can't sign the browser into an account of its choosing. Requests without `Origin` (scripts, older browsers on same-origin requests) are allowed. |
| Q11 | (2026-11-07, PLAN-001 S3 review; approved by the user) What happens to the session a browser already had when it signs in again? | It ends: the row is deleted and its sockets close with `4001`, so it doesn't linger in the sessions list (§3.5) and no socket goes on as whoever signed in before. The browser's other tabs see that `4001`; the client then calls `GET /auth/session`, and if someone is signed in (the new cookie) it reconnects instead of going to `/login`. |
