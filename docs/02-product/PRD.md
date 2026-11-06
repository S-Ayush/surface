# Surface: Product Requirements Document (PRD)

Status: **Draft v0.1**  ·  Date: 2026-11-06  ·  Inputs: [`VISION.md`](../01-vision/VISION.md), [`linear-product-map.md`](../00-research/linear-product-map.md), [`METHODOLOGY.md`](../METHODOLOGY.md)
Next: Domain model (`03-domain/`), then feature specs (`06-specs/`).

---

## 1. Purpose

This PRD defines **what Surface 1.0 must do**: every capability, its release tier, its priority, and the milestone that delivers it. It also sets non-functional requirements and how we measure success. It does not cover *how* (that is in the architecture docs and specs).

### 1.1 How to read this document

**Tiers**
| Tier | Meaning |
|---|---|
| **v1** | Part of Surface 1.0 (milestones M0–M7) |
| **v2** | Planned right after 1.0 |
| **Later** | Wanted eventually; not scheduled |
| **Never** | Explicitly out of scope (see VISION §6) |

**Priority within v1:** **Must** (1.0 cannot ship without it) · **Should** (expected; can slip to 1.x) · **Could** (only if cheap).

**IDs:** `FR-<AREA>-<NN>` for functional requirements and `NFR-<NN>` for non-functional ones. Specs and tests reference these IDs.

---

## 2. Product summary

Surface is a self-hosted, Docker-deployed, local-first issue and project tracker for small teams. It takes Linear's model (teams, issues, workflows, cycles, projects, initiatives, views) and makes every interaction instant: each client holds the whole workspace and syncs changes in real time. It is free, has no commercial tier, and ships no built-in AI. External AI clients can work with it through a two-tool MCP server.

---

## 3. Personas

| Persona | Who | Needs most |
|---|---|---|
| **Iris, Engineer (IC)** | Spends the day in code and checks Surface 10–30× a day | Find "my work" instantly, update status by keyboard, low notification noise |
| **Leo, Eng/Product lead** | Plans cycles and runs 1–3 projects | Cycle planning, project progress, weekly updates, a backlog that stays clean |
| **Dana, Designer / non-engineer** | Contributes to projects and files requests to other teams | A simple UI, documents, filing issues into another team's triage |
| **Omar, Operator** | The engineer who installed Surface on the company VM | 15-minute setup, backups, painless upgrades, nothing to babysit |
| **An AI client (via MCP)** | Claude Code or Cursor, acting for Iris or Leo | Discover operations, run them safely, get small and precise responses |

---

## 4. Key user journeys

| # | Journey | Covered by |
|---|---|---|
| J1 | **First run:** Omar runs `docker compose up`, opens the URL, creates the admin account and workspace, creates the first team, and invites colleagues by link, all within 15 minutes | FR-OPS, FR-AUTH, FR-TEAM |
| J2 | **Daily IC loop:** Iris opens Surface, goes to My Issues, opens an issue, moves it to In Progress, comments, then marks it done, using only the keyboard | FR-ISS, FR-VIEW, FR-NAV |
| J3 | **Cycle planning:** Leo reviews the backlog, drags issues into the next cycle, checks the load, and the cycle starts automatically on Monday. Unfinished work rolls over. | FR-CYC, FR-VIEW |
| J4 | **Project tracking:** Leo creates a project with milestones, links issues, and posts a weekly update with a health status. Stakeholders read it. | FR-PROJ, FR-UPD |
| J5 | **Cross-team request:** Dana files an issue to the Platform team. It lands in Platform's Triage, where it is accepted, declined, or marked as a duplicate. | FR-TRI |
| J6 | **Staying informed:** Iris is @mentioned, sees the notification in her Inbox, replies, and snoozes another notification until tomorrow | FR-INB, FR-COL |
| J7 | **AI-assisted work:** from Claude Code, Iris says "create sub-issues for ENG-42 from this plan". The MCP server finds and runs the right operations, and the changes appear live in the app. | FR-API, FR-MCP |
| J8 | **Disaster recovery:** the VM dies. Omar restores last night's backup on a new VM and the team keeps working. | FR-OPS |

---

## 5. Functional requirements

### 5.1 Installation & operations: `FR-OPS` (M0, M7)

