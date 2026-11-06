# Linear Product Map (reference for Surface)

> Research snapshot, 2026-11-06. Source: linear.app/docs, linear.app/method, and community reverse-engineering of Linear's sync engine.
> Purpose: a reference for **what** a Linear-class product does. It does not say what Surface must copy. Surface's scope is set in `01-vision/`.

---

## 1. Conceptual model (the spine)

```
Workspace
 ├── Members (Owner / Admin / Team owner / Member / Guest)   ── also Agents (non-billable "users")
 ├── Teams  (key e.g. ENG; may nest: parent → sub-teams; may be private)
 │    ├── Workflow (ordered statuses grouped in fixed categories)
 │    ├── Triage (team inbox + rules + rotation)
 │    ├── Cycles (auto-repeating time boxes)
 │    ├── Labels / Label groups, Templates, Recurring issues
 │    └── Issues  (ENG-123)
 │          ├── sub-issues (parent/child), relations (blocks / related / duplicate)
 │          ├── comments, reactions, attachments, activity history
 │          └── → Project (max 1) → Milestone, → Cycle (max 1)
 ├── Projects (P-ENG-12; lead team + contributing teams; milestones; updates; documents)
 ├── Initiatives (I-12; nest via sub-initiatives; group projects; owner; health)
 ├── Documents, Customers & Customer requests, Releases & pipelines
 └── Views (saved filter + display config over issues / projects / initiatives)
```

Key rules:
- An issue belongs to **exactly one team**. It needs a title and a status. Its ID is `TEAMKEY-<sequence>`.
- An issue is in **at most one project** and **at most one cycle**. To split work across projects, use sub-issues.
- Teams own workflow, cycles, triage, and labels. Sub-teams inherit cycles, and can inherit workflow and labels.
- Views never change data. They filter and display it.

## 2. Issues

| Property | Behaviour |
|---|---|
| Status | Team-defined statuses inside **fixed categories**: Triage → Backlog → Unstarted → Started → Completed → Canceled (+ system "Duplicate"). Reorder within a category only. Each category needs at least one status. There is a default status for new issues. |
| Priority | No priority / Urgent / High / Medium / Low |
| Estimate | Optional per team. Scales include exponential, fibonacci, linear, and t-shirt (XS=1, S=2, M=3, L=5, XL=8, XXL=13, XXXL=21). |
| Assignee | Single human owner. An **agent delegate** is a separate field. |
| Labels | Team- or workspace-scoped. Label groups (pick one within a group). |
| Due date, SLA | SLA is driven by priority and rules. |
| Relations | blocks / blocked by, related, duplicate of (marking a duplicate moves attachments and customer requests to the canonical issue). |
| Parent / sub-issues | Sub-issues inherit team, priority, and project (cycle conditionally). Optional automations: parent auto-closes when all children are done, and children close with the parent. "Convert to project" is available. |

Other behaviours:
- **Creation paths:** `C` shortcut, templates (`Alt+C`), URL pre-fill (`/new?title=&status=&priority=&assignee=me&labels=…`), create from text selection, email intake, recurring issues, integrations, API.
- **Drafts:** local temporary draft, plus saved drafts that sync across clients (kept 6 months).
- **History:** activity feed of property changes. Edits within the first 3 minutes of creation are folded into creation. Description version history can be restored.
- **Move between teams:** the issue gets a new ID and old IDs keep redirecting. Status maps to the closest status in the new team. Team labels are dropped. Relations and priority are kept.
- **Lifecycle:** auto-close stale issues, auto-archive (archive is automatic only), and soft delete with 30-day restore.

## 3. Cycles
- Per team. Length is 1 to 8 weeks, with a start weekday and optional cooldown. Cycles start at 00:00 in the team's timezone and up to 15 future cycles are pre-created.
- **Rollover:** unfinished issues move to the next cycle automatically.
- **Auto-add:** started or completed issues with no cycle are added to the current cycle. Moving an issue into a cycle promotes it from backlog to Todo.
- **Capacity dial:** based on the velocity of the last 3 cycles, or on team size if there is no history.
- **Cycle graph:** scope versus completed over time. A frozen snapshot is kept when the cycle completes.
- Calendar feed (ICS). Sub-teams inherit the parent's cycle schedule.

## 4. Projects & Initiatives
- **Project:** name, status (team or workspace project statuses), priority, lead (one person), members, teams (one lead team), start and target dates at variable precision (day / month / quarter / half / year), milestones, labels, dependencies, documents and links, templates.
- **Project updates:** a health value (On track / At risk / Off track) plus rich text. Auto-generated progress details are added when progress changes by more than 2%. Reminders follow a schedule with follow-up nudges. A project is flagged "Update missing" when an update is overdue. Updates sync to Slack.
- **Initiative:** owner, lead team, target date, a set of projects, sub-initiatives, and health derived from the latest update. Active Projects rolls up projects from sub-initiatives.
- **Timeline:** a Gantt-style view of projects and initiatives, zoomable from week to year.

