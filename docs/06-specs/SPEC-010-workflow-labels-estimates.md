# SPEC-010: Workflow statuses, labels & estimates

Status: **Draft** · Milestone: **M1** · Date: 2026-11-12 (review round 1 applied 2026-11-12; Linear-parity pass applied 2026-11-12)
Implements: FR-WF-01, 02, 03, 04, 05, 06, 07 · FR-TEAM-04 (workflow, labels and estimate scale per team) · NFR-02, 08, 14, 18
Depends on: SPEC-001 (teams, seeded statuses and labels), SPEC-002 (sync), SPEC-003 (Operation Registry), SPEC-005 (shell, settings, command menu)
Related: [domain-model §4.3–4.5, §6](../03-domain/domain-model.md) · [state-machines §1](../03-domain/state-machines.md) · [permissions §3.2, §3.5, §5](../03-domain/permissions.md) · SPEC-011 (Issues core) · SPEC-015 (lifecycle rules, team Automations page)

---

## 1. Problem & goal

Every team gets a fixed workflow at creation (SPEC-001 §4), but nobody can change it, and nobody can manage labels or turn on estimates. Teams work differently: one wants an "In Review" step, another wants size labels, a third estimates in t-shirt sizes. This spec lets a team shape its workflow, labels and estimate scale from Settings, by keyboard or mouse, and keeps the rules that automations depend on (INV-04, INV-05, INV-07) true after every change.

The behaviour follows Linear's team settings wherever the PRD allows (Decisions D5–D14).

## 2. Scope

**In scope**

- Statuses: create, rename, recolor, describe and reorder within their category, delete (only when no issue uses it), and set the team's default status.
- Labels: workspace labels and team labels, label groups one level deep (single-select or multi-select), create, edit, move into or out of a group, move a team label to the workspace, archive and unarchive, delete.
- Estimate settings per team: off, linear, exponential, fibonacci or t-shirt, the "Extended" and "Allow zero estimates" options, and "Count unestimated issues as 1 point".
- Settings screens, command-menu entries and operations (web, HTTP API and MCP through the registry).
- The domain rules that SPEC-011 (issues) needs: which estimate values are valid, how one-label-per-exclusive-group is kept, and what deleting a label does to issues.

**Out of scope**

- Applying statuses, labels or estimates to issues, and the pickers on issue rows (SPEC-011, SPEC-012).
- Triage on/off and triage rules (M4). The Triage status exists already (INV-04). Its row is hidden in the settings UI until triage is on (M4).
- Auto-close and auto-archive settings: they live on the team "Automations" page, owned by SPEC-015. Parent auto-complete (FR-WF-10: M3), cycle settings and cycle use of the "count unestimated as 1" option (M3), templates (M4).
- Moving a label from the workspace to a team (D11), free (hex) colors (v2 or later), a status "Issue ordering" setting.
- Moving issues to another status when deleting a status. Move them first with the issue's own status edit or bulk edit (M2), then delete (D5).

## 3. User flows

Every flow below works by keyboard alone (NFR-18). The creates and team settings are also command-menu entries (§7.3).

### 3.1 Edit the workflow (`/settings/teams/:key/workflow`)

1. The page lists the team's statuses grouped by category, in the order Backlog, Unstarted, Started, Completed, Canceled, Duplicate. Triage is listed first only when triage is on (M4), so it is hidden in M1. Each row shows the category icon tinted with the status color, name, the number of issues in it (once SPEC-011 lands), the description after "·", and a **Default** badge after the name on the default status. Hover shows "View issues" (opens the team's issue list filtered to the status, once SPEC-012 lands) and a "…" menu.
2. **Add:** each editable category header (not Duplicate, not Triage) has a "+". It opens an inline form at the end of the category: color, name (required), description, Cancel / Create. `Enter` creates, `Esc` cancels. The other "+" buttons are disabled while a form is open.
3. **Edit:** `Enter` or the row menu "Edit" opens the same inline form on the row (Cancel / Save). The category cannot change (Q3). **Duplicate** is system-managed: its row has no menu and no "+", and it can't be renamed, recolored or deleted.
4. **Reorder:** drag within the category, or `Alt+↑` / `Alt+↓` on a focused row (moves one position). A move never leaves the category.
5. **Make default:** the row menu "Make default" on a Backlog or Unstarted status, or `Mod+K` → "Set default status…" in the team's context, which picks the status in a sub-page (§7.3).
6. **Delete:** `Mod+Backspace` on a focused row (not while typing in its edit fields), or the row menu "Delete". The delete is refused while any issue uses the status, archived and recently deleted issues included. A toast says: `Can't delete the "Canceled" status. It has 2 issues. Move them to another status first.` (when some of them are archived or recently deleted, the toast adds " (1 archived or recently deleted)" after the count). The default status, the last status of a category, Triage and Duplicate are refused too (§6 errors). The replica answers first, so no request is sent when it already shows an issue. When the status is empty, a dialog asks "Delete the "In Review" status? This can't be undone." (Cancel / Delete), because a delete can't be undone (design-system §4). There is no replacement picker and no bulk move (D5).

### 3.2 Manage labels (`/settings/teams/:key/labels`, `/settings/labels`)

1. The team page is a table of the team's labels and groups, sorted by name, with a filter-by-name field. Columns: **Name** (color dot), **Description** (editable in place, placeholder "Add description…"), **Used in** (teams whose issues carry it), **Issues** (count), **Last applied** (day), **Created**. Groups expand to show their labels. "New group" and "New label" buttons add an inline row (color dot, "Label name", "Add description…"). A footer line says "N labels inherited from workspace", linking to them. The workspace page (`/settings/labels`) shows workspace labels the same way and is open to every member (D9). Archived labels are in a collapsed "Archived" section at the end.
2. **Row menu:** "Edit label name" (`E`), "Move to workspace…" (team labels and groups only), "View labeled issues" (opens the issue list filtered to the label, once SPEC-012 lands), "Archive…", "Delete". A group's row also has "Add label to group" (not offered on archived groups) and "Group type: Single / Multiple" (D10).
3. **Typing a group:** in the "New label" row, `Group/Label` or `Group:Label` creates the group (single-select) when it does not exist, and the label inside it. If the group exists, the label goes into it. A name has no `/` or `:` of its own (§4.2).
4. **Move into or out of a group:** the edit form has a Group field (live groups in the same scope, or none). Issues that already carry two labels of an exclusive group keep both until someone edits their labels (§4.2, Q6).
5. **Move to workspace:** moves a team label (or a whole group with its labels) to the workspace, so every team can use it. Issues keep it. The dialog says "This label will be available to every team. This can't be undone." Moving a label back to a team is not offered (D11).
6. **Archive:** the dialog says: "This label will no longer be available to apply to issues. Issues with the label already applied will remain unchanged." Unarchive is in the same menu on archived rows.
7. **Delete:** `Mod+Backspace` (not while typing) or the row menu. The dialog says: `Delete label "<name>"? It will be removed from N issues. This can't be undone.` N counts the issues the actor can see. A group can be deleted only when it is empty.