| ID | Requirement | Tier | Pri | M |
|---|---|---|---|---|
| FR-OPS-01 | An official Docker image plus a `docker-compose.yml` that runs the app, PostgreSQL, and a backup job. Runs on a single Linux VM. | v1 | Must | M0 |
| FR-OPS-02 | All configuration through a `.env` file (base URL, secrets, SMTP, upload limit, MCP toggle). A documented `.env.example`. | v1 | Must | M0 |
| FR-OPS-03 | Database migrations run automatically and safely on startup. Upgrading = change the image tag and restart. | v1 | Must | M0 |
| FR-OPS-04 | Health endpoints (`/healthz` liveness, `/readyz` readiness) for Docker health checks | v1 | Must | M0 |
| FR-OPS-05 | Scheduled backups (daily by default) of the database and uploads to a mounted volume, with configurable retention (default 14) | v1 | Must | M7 |
| FR-OPS-06 | A documented, tested restore procedure (`surface restore <file>` CLI) onto a fresh VM | v1 | Must | M7 |
| FR-OPS-07 | Accepts an external `DATABASE_URL` (e.g. a free managed Postgres) instead of the bundled DB | v1 | Should | M0 |
| FR-OPS-08 | Admin "System" page showing version, DB status, SMTP status (with a test email), backup status, and storage usage | v1 | Should | M7 |
| FR-OPS-09 | **No telemetry and no phone-home.** Surface makes no outbound calls except SMTP. | v1 | Must | M0 |
| FR-OPS-10 | Uploaded files stored on a Docker volume | v1 | Must | M1 |
| FR-OPS-11 | S3-compatible object storage option for uploads | v2 | — | — |
| FR-OPS-12 | Helm chart / Kubernetes support | Later | — | — |

### 5.2 Authentication & accounts: `FR-AUTH` (M0)

| ID | Requirement | Tier | Pri | M |
|---|---|---|---|---|
| FR-AUTH-01 | **First-run setup** creates the workspace and the first Admin account. It works without SMTP. | v1 | Must | M0 |
| FR-AUTH-02 | Email + password login (argon2id hashing, minimum length 10, breached-password check *Later*) | v1 | Must | M0 |
| FR-AUTH-03 | **Magic link** login by email, available when SMTP is configured. Links are single-use and expire after 15 minutes. | v1 | Must | M0 |
| FR-AUTH-04 | Password reset by email. Without SMTP, an Admin can generate a one-time reset link. | v1 | Must | M0 |
| FR-AUTH-05 | Invites: by email (needs SMTP) or a copyable invite link with an expiry. An Admin can revoke pending invites. | v1 | Must | M0 |
| FR-AUTH-06 | Signup policy: invite-only (default) or open to an allowed email domain | v1 | Should | M7 |
| FR-AUTH-07 | Sessions in secure, HTTP-only cookies. Users can see and revoke their own sessions. | v1 | Must | M0 |
| FR-AUTH-08 | Login rate limiting and temporary lockout after repeated failures | v1 | Must | M0 |
| FR-AUTH-09 | Profile: name, display name, avatar, timezone | v1 | Must | M0 |
| FR-AUTH-10 | Preferences: theme (light / dark / system), default home view, font size | v1 | Should | M2 |
| FR-AUTH-11 | Two-factor authentication (TOTP) | v2 | — | — |
| FR-AUTH-12 | SSO / SAML / OIDC / SCIM | **Never** | — | — |

**Key acceptance criteria**
- A fresh install with no SMTP configured can complete J1 using invite links and password login.
- Magic-link and password-reset options are hidden when SMTP is not configured.
- A deactivated user's sessions end immediately, and they cannot log in again.

### 5.3 Members & roles: `FR-MEM` (M0, M7)

| ID | Requirement | Tier | Pri | M |
|---|---|---|---|---|
| FR-MEM-01 | Two roles: **Admin** (workspace settings, members, teams, API/MCP settings, audit log) and **Member** (everything else) | v1 | Must | M0 |
| FR-MEM-02 | Admins can promote or demote members. There must always be at least one Admin. | v1 | Must | M0 |
| FR-MEM-03 | Deactivate and reactivate users. Their issues and history keep their name, and they stop counting in assignee pickers. | v1 | Must | M7 |
| FR-MEM-04 | Members directory with each member's teams and their assigned and created issues | v1 | Should | M2 |
| FR-MEM-05 | Guest role | **Never** | — | — |

### 5.4 Teams: `FR-TEAM` (M0, M1, M7)

| ID | Requirement | Tier | Pri | M |
|---|---|---|---|---|
| FR-TEAM-01 | Create a team with a name, a **key** (2–5 uppercase letters, unique, used in issue IDs), an icon or color, and a timezone | v1 | Must | M0 |
| FR-TEAM-02 | Any member can create a team. (Restricting this to Admins: v2 setting.) | v1 | Must | M0 |
| FR-TEAM-03 | Members can join and leave public teams. Admins can add or remove anyone. | v1 | Must | M0 |
| FR-TEAM-04 | Each team has its own workflow statuses, labels, estimate scale, cycles, triage, and templates | v1 | Must | M1 |
| FR-TEAM-05 | **Private teams:** the team, its issues, projects (where it is the only team), views, and docs are visible and **synced only to members**. Only members or Admins can add people. | v1 | Must | M7 |
| FR-TEAM-06 | Convert a team between public and private. Going private requires confirmation and shows who will lose access. | v1 | Should | M7 |
| FR-TEAM-07 | Team home page: members, pinned docs and links, shortcuts to Triage / Issues / Cycles / Projects / Views | v1 | Should | M4 |
| FR-TEAM-08 | Change a team's key (old issue IDs keep redirecting) | v2 | — | — |
| FR-TEAM-09 | Archive (retire) a team as read-only, and restore it | v2 | — | — |
| FR-TEAM-10 | Sub-teams | **Never** | — | — |

