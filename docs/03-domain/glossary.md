# Surface: Glossary

Status: **Draft v0.1** · Date: 2026-11-06

One definition per term. Docs, code, UI copy, and MCP operation names all use these terms exactly.

| Term | Definition |
|---|---|
| **Workspace** | The single top-level container of one Surface install (one company). There is exactly one per install. |
| **User** | A person with an account. Role is **Admin** or **Member**. A user is either **active** or **deactivated**. |
| **Admin** | A user who can manage workspace settings, members, API/MCP settings, webhooks, the audit log, and the trash. |
| **Member** | A regular user. Can do everything except Admin functions. |
| **Team** | A group of users that owns issues, a workflow, labels, cycles, triage, and templates. Identified by a **team key**. |
| **Team key** | 2–5 uppercase letters (e.g. `ENG`), unique in the workspace, used as the prefix of issue identifiers. |
| **Private team** | A team whose data is visible and synced only to its members. |
| **Team membership** | The link between a user and a team. |
| **Issue** | The unit of work. Belongs to exactly one team and has a title and a status. |
| **Issue number** | A per-team sequential integer assigned by the server, never reused. |
| **Identifier** | The human-readable issue reference, `<TEAM KEY>-<number>` (e.g. `ENG-123`). Old identifiers redirect after a team move. |
| **Workflow** | A team's ordered set of workflow statuses. |
| **Workflow status** (status) | A named state an issue can be in (e.g. "In Review"). It always belongs to one status category. |
| **Status category** | A fixed classification of statuses, in this order: **Triage, Backlog, Unstarted, Started, Completed, Canceled**, plus the system category **Duplicate**. Automations depend on categories, never on status names. |
| **Active issue** | An issue whose status is in the Unstarted or Started category. |
| **Closed issue** | An issue whose status is in the Completed, Canceled, or Duplicate category. |
| **Priority** | One of No priority (0), Urgent (1), High (2), Medium (3), Low (4). |
| **Estimate** | An integer number of points on the team's estimate scale (off, linear, exponential, fibonacci, or t-shirt). |
| **Label** | A tag on issues. It is a **workspace label** (usable by every team) or a **team label** (usable only on that team's issues). |
| **Label group** | A label that contains child labels. An issue can carry at most one label from each group. |
| **Sub-issue / Parent** | An issue can have one parent issue. The children of a parent are its sub-issues. |
| **Relation** | A typed link between two issues: **blocks** (with its inverse, *blocked by*), **related**, or **duplicate of**. |
| **Comment** | A rich-text message on an issue or a project update. It can have one level of replies. |
| **Reaction** | An emoji a user adds to a comment or project update. |
| **Attachment** | A file or link attached to an issue. |
| **History** (activity) | The record of every change to an issue: who (or which API key / MCP), what, and when. |
| **Cycle** | A team's time box (1–8 weeks), created automatically on a repeating schedule. Its state is **upcoming**, **active**, or **completed**. |
| **Cooldown** | An optional gap between cycles (0–2 weeks). No issue can be planned into a cooldown. |
| **Rollover** | Moving the unfinished issues of a completed cycle into the next cycle. |
| **Project** | A set of issues working toward one outcome, with a lead, teams, dates, milestones, and updates. An issue is in at most one project. |
| **Lead team** | The team that owns a project. A project has one lead team and can have other contributing teams. |
| **Project lead** | The one user responsible for a project. |
| **Milestone** | An ordered stage within a project, optionally with a target date. Issues of the project can be assigned to it. |
| **Project update** | A post on a project with a **health** value (On track / At risk / Off track) and rich text. |
| **Health** | The latest stated condition of a project or initiative: On track, At risk, Off track, or none. |
| **Initiative** | A strategic goal that groups projects. It has an owner, a status, and a target date. |
| **Document** | A rich-text page scoped to the workspace, a team, or a project. |
| **Template** | A pre-filled issue (properties plus description) defined per team. |
| **View** | A saved combination of filters and display settings over issues or projects. It is **built-in** (e.g. Active) or **custom**. |
| **Filter** | A condition that restricts which records a view shows. |
| **Display settings** | Layout, grouping, sub-grouping, ordering, visible properties, and toggles of a view. |
| **Manual order** | A user-arranged, workspace-wide ordering of issues (and projects), stored as a fractional sort key. |
| **Favorite** | A user's personal shortcut to an issue, view, project, cycle, document, or initiative, shown in the sidebar. |
| **Subscription** | A user following an issue or project, which makes them receive notifications about it. |
| **Notification** | An Inbox entry generated for one user by an event on something they subscribe to. |
| **Inbox** | A user's list of notifications. |
| **Snooze** | Hiding a notification (or a triage issue) until a given time. |
| **Triage** | A team's intake queue for issues created by non-members. Issues are reviewed there before entering the workflow. |
| **Accept / Decline** | Triage actions. Accept moves the issue to the team's default status. Decline moves it to Canceled. |
| **Archive** | Automatic hiding of long-closed issues, projects, and cycles. Archived items stay searchable and can be restored. |
| **Trash** (soft delete) | The state of a deleted item. It can be restored for 30 days, after which it is **purged** (permanently removed). |
| **Operation** | A named, typed action in the Operation Registry (e.g. `issue.update`). It is the only way data changes, whether from the UI, the API, or MCP. |
| **Operation Registry** | The single catalog of all operations, with their schemas, permissions, keywords, and examples. |
| **Transaction** | A client-side batch of one or more operations, applied optimistically and then confirmed or rejected by the server. |
| **Sync group** | A visibility scope that decides which clients receive a record: `workspace`, `team:<id>` (private teams), or `user:<id>`. |
| **lastSyncId** | The global, monotonically increasing number the server assigns to every committed change. It orders all changes. |
| **Delta** | A change broadcast from the server to clients: insert, update, archive, unarchive, delete, or sync-group change. |
| **Replica** | The full copy of a client's visible workspace data, kept in IndexedDB and in memory. |
| **API key** | A personal secret token used for the API and MCP. Its scope is read or read-write, optionally limited to certain teams, with an optional `allow-destructive` flag. |
| **Webhook** | An Admin-configured HTTPS endpoint that receives signed event payloads. |
| **Audit log** | An Admin-only record of security-relevant events. |
| **Actor** | Who performed a change: a user (UI), a user via an API key, a user via MCP, or the system (automations). |