### 3.3 Choose the estimate settings (`/settings/teams/:key/estimates`)

A select "Issue estimation": Not in use · Exponential (1, 2, 4, 8, 16 Points) · Fibonacci (1, 2, 3, 5, 8 Points) · Linear (1, 2, 3, 4, 5 Points) · T-Shirt (XS, S, M, L, XL). Below it, when a scale is on, three toggles:

- **Extended** adds two larger values (§4.3).
- **Allow zero estimates** makes 0 a real value, different from no estimate.
- **Count unestimated issues as 1 point** (on by default). Only cycle statistics use it (M3); M1 stores it.

Each change saves at once. Turning estimates off hides them everywhere for that team, and the stored values are kept (Q8).

## 4. Domain changes

No new entity. The tables and synced models exist since PLAN-001 S1 (`workflow_statuses`, `labels`, `teams.default_status_id`, `teams.estimate_scale`). New columns: `labels.exclusive`, and three estimate settings on `teams` (§4.5). SPEC-015's migration adds the team's auto-archive and auto-close columns, including `teams.auto_close_status_id`, a reference to one of the team's Canceled statuses (SPEC-015 §4.9). Issues carry labels as `labelIds` (SPEC-011), not as IssueLabel rows.

### 4.1 WorkflowStatus

| Rule | Detail |
|---|---|
| Name | 1–50 characters, trimmed, unique within the team (case-insensitive) |
| Description | 0–255 characters; empty means none |
| Color | One of the 12 palette hues (`COLOR_HUES`, design-system §2.2). Default per category, as seeded by SPEC-001: Triage orange, Backlog gray, Unstarted gray, Started yellow, Completed blue, Canceled gray, Duplicate gray. |
| Category | Set at creation and never changed (Q3). New statuses go in Backlog, Unstarted, Started, Completed or Canceled only. |
| Position | A fractional key, ordered within the category with byte order (`COLLATE "C"`). Reordering writes only the moved status. The key function is `fractionalKeyBetween(a, b)` in `packages/domain`, written in-house (no new dependency), and used by both the client's `optimistic` and the server. |
| Triage | Exactly one (INV-04). Can be renamed, recolored and described through the operation (the settings UI shows it from M4). Can't be created, deleted or moved. |
| Duplicate | Exactly one (INV-04). System-managed: can't be created, renamed, recolored, described, moved or deleted (D6). |
| Delete | A hard delete (Q1): the row goes, clients get a `D` delta, and the name is free again. Issue history keeps the status's name, because SPEC-011 stores a name with every reference in a history entry. |
| Limit | At most 50 statuses per team (Q10) |

**Deleting a status** (FR-WF-04, D5) is refused while any issue uses it, whatever the issue's state: live, archived or recently deleted. An issue that has been permanently deleted no longer counts. The check is `statusDeleteProblem` in `packages/domain` (a pure function of the workflow and the issue counts). It refuses, in this order: Triage and Duplicate, the team's default status, the last status of its category, and a status with issues. Nothing moves and nothing cascades: the delete either removes an empty status or changes nothing. All the issues of a status are in its team, so anyone who can see the status can see the right count: it reveals nothing about private teams (§5).

### 4.2 Label

| Rule | Detail |
|---|---|
| Scope | `teamId` null = workspace label (usable on every team's issues), else a team label. A team label can move to the workspace (D11); a workspace label never moves to a team. |
| Name | 1–50 characters (limit not observable in Linear; kept, Q10), trimmed. No `/` and no `:`: they separate a group from a label (Q4). Not a reserved word: `assignee`, `cycle`, `effort`, `estimate`, `hours`, `priority`, `project`, `state`, `status`, compared case-insensitively (they are filter keywords). Unique within its scope and group, archived labels included (case-insensitive), so unarchiving never collides. A team label may share a name with a workspace label; pickers show the scope, and `LabelRef` tries the team first (SPEC-003 §4). |
| Description | 0–255 characters |
| Group | `isGroup` is fixed at creation. A group has no parent. A label's group must be a live (not archived) group in the **same scope**. Groups are never applied to issues (INV-07). |
| Group type | `exclusive` (boolean, default true, meaningful only on groups). **Single** (`exclusive = true`): an issue holds at most one label of the group. **Multiple**: no limit. A group can be switched either way at any time (D10). |
| One label per exclusive group | Enforced **when an issue's labels are written** (Q6): adding a label of an exclusive group G removes the issue's other labels of G in the same write (SPEC-011). Moving a label into a group, or switching a group to single, never reads issues. An issue that already carries two labels of G keeps both until its labels are next written; the picker shows the clash ("Only one Size label can be set. Choosing one replaces the others."). |
| Order | By name, case-insensitive. No manual order. |
| Archive | Sets `archivedAt` (Q13), a synced field once archive state travels on the wire (§12). An archived label stays in the replica and on every issue that has it, shows on those issues, can be renamed and recolored, can't be newly added (`INVALID_INPUT` "That label is archived. Unarchive it in Settings → Labels."), and is left out of pickers except as a selected value. Unarchive clears `archivedAt`. |
| Archive a group | Archives the group and all its labels in one transaction. Unarchiving a group unarchives it and all its labels (Q16). While a group is archived, nobody can create a label in it, move a label into it, or unarchive one of its labels (`INVALID_INPUT` "The Size group is archived. Unarchive the group first."). |
| Replacement removes an archived label | If an issue carries an archived label of an exclusive group G and someone adds another label of G, the archived one is removed and can't be re-added. This is the one-per-group rule working as intended; SPEC-011 history records the removal. |
| Move to workspace | `label.moveToWorkspace` sets `teamId` to null on a team label, or on a team group and all its labels (archived ones included) in one transaction. A label inside a group can't move alone (`INVALID_INPUT` "Move the Size group instead, or take the label out of its group first."). The name must be free in the workspace scope (`CONFLICT` on `name`: "A workspace label named Bug already exists. Rename this label first."), and the workspace limits apply (Q10). No issue is read or written. Its sync effect is in §5. |
| Delete | A hard delete: the label's id is removed from `labelIds` on every issue that has it (live, archived and recently deleted), then the label row is deleted, in one transaction. It is a settings change: no history entry, no `updatedAt` change, no lifecycle change (archived issues stay archived, recently deleted issues stay there), no per-issue event. A settings cascade may write archived issues even though they are read-only for people (SPEC-015 §4.3). History entries that already name the label keep its name. A group can be deleted only when it has no labels, archived ones included (Linear's behaviour for a group with labels is not observable; kept). |
| Limits | At most 500 labels per scope and 250 per group, archived labels included (Q10) |

### 4.3 Estimate settings

Estimates are stored as integers (domain-model §4.6). The settings decide which values can be **written** and how they are shown.