**Key acceptance criteria**
- A non-member's client never receives any record from a private team. This is verified at the sync layer, not just hidden in the UI.
- Removing a user from a private team removes that team's data from their client's local store on the next sync.

### 5.5 Workflow, labels & estimates: `FR-WF` (M1)

| ID | Requirement | Tier | Pri | M |
|---|---|---|---|---|
| FR-WF-01 | Fixed status **categories** in this order: Triage → Backlog → Unstarted → Started → Completed → Canceled, plus a system **Duplicate** status | v1 | Must | M1 |
| FR-WF-02 | Default workflow for new teams: Backlog · Todo · In Progress · In Review · Done · Canceled (Duplicate is system-managed) | v1 | Must | M1 |
| FR-WF-03 | Add, rename, recolor, describe, and reorder statuses *within* their category. Each category keeps at least one status. | v1 | Must | M1 |
| FR-WF-04 | Deleting a status requires choosing a replacement for its issues | v1 | Must | M1 |
| FR-WF-05 | A default status for new issues (from Backlog or Unstarted) | v1 | Must | M1 |
| FR-WF-06 | **Labels:** workspace-level and team-level, with name, color, and description. **Label groups** allow one label per group on an issue. | v1 | Must | M1 |
| FR-WF-07 | Estimate scale per team: off / linear (1–5) / exponential (1, 2, 4, 8, 16) / fibonacci (1, 2, 3, 5, 8) / t-shirt (XS–XL). Defaults to off. | v1 | Must | M1 |
| FR-WF-08 | Auto-close issues not updated in N months (optional, per team) | v1 | Could | M4 |
| FR-WF-09 | Auto-archive completed and canceled issues after N months (default 6) | v1 | Should | M4 |
| FR-WF-10 | Parent/sub-issue status automation: the parent auto-completes when all its sub-issues are done (optional per team) | v1 | Should | M3 |

### 5.6 Issues: `FR-ISS` (M1)

| ID | Requirement | Tier | Pri | M |
|---|---|---|---|---|
| FR-ISS-01 | An issue belongs to exactly **one team**. Its ID is `KEY-N`, sequential per team and **never reused**. | v1 | Must | M1 |
| FR-ISS-02 | Create from anywhere with `C` (modal composer). Title required. Description is rich text. Every property can be set inline. "Create more" keeps the composer open. | v1 | Must | M1 |
| FR-ISS-03 | Properties: status, priority (None / Urgent / High / Medium / Low), assignee (one), labels, estimate, due date, project, project milestone, cycle, parent | v1 | Must | M1 |
| FR-ISS-04 | Inline editing on the issue page and from list or board rows, with keyboard shortcuts for every property (`S` status, `P` priority, `A` assignee, `I` assign me, `L` labels, `E` estimate…) | v1 | Must | M1 |
| FR-ISS-05 | **Activity history**: every property change with actor and time. Changes made within 3 minutes of creation are folded into creation. | v1 | Must | M1 |
| FR-ISS-06 | Attachments (upload, paste, drag) with a configurable size limit (default 25 MB). Image previews. | v1 | Must | M1 |
| FR-ISS-07 | Links: paste a URL to attach it with a title | v1 | Should | M1 |
| FR-ISS-08 | Copy issue ID, URL, or "ID + title" (`Cmd+.` and variants) | v1 | Must | M1 |
| FR-ISS-09 | Move an issue to another team: it gets a new ID, the old ID redirects, status maps to the closest status, and team labels are dropped (with a warning) | v1 | Should | M3 |
| FR-ISS-10 | **Soft delete** to a Trash that can be restored for 30 days, then purged. Archived issues are searchable and can be restored. | v1 | Must | M1 |
| FR-ISS-11 | Local unsaved draft that survives navigating away | v1 | Must | M1 |
| FR-ISS-12 | Saved drafts synced across devices | v2 | — | — |
| FR-ISS-13 | Pre-filled create URL (`/new?team=ENG&title=…&priority=high&assignee=me`) | v1 | Could | M2 |
| FR-ISS-14 | Description version history with restore | v2 | — | — |
| FR-ISS-15 | Recurring issues | v2 | — | — |
| FR-ISS-16 | SLA timers | Later | — | — |
| FR-ISS-17 | Copy git branch name (useful even without the integration) | v1 | Could | M1 |