## 5. Intake
- **Triage:** a per-team inbox. Actions are Accept (`1`), Decline (`2`, sets Canceled), Duplicate (`3`), and Snooze (`H`). An optional gate requires a priority before an issue leaves triage. Triage rules match on filters and set team, status, assignee, label, project, or priority. Triage responsibility rotates, and can follow an on-call schedule. AI suggestions are available.
- **Asks:** request intake from Slack, email, and web forms for people without accounts.
- **Customers & requests:** a customer is an org identified by domain. A request links a quoted piece of feedback to an issue or project. Customers carry revenue, tier, size, and status. Requests can be marked "important". Issues can be filtered and sorted by customer count or revenue.

## 6. Working surfaces
- **Views:** issue, project, and initiative views, scoped to workspace, team, project, or "all teams". They have filters, an owner, sharing, favorites, and subscriptions (notify when an issue enters the view or is completed).
- **Display options:** layout (list / board / timeline), grouping and sub-grouping (swimlanes), ordering (manual order is global, the rest are sortable), and visible properties. Settings can be personal or saved as the workspace default. Dragging an issue between groups changes its property.
- **Inbox:** notifications for subscribed items (you are auto-subscribed when you create, are assigned, or are mentioned). Priority tab, read/unread, snooze, reminders, cap of 2,000.
- **Command menu `Cmd/Ctrl+K`, global search, keyboard-first everything:** `G I` inbox, `G T` triage, `G A` active, `G B` backlog, `A` assign, `I` assign me, `X` select, `Cmd+B` list/board, `Shift+V` display options, `J/K` move up/down.
- **My Issues** (with Focus grouping), **Favorites** (folders), **Documents**, a rich Markdown **Editor**, **Pulse** (activity feed), **Team pages**.

## 7. Insights
- Dashboards and Insights: charts over issue data, sliced by any property including assignee or agent delegate. Project graph and cycle graph.

## 8. Code & delivery
- **Git (GitHub / GitLab):** a branch name copied from the issue, issue ID in the PR title or branch, and magic words (`fixes`, `closes`, `resolves`… versus non-closing words `ref`, `part of`, `related to`). PR events (draft, open, review, ready, merged) move the issue's status per team, with per-branch regex rules. Linkback comments are posted on the PR.
- **Reviews (diffs):** review PRs inside the app, synced with GitHub.
- **Releases:** CI pipelines (continuous or scheduled), path filters, issues attached by scanning commits, release automations, generated release notes and changelog.

## 9. Platform
- **GraphQL API:** the same API the apps use. Personal API keys with scopes (read / write / admin / create issues / comments), restrictable to specific teams. OAuth apps.
- **Webhooks:** fire on Issues, Comments, Attachments, Documents, Reactions, Projects, Project updates, Cycles, Labels, Users, and SLAs. The payload carries the full object and the previous values of changed fields.
- **Integrations:** Slack, GitHub, GitLab, Sentry, Zendesk, Intercom, Front, Figma, Notion, Zapier, and others.
- **Importers:** Jira, GitHub Issues, Asana, Shortcut, plus a CLI importer. CSV export.
- **MCP server** for AI tools.

## 10. Agents & AI
- Agents are workspace "users" (not billed). They can be assigned or delegated work and @mentioned, and they comment. Admins scope which teams an agent can access. Workspace and team **guidance** is written in Markdown.
- Also: Triage Intelligence (suggested properties and duplicates), "Write with agent" drafting of updates, generated release notes, PR guides.

## 11. Administration & security
- **Roles:** Workspace owner (Enterprise), Admin, Team owner, Member, Guest (sees only the teams they were explicitly added to; no initiatives, workspace views, or customers).
- Private teams, issue sharing outside a team, SAML/SSO, SCIM, login methods, audit log, third-party app approvals, billing plans and seat limits, AI credits, data export.
- **Lifecycle everywhere:** archive versus soft delete (30 days) versus retire (read-only team).

## 12. How Linear is built (engineering signals)
Sources: community reverse-engineering (wzhudev/reverse-linear-sync-engine) and talks by Linear's CTO. These are **not official docs**.
- **Local-first sync engine.** The client holds a replica of the workspace in **IndexedDB** and an in-memory **observable object graph** (MobX). Reads are local, so the UI is instant.
- **Bootstrap:** full (streamed NDJSON), partial (by load strategy), or local (IndexedDB, then deltas). Models load lazily on access.
- **Writes are transactions:** an optimistic local apply, a persisted queue, GraphQL mutations sent in batches, and a rollback if the server rejects them.
- **The server is the authority.** A global, monotonically increasing `lastSyncId` orders all changes. **Delta packets** (insert / update / archive / delete / unarchive / sync-group changes) are broadcast over WebSocket. The client rebases its pending transactions on top of them.
- **Sync groups** (user, team, role) decide which models a client receives. This is the permission boundary.
- **Offline:** queued transactions are replayed on reconnect. Undo and redo are built on inverse transactions.

## 13. The Linear Method (how they build)
- Set product direction, then set useful goals, then prioritise enablers and blockers, then **scope projects down**.
- Build momentum with cycles. **Write issues, not user stories:** short and concrete, quote customers directly, everyone writes their own issues.
- The spec and discussion phase happens at the project level, then execution is fast. Build with users. Launch, and keep launching. Build in public.