| Scale | Values (stored → shown) | Extended adds |
|---|---|---|
| `off` | none: estimates are hidden and can't be set | n/a |
| `linear` | 1, 2, 3, 4, 5 | 6, 7 |
| `exponential` | 1, 2, 4, 8, 16 | 32, 64 |
| `fibonacci` | 1, 2, 3, 5, 8 | 13, 21 |
| `tshirt` | 1 → XS, 2 → S, 3 → M, 5 → L, 8 → XL | 13 → XXL, 21 → XXXL |

**Allow zero estimates** adds the value 0 on any scale, shown as "0". Zero is a real estimate, different from no estimate (`null`). **Count unestimated issues as 1 point** is stored as a boolean (default true) and read only by M3 cycle statistics.

Changing the settings never rewrites issues (Q8). A stored value that isn't allowed by the new settings is shown as its number, styled as off-scale, until someone changes it. Pickers offer only the allowed values. `packages/domain` gains `estimateValues(config)`, `isValidEstimate(config, value)` and `formatEstimate(config, value)`, where `config` is `{ scale, extended, allowZero }`.

### 4.4 Invariants and concurrency

- INV-04 and INV-05 hold after every committed status operation, and after `team.setDefaultStatus`.
- INV-07 ("at most one label per group on an issue") becomes "**adding** a label of an **exclusive** group never leaves two labels of that group" (Q6, D10). The wording in domain-model changes on acceptance (§12).
- Estimates are valid **when written**; a settings change keeps stored values (Q8). domain-model §4.6 changes on acceptance (§12).

**Locks.** Mutations run `READ COMMITTED`, and the executor resolves refs before the handler (SPEC-003 §4), so a resolved row can change or vanish before the handler runs. Every handler here:
1. locks the scope row first: the team row (`FOR UPDATE`) for statuses, team labels, `team.setDefaultStatus` and `team.setEstimates`; the workspace row for workspace labels. `label.moveToWorkspace` locks the workspace row, then the team row (SPEC-011 §4.8's order). This serialises the last-in-category check (E3) and the count limits;
2. then locks the status or label rows it changes (`FOR UPDATE`), and re-reads every other ref it relies on (`before`/`after`, `group`, `defaultStatus`) with `FOR KEY SHARE`. A ref that is gone or changed in a way that breaks a rule is `CONFLICT` with the SPEC-003 §4 message.

**`status.delete`** takes the team row, then the status row `FOR UPDATE`, then checks `statusDeleteProblem` against a count of issues with that `status_id` (all lifecycle states). It locks no issue. Issue edits take `FOR KEY SHARE` on a status they newly set **before** locking the issue (SPEC-011 §4.8). So:
- An edit that took its key lock first finishes; the delete's `FOR UPDATE` waits for it, then counts the issue and refuses.
- An edit that comes later waits on the key lock, then finds the status gone: `CONFLICT`, "That status was deleted. Choose another status."
- `issues.status_id` references `workflow_statuses` with `ON DELETE RESTRICT` (SPEC-011 migration; never `CASCADE` or `SET NULL`, which would bypass `sync_log`), as a backstop. A delete that the count allowed never trips it.
- Status delete is a lock-order peer of SPEC-011 §4.8 and needs no exception: it holds no issue lock.

**`label.delete`** follows SPEC-011 §4.8's single lock order (**workspace row → team row → status and label rows → issue rows in ascending id → thread root**), taking only the part it needs: the scope row of the label, then the label row, then the issues. Issue edits take `FOR KEY SHARE` on a label they newly add **before** locking the issue. So:
- An edit that took its key lock first finishes; the cascade's `FOR UPDATE` waits for it, then rewrites that issue too.
- An edit that comes later waits on the key lock while holding no issue, then finds the label gone: `CONFLICT`, "That label was deleted. Choose another label."
- No deadlock is possible, and the set of issues to rewrite is final once the cascade holds the row.
- `labelIds` is an array with no foreign key; the explicit key lock on each newly added label gives the same guarantee.
- While a cascade holds the team row, `issue.create` in that team waits for it (it takes the team row `FOR SHARE` for its sync groups). That is part of the stall budgeted in §10.
- The rewrite uses `repo.updateWhere` with `touchUpdatedAt: false` (SPEC-011 §5.1): no history, no event, no `updatedAt` change. It also writes archived and recently deleted issues, which SPEC-011 exempts for settings cascades.

**Big rewrites.** The label-delete rewrites go through the repo's bulk path: one `UPDATE` per chunk, and `sync_log` rows inserted in chunks of at most 5,000, under the 65,535 bind-parameter limit (shared repo change, §12). The append holds the global sync lock; the budget is ≤ 2 s for 10,000 issues (§10).

### 4.5 Migration

One small migration:
- `workflow_statuses.position` gets `COLLATE "C"`, so the server's order matches the fractional keys byte for byte (and the client's comparison). `workflow_statuses.archived_at` stays unused (statuses are deleted, not archived).
- `labels.exclusive boolean not null default true`, synced.
- `teams.estimate_extended boolean not null default false`, `teams.estimate_allow_zero boolean not null default false`, `teams.estimate_count_unestimated_as_one boolean not null default true`, all synced.

The foreign key from `issues.status_id` (`ON DELETE RESTRICT`) arrives with SPEC-011's migration; `labelIds` has none (§4.4).

## 5. Sync & permissions

| Model | Sync group | Notes |
|---|---|---|
| WorkflowStatus | the team's group (`workspace`, or `team:<id>` once private teams exist in M7) | A delete is a `D` delta |
| Label (team) | the team's group | `archivedAt`, `exclusive` synced (§12). `label.moveToWorkspace` re-groups the row to `workspace` (see below). |
| Label (workspace) | `workspace` | |
| Team (`defaultStatusId`, estimate settings) | as in SPEC-001 | |
| Issue (`labelIds` rewritten by label deletes) | as in SPEC-011 | One `U` per rewritten issue |

No new sync groups. **What `label.moveToWorkspace` sends.** The repo recomputes a row's groups after an update and, if they changed, logs `D` with the old groups and then `U` with the full row and the new groups, under consecutive ids in one transaction (`apps/server/src/sync/repo.ts`, sync-protocol §6). For each moved label (a group and its labels move together, one pair each):

- **Public team (M1):** the team's group is `workspace` and a workspace label's group is `workspace`, so the groups don't change. The repo logs one `U` with the full row, now with `teamId` null. Every client already holds the row and just updates it.
- **Private team (M7):** the groups change from `team:<id>` to `workspace`. Members of the private team get the `D` and the `U` in one batch (the hub never splits the pair), so the row is present after the batch with `teamId` null. Everyone else gets only the `U`: a row they never had. They insert it like any new row (Label is an eager model, so there is nothing to hydrate), and it shows in their pickers and on the workspace labels page. No client loses the row, and no issue row is sent.