**Key acceptance criteria**
- Creating an issue by keyboard (`C`, type a title, `Cmd+Enter`) takes under 2 s end to end, and the issue appears on teammates' screens within 150 ms on a LAN.
- Issue IDs stay unique and gap-tolerant even when many clients create issues concurrently. The server assigns the number, and the client shows a temporary placeholder until it does.
- Every property change can be undone with `Cmd+Z` (see FR-NAV-06).

### 5.7 Hierarchy & relations: `FR-REL` (M3)

| ID | Requirement | Tier | Pri | M |
|---|---|---|---|---|
| FR-REL-01 | Sub-issues, one level deep in the UI (nesting allowed in data). Sub-issues inherit team, project, priority, and cycle (if active) on creation. | v1 | Must | M3 |
| FR-REL-02 | Create several sub-issues at once by pasting a list of lines | v1 | Should | M3 |
| FR-REL-03 | Set or remove a parent on existing issues, including in bulk | v1 | Must | M3 |
| FR-REL-04 | Relations: **blocks / blocked by**, **related**, **duplicate of** | v1 | Must | M3 |
| FR-REL-05 | Marking an issue as a duplicate moves it to the Duplicate status and links it to the canonical issue | v1 | Must | M3 |
| FR-REL-06 | Blocked issues show a visible indicator in lists and boards | v1 | Should | M3 |
| FR-REL-07 | Convert an issue with sub-issues into a project | v2 | — | — |

### 5.8 Views, layout & filtering: `FR-VIEW` (M2)

| ID | Requirement | Tier | Pri | M |
|---|---|---|---|---|
| FR-VIEW-01 | Default team views: **All issues, Active** (Unstarted + Started), **Backlog** | v1 | Must | M2 |
| FR-VIEW-02 | **List** and **Board** layouts (`Cmd+B` toggles between them) | v1 | Must | M1/M2 |
| FR-VIEW-03 | **Grouping** by status, assignee, priority, project, cycle, label (group), or none. **Sub-grouping** (board swimlanes). | v1 | Must | M2 |
| FR-VIEW-04 | **Ordering** by manual, priority, status, created, updated, due date, or estimate, with reverse. Manual order is shared by everyone. | v1 | Must | M2 |
| FR-VIEW-05 | Dragging between groups updates the property (e.g. status column → status) | v1 | Must | M2 |
| FR-VIEW-06 | **Display properties**: toggle which properties appear on rows and cards | v1 | Must | M2 |
| FR-VIEW-07 | Toggles: show sub-issues, show empty groups, completed issues (all / past week / month / none) | v1 | Must | M2 |
| FR-VIEW-08 | **Filters** on every issue property plus creator, created/updated/completed dates (relative), "has blockers", and "no X". Options are *is*, *is not*, *any of*. | v1 | Must | M2 |
| FR-VIEW-09 | Filters are encoded in the URL (shareable, temporary) | v1 | Should | M2 |
| FR-VIEW-10 | **Custom views** (issue and project views): name, icon, filters, and display settings. Scoped to the workspace or a team. Has an owner. Editable by anyone with access. | v1 | Must | M2 |
| FR-VIEW-11 | Personal display overrides versus "set as default for everyone" | v1 | Should | M2 |
| FR-VIEW-12 | Subscribe to a view: get notified when an issue enters it | v2 | — | — |
| FR-VIEW-13 | **Timeline** layout for projects (and initiatives), zoomable from week to year | v1 | Should | M5 |
| FR-VIEW-14 | Views of 10k+ issues scroll at 60 fps (virtualized) | v1 | Must | M2 |

### 5.9 Navigation, search & commands: `FR-NAV` (M0–M2)

| ID | Requirement | Tier | Pri | M |
|---|---|---|---|---|
| FR-NAV-01 | **Sidebar**: Inbox, My Issues, Views, Projects, Initiatives, Favorites, Your teams (Triage / Issues / Cycles / Projects / Views), Trash | v1 | Must | M0–M2 |
| FR-NAV-02 | **Command menu (`Cmd+K`)**: every action from the Operation Registry, aware of the current context (selected issues, current page) | v1 | Must | M0+ |
| FR-NAV-03 | **Keyboard shortcuts** for navigation (`G I`, `G M`, `G T`, `G A`, `G B`, `J/K`…) and actions, plus a `?` help overlay listing all of them | v1 | Must | M1 |
| FR-NAV-04 | **Global search** (`/` or `Cmd+K`) over issues (ID, title, description, comments), projects, documents, and people. Fuzzy and instant, run on the local replica. Can include archived items. | v1 | Must | M2 |
| FR-NAV-05 | **Multi-select** (`X`, shift-click, `Cmd+A`) and **bulk edit** of any property | v1 | Must | M2 |
| FR-NAV-06 | **Undo / redo** (`Cmd+Z` / `Cmd+Shift+Z`) for property changes, moves, and deletes | v1 | Must | M2 |
| FR-NAV-07 | **Peek** an issue (`Space`) without leaving the list | v1 | Should | M2 |
| FR-NAV-08 | **Favorites**: star issues, views, projects, cycles, and docs into the sidebar | v1 | Should | M2 |
| FR-NAV-09 | Favorites folders | v2 | — | — |
| FR-NAV-10 | **My Issues**: tabs for Assigned, Created, and Subscribed | v1 | Must | M2 |
| FR-NAV-11 | Context menu (right-click) on any item, mirroring the command menu | v1 | Should | M2 |

