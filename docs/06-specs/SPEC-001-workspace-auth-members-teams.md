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
   `Open https://surface.example.com/setup?token=XXXX-XXXX to finish setup`. Alternatively, the operator sets `SURFACE_SETUP_TOKEN`.
2. Every route redirects to `/setup` until setup is complete. `/setup` without a valid token shows *"Find the setup link in the server logs"*.
3. **Step 1, Workspace:** workspace name.
4. **Step 2, Admin account:** name, email, password (twice).
5. **Step 3, First team:** team name. The key is auto-suggested (e.g. "Engineering" → `ENG`) and editable.
6. Submit. In one transaction the server creates the Workspace, the Admin user, the Team (with default statuses), the TeamMembership, and the seed labels. The setup token is invalidated, a session is created, and the user is redirected to the team's issues page.

Keyboard: `Enter` advances each step. `Esc` does nothing (setup can't be skipped).

### 3.2 Login
- `/login` shows email and password, plus a **"Email me a login link"** button (only when SMTP is configured).
- Password login: on success, create a session and redirect to `?next=` or home. On failure show the generic *"Email or password is incorrect"*.
- Magic link: `POST /auth/magic-link {email}` **always** answers *"If an account exists, we sent a link"*, so it can't be used to discover accounts. The link `/auth/magic?token=…` creates a session.

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
| User | `role`, `active = true`, `passwordHash`, `timezone` |
| Session 🔒 | `tokenHash`, `userAgent`, `ip`, `lastUsedAt`, `expiresAt` (30-day sliding) |
| Invite 🔒 | Adds **`teamIds uuid[]`** (an addition to domain-model §4.16) |
| MagicLinkToken 🔒, PasswordResetToken 🔒 | 15 minutes / 1 hour, single-use |
| SetupState 🔒 | **New:** `tokenHash`, `completedAt`. A singleton. |
| Team, TeamMembership | As in the domain model |
| WorkflowStatus | **Seeded per team:** Triage (triage) · Backlog (backlog, *default*) · Todo (unstarted) · In Progress (started) · In Review (started) · Done (completed) · Canceled (canceled) · Duplicate (duplicate, system) |
| Label | **Seeded at setup:** workspace labels Bug (red), Feature (purple), Improvement (blue) |

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
| Route | Purpose |
|---|---|
| `GET /setup/status` · `POST /setup` | Setup state and completion (needs the token) |
| `POST /auth/login` | `{email, password}` → sets the session cookie |
| `POST /auth/logout` | Ends the current session |
| `POST /auth/magic-link` · `GET /auth/magic?token=` | Request and consume a magic link |
| `POST /auth/forgot` · `POST /auth/reset` | Request a reset; reset with `{token, password}` |
| `GET /invite/:token` · `POST /invite/:token/accept` | Show and accept an invite |
| `GET /auth/capabilities` | `{ smtp: bool, setupComplete: bool }`, so the UI can show or hide options |

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
| `team.create` | m | any | `{name, key?, icon?, color?, timezone?}` → seeds statuses, adds the creator |
| `team.update` | m | team member, 🛡 | name, icon, color, timezone |
| `team.join` / `team.leave` | m | any (public) / member | |
| `team.addMember` / `team.removeMember` | m | team member, 🛡 | `removeMember` is flagged `destructive` for API keys |
| `team.suggestKey` | q | any | `{name}` → `{key}` |

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
| E11 | Team key collides, or is reserved or invalid | Inline error, plus the next suggestion |
| E12 | The last member leaves a team | Allowed (the team is public). The team stays and can be joined. |
| E13 | Login attempts exceed the rate limit | 429 with a "Try again in N minutes" message. An audit entry is added (in M7). |
| E14 | The session expires while the app is open | The next request or socket gets 401, and the app redirects to `/login?next=<current>`. Queued offline mutations are kept until the same user logs in again. |

## 9. Acceptance criteria

| AC | Criterion | Test |
|---|---|---|
| AC-1 | On a fresh install the setup token appears in the logs. `/setup` without the token cannot complete. | e2e |
| AC-2 | Setup creates the workspace, Admin, first team with 8 seeded statuses (Backlog default), membership, and 3 workspace labels in one transaction. Killing the server mid-setup leaves no partial data. | integration |
| AC-3 | With `SMTP_URL` unset: the login page shows no magic-link option, invites return a copyable link, and the Admin can generate a working reset link. J1 completes. | e2e |
| AC-4 | With SMTP set (a MailHog-style test container): magic-link login, password reset, and emailed invites work end to end. | e2e |
| AC-5 | Wrong-password and unknown-email login responses are identical in body and status, and their timing is within ±50 ms. | integration |
| AC-6 | After 5 failed logins in 15 minutes for an account, a 6th correct login is refused until the lockout ends. | integration |
| AC-7 | Session cookies are `HttpOnly; Secure; SameSite=Lax`, and only the hash of the token is stored in the DB. | integration |
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