The move needs no protocol change: it uses the group-change rule that sync-protocol §6 already states, so it adds no §12 row of its own. Making a private team's label visible to everyone is the point of the move, and the confirm dialog says so (§3.2 item 5). Every operation here still has an `optimistic`, so it works offline and rolls back with a message when rejected (NFR-08). `status.list` and `label.list` are queries.

**Optimistic predictions.** Each is computed from the store alone, using the existing `store.find(model, fields)` and `store.unarchive` (SPEC-011 §6.3 and §12):
- `status.delete` checks the store for issues of the status (`store.find('Issue', {statusId})`). If there is none, it removes the status. If there is one, the prediction throws the refusal message, so nothing is queued.
- `label.delete` removes the Label row only. Issues keep the dead id in `labelIds` until the server's `U` deltas arrive; renderers and pickers skip label ids that aren't in the store (SPEC-012). `store.find` matches by equality, so it can't select issues by array membership.
- `label.archive` and `label.unarchive` on a group find the group's labels (`store.find('Label', {parentId})`) and archive or unarchive each, then the group.
- `label.moveToWorkspace` sets `teamId` to null on the label, or on the group and its labels (same lookup).
- `team.setDefaultStatus` patches `defaultStatusId` with the resolved id (never the ref text).

The labels page computes **Issues**, **Used in** and **Last applied** from the replica's issues: the count of issues carrying the label, the teams of those issues, and the latest `updatedAt` among them (an approximation of "last applied" that needs no new column; Decision D7). The pure function `labelUsage(labels, issues)` does it.

**Permissions** (extends [permissions §3.2](../03-domain/permissions.md); the permissions doc gains these rows on acceptance, §12):

Team settings (statuses, default status, team labels, estimate settings):

| Operation | Non-member (public team) | Team member | Admin |
|---|---|---|---|
| Read | ✅ | ✅ | ✅ |
| Create, edit, reorder, archive, delete; set default status and estimate settings; move a team label to the workspace | ❌ | ✅ | ✅ |