### 5.10 Cycles: `FR-CYC` (M3)

| ID | Requirement | Tier | Pri | M |
|---|---|---|---|---|
| FR-CYC-01 | Enable cycles per team, with duration (1–8 weeks), start weekday, cooldown (0–2 weeks), and number of upcoming cycles (1–15). Cycles start at 00:00 in the team's timezone. | v1 | Must | M3 |
| FR-CYC-02 | Cycles are created automatically and numbered. They can be renamed and given a description. | v1 | Must | M3 |
| FR-CYC-03 | **Rollover**: unfinished issues move to the next cycle when a cycle ends | v1 | Must | M3 |
| FR-CYC-04 | Auto-add (optional): started or completed issues with no cycle join the current cycle. Adding a backlog issue to a cycle moves it to the first Unstarted status. | v1 | Should | M3 |
| FR-CYC-05 | Cycle pages for the current, upcoming, and past cycles: issues plus a progress summary (scope, started, completed) | v1 | Must | M3 |
| FR-CYC-06 | **Cycle graph** (burn-up of scope versus completed), with a frozen snapshot when the cycle ends | v1 | Should | M3 |
| FR-CYC-07 | Adjust the dates of a future cycle | v1 | Could | M3 |
| FR-CYC-08 | Capacity estimate from the average of the last 3 cycles | v2 | — | — |
| FR-CYC-09 | Start the next cycle early ("Start cycle today") | v2 | — | — |
| FR-CYC-10 | Calendar (ICS) feed of cycles | Later | — | — |

**Key acceptance criteria**
- Cycle transitions run from the background job queue and are idempotent: a server restart during a transition never double-rolls issues.
- Rollover is recorded in each issue's history.

### 5.11 Projects & milestones: `FR-PROJ` (M3)

| ID | Requirement | Tier | Pri | M |
|---|---|---|---|---|
| FR-PROJ-01 | Project: name, icon/color, summary, rich-text overview, status (Backlog / Planned / In Progress / Paused / Completed / Canceled), priority, **one lead**, members, **teams (one lead team)**, start date, target date | v1 | Must | M3 |
| FR-PROJ-02 | An issue belongs to **at most one** project. The project's issues view supports all view capabilities. | v1 | Must | M3 |
| FR-PROJ-03 | **Milestones**: ordered, with name, target date, and description. Issues can be assigned to a milestone. Progress is shown per milestone. | v1 | Must | M3 |
| FR-PROJ-04 | Project progress: % complete by issue count (or estimate), with a progress graph | v1 | Must | M3 |
| FR-PROJ-05 | Project resources: links and documents attached to the project | v1 | Should | M4 |
| FR-PROJ-06 | Projects list page and project views (filter, group, order) | v1 | Must | M3 |
| FR-PROJ-07 | Soft delete with 30-day restore | v1 | Must | M3 |
| FR-PROJ-08 | Date precision (month / quarter / half / year) | v2 | — | — |
| FR-PROJ-09 | Project labels, project dependencies, project templates | v2 | — | — |

### 5.12 Initiatives & updates: `FR-INI`, `FR-UPD` (M5)

| ID | Requirement | Tier | Pri | M |
|---|---|---|---|---|
| FR-INI-01 | Initiative: name, description, **owner**, status (Planned / Active / Completed), target date, and a set of projects | v1 | Must | M5 |
| FR-INI-02 | Initiatives list and page with project roll-up (progress and health per project) | v1 | Must | M5 |
| FR-INI-03 | Sub-initiatives | v2 | — | — |
| FR-UPD-01 | **Project updates**: health (On track / At risk / Off track) plus rich text, posted by the lead or any member. Shown on the project and in a history tab. | v1 | Must | M5 |
| FR-UPD-02 | Auto-appended progress summary since the last update (progress change, target date change, milestones completed) | v1 | Should | M5 |
| FR-UPD-03 | Comments and reactions on updates | v1 | Should | M5 |
| FR-UPD-04 | Update reminders to project leads on a workspace schedule (e.g. weekly on Friday), through the Inbox (and email if SMTP is configured) | v1 | Should | M5 |
| FR-UPD-05 | Initiative updates with health | v1 | Could | M5 |
| FR-UPD-06 | "Update missing" staleness indicator | v2 | — | — |

### 5.13 Collaboration: `FR-COL` (M1, M4)

| ID | Requirement | Tier | Pri | M |
|---|---|---|---|---|
| FR-COL-01 | **Comments** on issues: rich text, one level of threaded replies, edit and delete your own (marked as edited) | v1 | Must | M1 |
| FR-COL-02 | **Reactions** (emoji) on comments | v1 | Should | M1 |
| FR-COL-03 | **@mentions** of people. Inline references to issues (`ENG-123`), projects, and docs, rendered as live chips. | v1 | Must | M4 |
| FR-COL-04 | **Rich editor** with Markdown shortcuts, slash commands, headings, lists, checklists, code blocks with syntax highlighting, quotes, images, and links | v1 | Must | M1 |
| FR-COL-05 | Tables and collapsible sections in the editor | v2 | — | — |
| FR-COL-06 | **Documents**: rich-text docs at workspace, team, or project level. Searchable, can be favorited, with soft delete. | v1 | Must | M4 |
| FR-COL-07 | **Issue templates** per team (pre-filled properties and description) | v1 | Should | M4 |
| FR-COL-08 | Document templates | v2 | — | — |
| FR-COL-09 | Real-time collaborative co-editing of descriptions and docs (CRDT) | v2 | — | — |
| FR-COL-10 | v1 concurrent-edit safety: show presence ("Leo is editing") and detect description and doc conflicts, offering merge or overwrite | v1 | Must | M4 |

### 5.14 Inbox & notifications: `FR-INB` (M4)

| ID | Requirement | Tier | Pri | M |
|---|---|---|---|---|
| FR-INB-01 | **Auto-subscribe** to issues you create, are assigned, are mentioned in, or comment on. Manual subscribe and unsubscribe. | v1 | Must | M4 |
| FR-INB-02 | Inbox notifications for: assignment, mention, comment on a subscribed issue, status change to Completed or Canceled, new issue in your triage, and project updates for projects you lead or belong to | v1 | Must | M4 |
| FR-INB-03 | Inbox actions: open, read/unread (`U`), snooze (`H`), delete, mark all read. Keyboard navigation. | v1 | Must | M4 |
| FR-INB-04 | Notifications are grouped per issue, so several events on the same issue collapse into one row | v1 | Should | M4 |
| FR-INB-05 | Per-user notification settings: which events notify, plus an email digest (when SMTP is configured) | v1 | Should | M4 |
| FR-INB-06 | Browser and desktop notifications (PWA) | v2 | — | — |
| FR-INB-07 | Reminders ("remind me about this issue") | v2 | — | — |
| FR-INB-08 | A "priority" Inbox tab | v2 | — | — |

### 5.15 Triage: `FR-TRI` (M4)

| ID | Requirement | Tier | Pri | M |
|---|---|---|---|---|
| FR-TRI-01 | Enable Triage per team. Issues created by **non-members** of the team land in Triage. | v1 | Must | M4 |
| FR-TRI-02 | Triage actions: **Accept** (`1`, to the default status), **Decline** (`2`, to Canceled with an optional comment), **Duplicate** (`3`), **Snooze** (`H`) | v1 | Must | M4 |
| FR-TRI-03 | Triage issues are hidden from normal views unless a view filters for them | v1 | Must | M4 |
| FR-TRI-04 | Triage responsibility: chosen members are notified of new triage issues | v1 | Should | M4 |
| FR-TRI-05 | Triage rules (if property matches X, then set team / assignee / label / priority) | v2 | — | — |
| FR-TRI-06 | Rotating triage duty | v2 | — | — |
| FR-TRI-07 | Intake forms or email-to-issue | Later | — | — |

### 5.16 Insights: `FR-INS`

| ID | Requirement | Tier | Pri | M |
|---|---|---|---|---|
| FR-INS-01 | Cycle graph and project progress graph (see FR-CYC-06 and FR-PROJ-04) | v1 | Should | M3 |
| FR-INS-02 | Insights: charts of issue counts and estimates over time, sliced by any property | v2 | — | — |
| FR-INS-03 | Dashboards | Later | — | — |
| FR-INS-04 | Pulse (activity feed digest) | Later | — | — |

### 5.17 Platform: API, webhooks, MCP, import/export: `FR-API`, `FR-MCP` (M0, M6)