Workspace labels (every team uses them, so team membership doesn't apply): every member and Admin can read, create, edit, move between groups, archive, unarchive and delete them (D9). Linear gates this behind a Business-plan setting; Surface has no plans, so the default stays.

API keys: a key narrowed by `teamIds` acts only on those teams (permissions §3.5). It can change its teams' statuses and team labels, but any mutation of a **workspace** label, including `label.moveToWorkspace` (it creates one), is `FORBIDDEN`: "This API key is limited to some teams. Changing workspace labels needs a key for all teams." It can still read and apply workspace labels on its teams' issues.

A private team's statuses and labels are invisible to non-members: every reference to one is `NOT_FOUND`, worded as for one that doesn't exist (permissions §5). Counts returned to the actor (`removedFromIssues`) include only issues the actor can see (E7). `status.delete` counts issues in a team the actor can already see in full, so its answer depends on no invisible issue.

## 6. API (operations)

All are `defineOperation`s in `packages/operations` (`ops/status.ts`, `ops/label.ts`, and two new ops in `ops/team.ts`), reachable from the web client, `POST /api/ops/:name` and MCP.

**References.** Status operations take `team` (a `TeamRef`) because `StatusRef` resolves names within a team (SPEC-003 §4). Label operations take `team?`: a team label referenced **by name** needs `team`; without it, a name resolves among workspace labels only. A label **uuid** resolves to any label the actor can see, with or without `team` (SPEC-003 §4 change, §12). `LabelRef` also accepts `Group/Label` (spaces around `/` ignored) to pick a label inside a group (Q4). The `Group:Label` form works only in the settings "New label" row (§3.2), which turns it into operations.

| Operation | Kind | Who | Input → output and notes |
|---|---|---|---|
| `status.list` | q | can see the team | `{...listInput, team, category?}` → connection of statuses. Default order: category order, then position. `includeArchived` is accepted and ignored (statuses are never archived). |
| `status.create` | m | team member, Admin | `{id?, team, name, category, color?, description?, after?: StatusRef}` → status. `category` excludes `triage` and `duplicate`. Goes at the end of the category, or right after `after` (same category, else `INVALID_INPUT` on `after`). |
| `status.update` | m | team member, Admin | `{team, status, name?, color?, description?}` → status. No `category` (Q3). Duplicate: `INVALID_INPUT` "Duplicate is a system status and can't be changed." |
| `status.reorder` | m | team member, Admin | `{team, status, before?: StatusRef, after?: StatusRef}`, exactly one of `before` / `after`, in the same category → status. Triage and Duplicate: `INVALID_INPUT` (nothing to reorder against). |
| `status.delete` | m, destructive | team member, Admin | `{team, status}` → status. `CONFLICT` when the status has issues, is the default, is the last in its category, or is Triage or Duplicate (messages below). |
| `team.setDefaultStatus` | m | team member, Admin | `{team, status: StatusRef}` → team. Backlog or Unstarted only (INV-05), else `INVALID_INPUT`. New op, so `team.update` keeps its single "Rename team…" `ui` entry. |
| `team.setEstimates` | m | team member, Admin | `{team, scale?, extended?, allowZero?, countUnestimatedAsOne?}`, at least one field → team. Never changes an issue (Q8). |
| `label.list` | q | any | `{...listInput, team?, scope?: 'team' \| 'workspace' \| 'all' = 'all', group?: LabelRef}` → connection of labels visible to the actor, each with `teamId`, `parentId`, `isGroup`, `exclusive`, `archivedAt`. With `team`, `all` means that team's labels plus workspace labels; without it, workspace labels plus team labels of every team the actor can see. Default order: name (case-insensitive), then id. `includeArchived` from `listInput` (default false). |
| `label.create` | m | team: member, Admin · workspace: any member | `{id?, team?, name, color?, description?, isGroup?, exclusive?, group?: LabelRef}` → label. No `team` = workspace label. `exclusive` only with `isGroup`. |
| `label.update` | m | as create | `{label, team?, name?, color?, description?, exclusive?, group?: LabelRef \| null}` → label. `group: null` leaves the group. `exclusive` only on a group. Moving into a group, or switching to single, never checks issues (§4.2). |
| `label.moveToWorkspace` | m | team member, Admin (a narrowed key: `FORBIDDEN`) | `{label, team}` → label (the group's other labels move too). Row menu only, no `ui` entry. |
| `label.archive` / `label.unarchive` | m | as create | `{label, team?}` → label. A group takes its labels with it. Archiving an archived label (or unarchiving a live one) changes nothing. |
| `label.delete` | m, destructive | as create | `{label, team?}` → `{label, removedFromIssues}`. `CONFLICT` for a group that still has labels. |

The mutations with a `ui` entry are listed in §7.3; the others are reached from the settings pages and have no command-menu entry. Every operation has at least two keywords and an example that runs against the seed fixture, and passes `pnpm registry:lint` (SPEC-003 §11). Each `optimistic` predicts what §5 lists, using the same `fractionalKeyBetween` as the server.

Errors use SPEC-003's shape and name the field:
- `Can't delete the "Canceled" status. It has 2 issues. Move them to another status first.` (with " (1 archived or recently deleted)" after the count when some are)
- "Can't delete the default status. Make another status the default first."
- "This status closes stale issues. Choose another one in Settings → Automations first." (it is the team's auto-close status, SPEC-015 §4.9)
- "Every team needs at least one Started status. Add another before deleting this one."
- "A team can have at most 50 statuses. Delete one first."
- "The default status must be in Backlog or Unstarted. Choose Backlog or Todo."
- "Label names can't contain / or :. Use a group instead, like Size/Small."
- "Priority is a reserved name. Choose another label name."
- "The Size group is archived. Unarchive the group first."
- "That label is archived. Unarchive it in Settings → Labels."

## 7. UI

### 7.1 Screens

| Screen | Route | Notes |
|---|---|---|
| Team → Workflow (statuses) | `/settings/teams/:key/workflow` | §3.1. Triage row hidden until triage is on (M4); Duplicate row is marked "System". |
| Team → Labels | `/settings/teams/:key/labels` | §3.2 |
| Team → Estimates | `/settings/teams/:key/estimates` | §3.3 |
| Workspace labels | `/settings/labels` | Every member. In the settings nav under Workspace, outside the Admin-only Workspace page. |

These routes are added to SPEC-005 §3 on acceptance (§12). The team Automations page (auto-close, auto-archive) is SPEC-015's. Non-members of a public team see the team pages read-only, with a "Join the team to edit" note. Rows are a listbox (design-system List) in the `settings-row` scope (SPEC-012 §3.6): `↑`/`↓` move focus, `Enter` edits, `E` edits a label's name, `Esc` cancels, `Alt+↑`/`Alt+↓` reorders (statuses; Linear's "move one position"), `Mod+Backspace` deletes. These are Linear's keys (D14). `Mod+Backspace` is inactive while focus is in a text field (it deletes text there); this needs the per-binding "inactive while typing" flag (SPEC-005 change, §12). Deleting opens a Dialog (focus trapped, restored on close): these deletes can't be undone, so they confirm instead of using an Undo toast (design-system §4). Empty state for labels: "No team labels yet. Workspace labels are available to every team." Shortcuts are added to `docs/05-design/shortcuts.md` on acceptance.

### 7.2 States

Rendered from the replica, so no loading state after bootstrap. A rejected change rolls back and shows a toast with the server's message (NFR-08), or the client's own message for E1 and E8. Issue counts show "—" until SPEC-011 adds issues.

### 7.3 Command menu

Each entry comes from exactly one operation's `ui` field (SPEC-005 §4). Its implementation in `features/commands.ts` is one of the three kinds the menu already supports (`apps/web/src/command-menu/sources/operations.ts:24-33`): `run`, `page` (a sub-page), or `opens` (an app command registered by its feature).

| Operation | Title | Contexts | How it runs |
|---|---|---|---|
| `status.create` | "Add status…" | team | `opens: 'settings.addStatus'`, registered by the settings feature. A sub-page picks the category (Backlog, Unstarted, Started, Completed, Canceled); the command then goes to `/settings/teams/:key/workflow`, opens the inline add form in that category (as its "+" does), and focuses its name field. |
| `team.setDefaultStatus` | "Set default status…" | team | `page`: a sub-page lists the team's Backlog and Unstarted statuses; choosing one dispatches the operation. It acts on the team in context, not on a focused status row. |
| `team.setEstimates` | "Change estimate scale…" | team | `page`: a sub-page lists the scales with their values; choosing one dispatches `{ scale }`. The toggles are on the settings page only. |
| `label.create` | "Create label…" | team, global | `opens: 'settings.createLabel'`, registered by the settings feature. In team context a sub-page picks the scope ("ENG" or "Workspace"); in global context the scope is workspace. The command goes to that labels page, opens the inline "New label" row, and focuses its name field. |

Each `opens` command is registered only while the actor may run the operation in that context, so `commands.isAvailable` hides it otherwise (`operations.ts:79`). Each team-context entry gives `refs` (`{ team }`), as `checkOperationCommands` requires.

Navigation entries (not operations): "Go to workflow settings", "Go to label settings" (team); "Go to workspace labels" (global). No new `ui` context is needed.

## 8. Edge cases

| # | Case | Behaviour |
|---|---|---|
| E1 | A client queued a move of an issue into a status (offline) and someone deleted that status | The server answers `NOT_FOUND` (the status was gone before resolution) or `CONFLICT` (it went during the transaction, SPEC-003 §4). The client rolls back. When its replica has seen the status's `D` delta, it shows "That status was deleted. Choose another." (the server can't say so: a deleted status reads like one that never existed); otherwise the server's message. No silent redirect (Q2). |
| E2 | A new status or label takes the name of a deleted one | Allowed: the old row is gone. History still shows the old one's name, which it stored. |
| E3 | Two people delete the last two Started statuses at once | The team row lock serialises them. One succeeds; the other gets `CONFLICT` and rolls back. |
| E4 | `status.reorder` or `status.create` names an anchor that was deleted meanwhile | `INVALID_INPUT` on `before` / `after` (or `CONFLICT` if it vanished after resolution); the client rolls back and the row returns to where the server has it. |
| E5 | The estimate settings change while issues carry values they don't allow | Values are kept and shown off-scale (§4.3). `off` hides them; switching back shows them again. |
| E6 | A label is moved into an exclusive group, or a group is switched to single, while some issues carry two of its labels | Allowed (Q6). Those issues keep both until their labels are next written; then adding one label of the group removes the others. Nothing is read from or written to issues by the move, so nothing leaks. |
| E7 | A workspace label is deleted while issues in private teams carry it | It is removed from those issues too. `removedFromIssues` counts only issues the actor can see. |
| E8 | `status.delete` on a status that has issues | `CONFLICT` with the "It has N issues" message, and nothing changes. The client refuses from its replica without a request when it can. Archived and recently deleted issues count; permanently deleted ones don't. |
| E9 | A name matches several labels (e.g. "Small" in two groups) | `INVALID_INPUT` (ambiguous) listing the matches as `Group/Label`, e.g. "2 labels named 'Small': Size/Small, Scope/Small. Use Group/Label or the label id." (Q4) |
| E10 | A status or label is edited offline in two tabs | Per-field last-writer-wins (NFR-07). |
| E11 | A non-member of a public team sends `status.update` | `FORBIDDEN` "Only members of ENG can change its workflow. Join the team first." |
| E12 | A queued offline change adds a label that was archived meanwhile | `INVALID_INPUT` "That label is archived…", and the client rolls back. Labels the issue already had stay. |
| E13 | Someone opens a label picker on an issue that already has an archived label | The archived label shows as selected (so it can be removed) but can't be re-added once removed. |
| E14 | Someone creates a label in, or moves one into, an archived group, or unarchives a label whose group is archived | `INVALID_INPUT` "The Size group is archived. Unarchive the group first." |
| E15 | An API key limited to team ENG tries to archive a workspace label, or move a team label to the workspace | `FORBIDDEN` "This API key is limited to some teams. Changing workspace labels needs a key for all teams." |
| E16 | `status.delete` and an `issue.update` that moves another issue into that status run at once | Either the update took its key lock on the status first, and the delete waits for it, counts the issue, and refuses; or the delete wins, and the update waits and then fails with `CONFLICT`. They never deadlock (§4.4). No issue ever points at a deleted status. |
| E17 | `team.setDefaultStatus` names a status that `status.delete` removes at the same moment | The team row lock serialises them. If the delete goes first, `setDefaultStatus` re-reads after the lock and gets `CONFLICT`. If `setDefaultStatus` goes first, the delete is refused because the status is now the default. |
| E18 | A label name contains `/` or `:`, or is a reserved word (E19) | `INVALID_INPUT` on `name`: "Label names can't contain / or :. Use a group instead, like Size/Small." The seed and existing labels have none. (Typing `Size/Small` in the "New label" row is not an error: it makes a group and a label, §3.2.) |
| E19 | A label is named `Priority`, `status`, or another reserved word | `INVALID_INPUT` on `name`: "Priority is a reserved name. Choose another label name." Case-insensitive; groups too. |
| E20 | "Move to workspace…" on a label whose name a workspace label already has | `CONFLICT` on `name`: "A workspace label named Bug already exists. Rename this label first." Nothing moves. |
| E21 | "Move to workspace…" on a label that sits in a group | `INVALID_INPUT`: "Move the Size group instead, or take the label out of its group first." |

## 9. Acceptance criteria

> **Held:** tests that need a browser or a running stack are not written for now, nor new integration tests ([plans README §6](../07-plans/README.md#6-testing-hold-e2e-smoke-and-integration)), except private-team leak tests and the sync property suite. Rows marked ⏸ are held. "With SPEC-011" rows need the Issue table and are written in the plan slice that adds it.

| AC | Criterion | Test |
|---|---|---|
| AC-1 | `status.create` adds a status at the end of its category, or right after `after`, with the category's default hue when no color is given. Names are unique per team (case-insensitive); a clash is `CONFLICT` on `name`. Creating in Triage or Duplicate is `INVALID_INPUT`. | unit |
| AC-2 | `status.update` renames, recolors and describes any status except Duplicate (`INVALID_INPUT`, system-managed); a name clash is `CONFLICT` on `name`; there is no way to change the category. | unit |
| AC-3 | `status.reorder` moves a status within its category and writes only that row. Moving relative to a status in another category is `INVALID_INPUT`. | unit + property (`fractionalKeyBetween`: any sequence of inserts and moves gives a strict total order under byte comparison with no duplicate keys) |
| AC-4 | For any sequence of status operations (refused deletes included) and default changes, committed workflows always satisfy INV-04 and INV-05, and a rejected operation changes nothing (`workflowProblems` is empty after every commit). | property |
| AC-5 | `status.delete` refuses (`CONFLICT`) a status that has issues (the message gives the count), the default status, the team's auto-close status (SPEC-015), the last status of a category, Triage and Duplicate; it deletes an empty status. | unit |
| AC-6 | `statusDeleteProblem` (a pure domain function) counts live, archived and recently deleted issues and not permanently deleted ones. For any workflow and issue set: a delete it allows leaves no issue pointing at the status and keeps INV-04 and INV-05; a refusal changes nothing. | unit + property, with SPEC-011 |
| AC-7 | `team.setDefaultStatus` accepts only a Backlog or Unstarted status of the same team, and its `optimistic` writes `defaultStatusId`. `team.setEstimates` changes no issue and needs at least one field. | unit |
| AC-8 | `estimateValues`, `isValidEstimate` and `formatEstimate` match §4.3 for every scale with Extended and Allow zero on and off; `off` accepts no value; 0 is valid only with Allow zero and is distinct from `null`. | unit |
| AC-9 | Labels: workspace and team scopes; names 1–50 characters with no `/` or `:` and not reserved (case-insensitive), unique within scope and group (case-insensitive, archived included); descriptions up to 255; a group has no parent; a label's group is a live group in the same scope; `isGroup` can't change; `exclusive` defaults to true, applies only to groups, and can be switched. | unit |
| AC-10 | Moving a label into a group, or switching a group to single, never reads issues. The label-write rule (a pure domain function used by SPEC-011): adding a label of an exclusive group G removes the issue's other labels of G; a multiple group removes nothing; an issue with two labels of an exclusive G keeps both when a write doesn't add a label of G. | unit + property, with SPEC-011 |
| AC-11 | `label.archive` stops the label from being added while issues keep it; `label.unarchive` undoes it; a group's archive and unarchive take all its labels; while a group is archived, creating a label in it, moving one into it and unarchiving one of its labels are `INVALID_INPUT`; an archived label can be renamed. | unit |
| AC-12 | `label.delete` refuses a group that still has labels (`CONFLICT`); otherwise the delete plan removes the label from `labelIds` on every issue that has it (archived and recently deleted too), without touching `updatedAt`, history or lifecycle, and deletes the row. | unit, with SPEC-011 |
| AC-13 | Limits: the 51st status in a team, the 501st label in a scope and the 251st label in a group are `INVALID_INPUT` with the limit in the message; archived labels count. | unit |
| AC-14 | Permissions per §5: non-members of a public team can't change its workflow, labels or estimate settings (`FORBIDDEN` with a reason); any member creates, edits, archives, unarchives and deletes workspace labels; a key narrowed by `teamIds` gets `FORBIDDEN` on any workspace-label mutation, `label.moveToWorkspace` included (E15). | unit |
| AC-15 | Private-team leak: a non-member's bootstrap, catch-up and live deltas carry none of the team's statuses or labels; every status or label operation and query naming one (by name, uuid or `Group/Label`) is `NOT_FOUND`, worded as for one that doesn't exist; `label.list` and `status.list` never return them; `removedFromIssues` counts only issues the actor can see; `status.delete` on a status the actor can't see gives no count. | integration (leak test, not held) |
| AC-16 | Every operation here passes `pnpm registry:lint` (including rule 6 for `status.list` and `label.list`), and its example runs against the seed fixture. Given the same starting state, each mutation's `optimistic` produces the rows the server commits, apart from server fields (`createdAt`, `updatedAt`). | unit |
| AC-17 | Optimistic changes, offline: `status.delete` with an issue in the store throws the refusal and queues nothing; with none, it removes the status. After `label.delete`, the label is gone from the store and no issue renders it, though `labelIds` may still hold its id until the server's deltas arrive. When the server rejects either, the overlay rolls back and every issue shows its server state (E1, E12). | unit (sync-client with fake-indexeddb) |
| AC-18 | `LabelRef`: `Group/Label` (spaces around `/` ignored) picks the label inside the group; an ambiguous bare name lists candidates as `Group/Label` (E9); a uuid resolves to any visible label without `team`; a team label's name without `team` doesn't resolve. | unit |
| AC-19 | Concurrency against the real server: two concurrent deletes of the last two statuses in a category (exactly one commits, E3); `status.delete` interleaved with `issue.update` into the same status and with `team.setDefaultStatus` (E16, E17); `label.delete` interleaved with adding that label. After every run, no issue references a deleted status or label, INV-04/05 hold, and every replica equals a fresh bootstrap. | sync property suite (not held), with SPEC-011 |
| AC-20 | A status rename or reorder in one tab shows in another in < 150 ms p95 (NFR-02). | e2e perf ⏸ (checked by hand) |
| AC-21 | `label.delete` touching 10,000 issues commits in < 5 s and holds the global sync lock ≤ 2 s. | perf ⏸ |
| AC-22 | Keyboard only: add, rename, reorder and delete an empty status; refuse deleting a used one; make a status the default; create a group and a label in it; archive a label; change the estimate scale. The creates and team settings are also reachable from `Mod+K`. | e2e ⏸ (checked by hand) |
| AC-23 | Command menu (§7.3): "Add status…" and "Create label…" pick the category or scope in a sub-page, then open the settings page with the inline form focused; "Set default status…" and "Change estimate scale…" pick in a sub-page and dispatch; each entry passes `checkOperationCommands` (refs given, `opens` targets registered). | unit (command tests) |
| AC-24 | `label.moveToWorkspace` moves a team label, or a team group with all its labels (archived included), to the workspace in one transaction; refuses a label inside a group (E21) and a name clash (E20); changes no issue; its `optimistic` matches the server. It logs one `U` per label for a public team and a `D` then a `U` per label for a private team, and a non-member of that private team receives only the `U` (§5). | unit (repo log) + leak test with AC-15 |
| AC-25 | `parseLabelInput(text)` (a pure function used by the "New label" row): `Group/Label` and `Group:Label` return a group name and a label name, spaces trimmed; a plain name returns no group; empty parts are an error. Creating through it makes the group single-select when new. | unit |
| AC-26 | `labelUsage(labels, issues)` returns, per label, the issue count, the teams that use it and the latest `updatedAt` among its issues; archived labels are included. | unit |

## 10. Metrics & performance

- Status and label operations: p95 < 100 ms on the server, excluding issue rewrites.
- `label.delete` touching 10,000 issues commits in < 5 s and holds the global sync lock ≤ 2 s (Q11). That stalls other mutations for up to 2 s. Deletes this big are rare settings changes, so this is accepted. The dialog shows a pending state until the answer arrives; there is no progress bar (one transaction).
- A 10,000-issue label delete sends 10,000 `U` deltas (one per rewritten issue) to every connection in the team's groups.
- `status.delete` reads one count and writes one row: p95 < 100 ms.
- Settings pages render from the replica in < 50 ms (NFR-01).
- Log events: none new. Settings deletes write no issue history; a queryable audit log comes in M7.

## 11. Open questions

Each has a proposed default. Accept them in bulk or change any; accepted ones move to the Decisions table with the date. Q5, Q7, Q9, Q14 and Q15 were settled by copying Linear (D5, D9, D11, D12) and are gone.

| # | Question | Proposed default |
|---|---|---|
| Q1 | What does "delete" mean for a status or a label? | A hard delete: a status only when no issue uses it (D5), a label after it is removed from its issues. History stays readable because SPEC-011 stores the name next to every id in a history entry. No 30-day trash for settings rows. |
| Q2 | An offline change moves an issue into a status deleted meanwhile (E1): redirect or reject? | Reject with a clear message and roll back. Redirecting would apply a change the person didn't choose. |
| Q3 | Can a status change category? | No. Create one in the other category, move the issues, then delete the old one. Category changes would make automations act on statuses people think of as fixed. |
| Q4 | How are labels with the same name in different groups referenced? | `LabelRef` accepts `Group/Label`, and label names can't contain `/` or `:`. A bare name that matches several is ambiguous (SPEC-003 §4) and the error lists them as `Group/Label`. |
| Q6 | When a label moves into an exclusive group, or a group is switched to single, some issues (including issues in private teams the actor can't see) may carry two of its labels. What happens? | Linear's behaviour is not observable; kept. Allow the change and enforce one-per-group **when labels are written**; issues with two keep both until then. Nothing reads or writes invisible issues, so nothing leaks. Refusing would reveal a bit about private-team issues and need a second exception in permissions §5. |
| Q8 | What happens to stored estimates when the settings change, or are turned off? | Linear's behaviour is not observable; kept. Nothing is rewritten. Off-scale values show as numbers until edited; `off` hides them and keeps them. The domain rule becomes "valid when written". |
| Q10 | Limits? | 50 statuses per team; 500 labels per scope; 250 labels per group (Linear's cap, D10). Names 1–50 characters and descriptions up to 255 (Linear's name length is not observable; kept). Archived labels count. |
| Q11 | Budget for deleting a label used by many issues? | 10,000 issues in < 5 s, one transaction, global sync lock held ≤ 2 s. No background job in M1. |
| Q12 | Build order: SPEC-010 before SPEC-011, though label deletes touch issues? | Yes. SPEC-010's plan builds statuses, labels and estimate settings without issues; the issue half of `status.delete` (the count) and `label.delete` and the label-write rule (AC-6, AC-10, AC-12, AC-17, AC-19) land in the SPEC-011 slice that adds the Issue table. |
| Q13 | Offer "archive" for labels as well as "delete"? | Yes, as Linear does. Archive retires a label without stripping it from issues; delete removes it everywhere. Statuses have no archive. |
| Q16 | Does unarchiving a group unarchive its labels? | Linear's behaviour is not observable; kept. Yes, all of them. Remembering which labels were archived separately isn't worth a new column. |

## 12. Changes to accepted docs on acceptance

Applied in the same change that marks this spec Accepted. None needs a superseding ADR.

| Doc | Section | Change |
|---|---|---|
| [PRD](../02-product/PRD.md) | FR-WF-04 | "Deleting a status requires choosing a replacement for its issues" becomes "A status can be deleted only when no issue uses it" (D5). |
| PRD | FR-WF-06 | Label groups are single-select by default and can be switched to multi-select (D10); team labels can move to the workspace (D11). |
| PRD | FR-WF-07 | Add the "Extended" and "Allow zero estimates" options and "Count unestimated issues as 1 point" (D12). |
| [domain-model](../03-domain/domain-model.md) | §4.3 Team | Add `estimateExtended`, `estimateAllowZero`, `estimateCountUnestimatedAsOne` (§4.5). |
| domain-model | §4.5 Label | Add synced `archivedAt` and `exclusive`; names can't contain `/` or `:` and can't be reserved words; archived groups take their labels; a team label can move to the workspace; limits (Q10). |
| domain-model | §4.6 Issue | Estimate "valid when written" (Q8), with the 0 and Extended options. Labels as `labelIds` (with SPEC-011). |
| domain-model | §6 INV-07 | Becomes "adding a label of an exclusive group never leaves two labels of that group on an issue" (D10). |
| domain-model | §7 operations | Add `status.list/create/update/reorder/delete`, `team.setDefaultStatus`, `team.setEstimates`, `label.list/create/update/moveToWorkspace/archive/unarchive/delete`. Change "`status.delete` (with replacement)" to a plain delete. |
| [state-machines](../03-domain/state-machines.md) | §1 | Only if it describes status deletion with a replacement: a status with issues can't be deleted. |
| [permissions](../03-domain/permissions.md) | §3.2 | The team-settings table and the workspace-label rule in §5 (every member, delete included). |
| permissions | §3.5 | A key narrowed by `teamIds` can't mutate workspace labels, or move a team label to the workspace. |
| [glossary](../03-domain/glossary.md) | Archive | Archive is automatic for closed issues (SPEC-015); labels can be archived by hand. |
| [events](../03-domain/events.md) | issue events | Settings cascades (label deletes) emit no `issue.updated`. |
| [SPEC-003](SPEC-003-operation-registry-executor.md) | §4 refs | `LabelRef` accepts `Group/Label`; a label uuid resolves without `team` to any visible label; a team label name needs `team`. |
| SPEC-003 | §8 OptimisticStore | Relies on SPEC-011's §12 change (`store.unarchive`, readable `archivedAt`, `store.find` ordered by id). An `optimistic` may throw a refusal that stops the operation from queuing (`status.delete`). No array-membership lookup. |
| [SPEC-005](SPEC-005-app-shell-command-menu-shortcuts.md) | §3 routes | Add `/settings/teams/:key/workflow`, `/labels`, `/estimates` and `/settings/labels`. |
| SPEC-005 | §5 shortcuts | Relies on the shared per-binding "inactive while typing" flag for `Mod+Backspace` and `E`. |
| [sync-protocol](../04-architecture/sync-protocol.md) | §4.3, §11 | Relies on the shared change that sends archive state (`A`/`V` with the full row, `archivedAt` synced); the server's repo writes `sync_log` in chunks of at most 5,000 rows and gains `updateWhere` for cascades (SPEC-011 §5.1, §12). A row can change sync group (`label.moveToWorkspace`, §5): the existing `D`+`U` rule covers it, and clients that newly see the row get it as an insert. |
| [shortcuts](../05-design/shortcuts.md) | settings lists | `Alt+↑`/`Alt+↓` reorder, `Enter` edit, `E` edit label name, `Mod+Backspace` delete, in the `settings-row` scope (listed once, in SPEC-012 §12). |
| [design-system](../05-design/design-system.md) | §4 | Settings deletes confirm in a dialog. (SPEC-011 changes the issue delete itself.) |

## Decisions

| # | Date | Decision |
|---|---|---|
| D1 | 2026-11-12 | (Review round 1) `status.list` and `label.list` take the full `listInput` and return a connection, as registry lint rule 6 requires. |
| D2 | 2026-11-12 | (Review round 1) The default status and the estimate settings get their own operations (`team.setDefaultStatus`, `team.setEstimates`, first named for the scale alone), because each operation has one `ui` entry and `team.update` already has "Rename team…". `team.update` is unchanged. |
| D3 | 2026-11-12 | (Review round 1) Issues hold labels as `labelIds` (shared M1 decision with SPEC-011), so label deletes rewrite arrays and the label-add path takes `FOR KEY SHARE` on the label before locking the issue. |
| D4 | 2026-11-12 | Label deletes follow SPEC-011 §4.8's single lock order (team → label → issues in id order), and issue edits take a key lock on a newly added label before the issue lock. No deadlock is possible. (Review round 2 replaced round 1's deadlock-retry design: `repo.update` reads the team row after the issue lock today, so deadlocks would not have been rare. D5 removed the status half.) |
| D5 | 2026-11-12 | Copy Linear: deleting a status is refused while any issue uses it (archived and recently deleted ones included, because the foreign key needs it), with a toast that gives the count. No replacement picker, cascade or bulk move. The default status and the last status of a category can't be deleted either. This replaces the replacement design, the same-category rule, the status half of the lock rules, and Q14 and Q15. PRD FR-WF-04 changes (§12). |
| D6 | 2026-11-12 | Copy Linear: each editable category header has a "+" that opens an inline form; the other "+" are disabled while it is open. Triage is hidden until triage is on (M4). Duplicate is system-managed (no menu, can't be renamed or deleted). "Make default" is in the row menu. `Alt+↑/↓` stays as "move one position". |
| D7 | 2026-11-12 | Copy Linear: the labels table has Name, Description (editable in place), Used in, Issues, Last applied and Created, a name filter, "New group" / "New label" buttons and an "inherited from workspace" footer. Deviation: "Last applied" is the latest `updatedAt` among the label's issues, computed from the replica, because the exact time would need a write to the label row on every apply and break the lock order (§4.4). |
| D8 | 2026-11-12 | Copy Linear: deleting a label is not reversible and removes it from every issue; the dialog says how many. Deleting a group that still has labels stays refused (Linear's behaviour is not observable; kept). |
| D9 | 2026-11-12 | Copy Linear: every member can create, update, archive and delete workspace labels, and team members do the same for team labels. This replaces the Admin-only delete (Q5). Linear gates this with a Business-plan setting; Surface has no plans. Keys narrowed to some teams still can't touch workspace labels (CLAUDE.md rule 4, permissions §3.5). |
| D10 | 2026-11-12 | Copy Linear: label groups are single-select by default and can be switched to multiple (`exclusive`, default true). INV-07 covers only exclusive groups. A group holds up to 250 labels. `Group/Label` or `Group:Label` typed in "New label" creates the group and the label. Names can't contain `/` or `:` or be a reserved word. |
| D11 | 2026-11-12 | Copy Linear: a team label can move to the workspace ("Move to workspace…"). Not copied: workspace to team. It would strip the label from other teams' issues, including private teams the actor can't see (CLAUDE.md rule 4). Replaces Q7. |
| D12 | 2026-11-12 | Copy Linear: estimate settings are a select (Not in use, Exponential, Fibonacci, Linear, T-Shirt) plus "Extended", "Allow zero estimates" and "Count unestimated issues as 1 point" (default on; M3 cycle stats read it). Replaces Q9. |
| D13 | 2026-11-12 | Copy Linear: auto-close and auto-archive settings live on a team "Automations" page, owned by SPEC-015. This spec doesn't build them. |
| D14 | 2026-11-12 | Copy Linear: settings-list keys follow Linear's shortcut panel: `Alt+↑/↓` move one position, `Mod+Backspace` delete, `E` edit label name. Archived issues are read-only for people (Linear, SPEC-015 §4.3); settings cascades still write them (§4.2). |