| ID | Requirement | Tier | Pri | M |
|---|---|---|---|---|
| FR-API-01 | **Operation Registry:** every query and mutation is defined once (name, description, keywords, schemas, permission, examples, handler) and powers the UI, `Cmd+K`, the API, and MCP | v1 | Must | M0 |
| FR-API-02 | Internal HTTP API `POST /api/ops/:name`, plus a generated OpenAPI document | v1 | Must | M6 |
| FR-API-03 | **Personal API keys**: create, name, scope (read / read-write, optionally per team, optional `allow-destructive`), last-used time, revoke | v1 | Must | M6 |
| FR-API-04 | **Outgoing webhooks** (Admin): choose events (issue, comment, project, cycle, project update), HMAC-signed payloads with previous values, retries with backoff, delivery log | v1 | Should | M6 |
| FR-API-05 | **CSV import** of issues into a team, with field mapping | v1 | Should | M6 |
| FR-API-06 | **Export**: issues and projects as CSV, plus a full workspace JSON export | v1 | Must | M6 |
| FR-API-07 | Importers from Jira, GitHub Issues, Linear | Later | — | — |
| FR-MCP-01 | MCP endpoint `/mcp` (Streamable HTTP), authenticated with a personal API key, enabled or disabled by an Admin | v1 | Must | M6 |
| FR-MCP-02 | Tool **`search_operations`**: query, domain, kind, limit → top operations with compact schemas and examples | v1 | Must | M6 |
| FR-MCP-03 | Tool **`execute_operation`**: operation + input + fields → result, or a structured, correctable error | v1 | Must | M6 |
| FR-MCP-04 | Changes made through MCP are attributed in history and the audit log as "via MCP" | v1 | Must | M6 |
| FR-MCP-05 | Operation design rules (readable references, bulk operations, filters, aggregates, `fields`) are enforced by a registry lint in CI | v1 | Must | M6 |
| FR-MCP-06 | JMESPath `select`, `dryRun`, MCP resources | v2 | — | — |

Detailed design: [`04-architecture/mcp-design.md`](../04-architecture/mcp-design.md).

### 5.18 Administration & audit: `FR-ADM` (M7)

| ID | Requirement | Tier | Pri | M |
|---|---|---|---|---|
| FR-ADM-01 | Workspace settings: name, logo, URL, signup policy, default team settings | v1 | Must | M7 |
| FR-ADM-02 | **Audit log** (Admin): logins, failed logins, role changes, invites, member deactivation, team privacy changes, API key create/revoke, webhook changes, MCP mutations. Filterable, retained 1 year. | v1 | Must | M7 |
| FR-ADM-03 | Trash: restore or permanently delete soft-deleted issues, projects, and docs (Admins can purge) | v1 | Must | M7 |

### 5.19 Explicitly out of scope

Never: billing, plans, or licensing · multi-workspace · SSO/SAML/OIDC/SCIM · guests · sub-teams · built-in AI or agents · a third-party app marketplace or OAuth app directory.
Later: GitHub / Slack / Microsoft Teams integrations · native mobile apps · Kubernetes.

---

## 6. Non-functional requirements

### 6.1 Performance (the core promise)
| ID | Requirement |
|---|---|
| NFR-01 | Local interactions (open issue, change property, switch view, filter) take **p95 < 50 ms**, and opening any issue **< 100 ms**, on a mid-range laptop at the reference scale (NFR-10) |
| NFR-02 | A change appears on other clients within **< 150 ms p95** on the same network |
| NFR-03 | Cold start with a warm local cache: **< 1.5 s** to interactive. First-ever bootstrap at reference scale: **< 10 s**. |
| NFR-04 | List and board scroll at 60 fps with 10k visible issues |
| NFR-05 | Search by identifier, title, label, project, or person returns in < 50 ms locally (works offline). Full-text results (descriptions, comments, docs) arrive in < 300 ms from the server on a LAN. |

### 6.2 Sync, offline & data integrity
| ID | Requirement |
|---|---|
| NFR-06 | **Offline:** all metadata (every list, board, view, and filter) plus cached content stay readable offline. Edits made offline queue up and apply on reconnect. Uncached content shows "available when online". An offline indicator is shown. |
| NFR-07 | **Conflicts:** the server orders all changes (`lastSyncId`). Property edits are last-writer-wins *per field*. Rich text uses conflict detection (FR-COL-10). |
| NFR-08 | A server-rejected change rolls back on the client and shows a clear message |
| NFR-09 | No acknowledged write is lost: Postgres durability, plus daily backups (FR-OPS-05) |

### 6.3 Scale envelope
| ID | Requirement |
|---|---|
| NFR-10 | **Reference scale** (performance is guaranteed up to this; no hard cap above it): 50 active users, 20 teams, 100,000 issues, 500,000 comments and history entries, 1,000 projects |
| NFR-11 | **Stress scale** (must work, with degraded performance allowed): 2× the reference scale |
| NFR-12 | Minimum VM: 2 vCPU, 2 GB RAM, 20 GB disk for the reference scale (app + Postgres) |

### 6.4 Security & privacy
| ID | Requirement |
|---|---|
| NFR-13 | argon2id passwords, secure HTTP-only SameSite cookies, CSRF protection, a strict CSP, and rate limits on auth, API, and MCP |
| NFR-14 | Private-team isolation is enforced at the sync and API layers and covered by automated tests |
| NFR-15 | Upload validation (size, type sniffing). Uploads are served with safe content-disposition. |
| NFR-16 | No telemetry, analytics, or external calls (except SMTP). No secrets in logs. |
| NFR-17 | HTTPS is expected via a reverse proxy. The docs include a ready Caddy or Traefik example. |

### 6.5 Usability, accessibility & compatibility
| ID | Requirement |
|---|---|
| NFR-18 | Every action is reachable by keyboard and listed in `Cmd+K` |
| NFR-19 | WCAG 2.1 AA for core flows (focus management, contrast, screen-reader labels on pickers) |
| NFR-20 | Latest 2 versions of Chrome, Edge, Firefox, and Safari. Desktop-first, and responsive down to 375 px for reading, commenting, and triage. |
| NFR-21 | Light and dark themes. English UI only in v1, with dates and times localised to the user's timezone. |

### 6.6 Operability
| ID | Requirement |
|---|---|
| NFR-22 | Fresh VM to first issue in **< 15 min** by following the README |
| NFR-23 | Upgrades between consecutive minor versions need no manual steps |
| NFR-24 | Structured JSON logs to stdout. An optional Prometheus `/metrics` endpoint. |

---

## 7. Success metrics

| Metric | Target | How we measure |
|---|---|---|
| Interaction latency p95 | < 50 ms | In-app performance marks + Playwright perf suite in CI |
| Sync latency p95 | < 150 ms (LAN) | Two-client e2e benchmark |
| Time to first issue (install) | < 15 min | Scripted install test on a clean VM, every release |
| Dogfooding | 100% of Surface's own work tracked in Surface from M1 | — |
| Daily active use | The whole team uses it daily from M4 | Server-side count, local only, never sent anywhere |
| MCP task success | ≥ 90% on the golden eval set | Agent eval suite |
| Ops burden | < 1 h per month | Operator log |

---

## 8. Release plan

| Release | Milestones | Audience | Gate |
|---|---|---|---|
| **Alpha** | M0–M1 | The core builders (dogfooding) | J1 and J2 work. Sync is stable for a week of daily use. |
| **Beta** | M2–M4 | The whole team | J3, J5, and J6 work. No data-loss bugs for 2 weeks. Performance NFRs are met. |
| **1.0** | M5–M7 | The whole team, plus any self-hoster | All v1 **Must** items done. J1–J8 pass as e2e tests. The backup/restore drill passes. |
| **1.x / 2.0** | v2 items | — | Re-prioritised after the 1.0 retro |

---

## 9. Assumptions, risks & dependencies

| # | Item | Mitigation |
|---|---|---|
| R1 | **Building our own sync engine** is the hardest and riskiest piece | Build it first (M0). Write a dedicated sync test suite (concurrency, offline, rejection, reconnect gaps). Keep the protocol small. |
| R2 | The metadata replica may stress low-end devices at large scale | Content is lazy by design (ADR-0002). Measure the eager size and memory at the reference and stress scales from M1. |
| R3 | Concurrent rich-text edits without a CRDT in v1 | Conflict detection plus presence (FR-COL-10). A CRDT is planned for v2. |
| R4 | No SMTP on many self-hosted installs | Every flow has a no-SMTP path (invite links, admin reset links) |
| R5 | MCP quality depends on how well operations are designed | Registry lint, search-quality tests, and agent evals in CI |
| A1 | The team runs Surface behind a reverse proxy with HTTPS | Documented example configs |

---

## 10. Open questions

| # | Question | Proposed default |
|---|---|---|
| Q1 | Real-time co-editing (CRDT) in v1 instead of conflict detection? | No: v2 (FR-COL-09) |
| Q2 | S3-compatible upload storage in v1? | No: Docker volume in v1, S3 in v2 |
| Q3 | Email notification digest in v1? | Yes, as a *Should*, only when SMTP is configured |
| Q4 | Should team creation be Admin-only? | No: any member, Linear-like (a setting in v2) |
| Q5 | Default estimate scale for new teams? | Off |
| Q6 | Installable PWA in v1? | Could: a basic manifest, no push notifications |

---

## 11. Traceability

Every spec in `06-specs/` lists the `FR-*` and `NFR-*` IDs it implements. Every acceptance criterion maps to a test. A requirement is "done" when its spec is Accepted and its tests pass in CI.
