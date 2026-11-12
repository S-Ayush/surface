# SPEC-015: Recently deleted & archive

Status: **Draft** · Milestone: **M1** · Date: 2026-11-12 (revised after review and Linear parity, 2026-11-12)
Implements: FR-ISS-10 · FR-NAV-01 (archive entry) · FR-WF-08, FR-WF-09 (pulled into M1) · NFR-06, 08, 09, 14 · INV-08, INV-21 · ADR-0010 (`trash-purge`)
Depends on: SPEC-011 (issues, lifecycle columns, content models), SPEC-012 (issue page, list), SPEC-013 (comments, reactions), SPEC-014 (attachments, files, byte protocol), SPEC-010 (statuses), SPEC-002 (sync), SPEC-003 (registry), SPEC-005 (shortcuts, command menu)
Related: [state-machines §2](../03-domain/state-machines.md) · [permissions §3.3, §3.5, §5, §6](../03-domain/permissions.md) · [events](../03-domain/events.md) · [sync-protocol §4.1, §4.3](../04-architecture/sync-protocol.md) · [ADR-0010](../04-architecture/adr/0010-jobs-pg-boss.md) · [ADR-0014](../04-architecture/adr/0014-file-storage.md)

The file keeps the name `SPEC-015-trash-archive.md` so links stay valid. D11 records the rename of the page.

---

## 1. Problem & goal

People delete issues by mistake, and finished work clutters lists. This spec gives issues two ways out of the way, as Linear does:

- **Archive** is automatic. A daily job archives closed issues after the team's chosen period. An archived issue is hidden from default views and is **read-only**. It stays findable on the team's archive page.
- **Delete** moves an issue to "Recently deleted" for 30 days, after a confirm dialog. A deleted issue is read-only too. After 30 days it is purged for good.

Nobody archives by hand, and nobody edits an archived or deleted issue. **Restore** is the one way back. Only a background job or an Admin removes an issue permanently.

This spec is also the **single source of the lifecycle rules** that every other issue and child operation follows: which operations are refused on an archived or deleted issue, and the server lock that makes those checks safe (§4.3, §4.4). SPEC-010, SPEC-011, SPEC-013 and SPEC-014 cite them.

## 2. Scope

**In scope**

- Automatic archive and automatic close of stale issues, with the team's **Automations** settings page (§3.2, §3.6).
- Delete, restore and Admin purge of an issue.
- The lifecycle rule table (§4.3) and the server helper `lockIssueForWrite` (§4.4).
- The `trash-purge`, `auto-archive` and `auto-close` jobs: daily, idempotent, batched.
- How archived and deleted issues sync, and how lists, counts and the command menu treat them.
- The team archive page with its "Recently deleted issues" tab, and the archived and deleted states of the issue page.
- History entries and domain events for every transition.

**Out of scope**

- Auto-close of parent and sub-issues (M3). The creator's notification when an issue is archived (M4).
- Bulk delete and the general undo stack (M2). Global search over archived issues (M2).
- Archive and recently deleted for projects, cycles, documents and initiatives (M3, M4, M5). They reuse this lifecycle and these jobs.
- Sub-issues (M3). The rule for them is stated (§4.7) but built with M3.
- The `archivedAt`, `deletedAt` and `deletedById` columns and their output fields. SPEC-011 §4.1 and §6.1 own them; this spec sets and clears them.

## 3. User flows

### 3.1 Delete and restore

1. On the issue page, or on a focused list row, press `Mod+Backspace` (or "…" menu → Delete, or `Mod+K` → "Delete issue").
2. A dialog asks `Delete "ENG-42 – <title>"?` with the text "Deleted issues are available in the "Recently deleted" view for 30 days, before they are permanently deleted." Buttons: **Cancel** and **Delete**. `Enter` confirms.
3. The issue moves to Recently deleted and leaves lists (optimistic: it leaves the replica, §5.1). There is **no Undo toast**. On the issue page, the page stays and shows the deleted state (§3.4), starting from the row it already had.
4. `Mod+Z` right after a delete restores it. It covers only the last delete made in this browser tab, until M2's general undo stack replaces it. The client forgets that delete once it is restored, once another delete replaces it, or on reload. After that, restore from Recently deleted (§3.3). The replica no longer holds the deleted issue, so the restore has no row to patch (§6.2). The toast says "Restoring ENG-42…" until the mutation is **confirmed**, then "Restored ENG-42". It doesn't wait for packets: a connection that doesn't subscribe to the issue's team may never get them. If the issue's team isn't subscribed, the open page refetches the issue with `issue.get`, and subscribes the team if the user opens the issue (SPEC-011 §5.7).
5. `Mod+Z` does nothing special while focus is in a text field or the editor: the field undoes its own typing.

`Mod+Backspace` does not fire while focus is in a text field or the editor (SPEC-005 engine change, §12), so it never deletes an issue while someone is deleting a word.

### 3.2 Automatic archive and auto-close

Both are team settings on **Settings → Teams → ENG → Automations** (`/settings/teams/:key/automations`). Team members and Admins can change them (permissions §3.5). Nobody archives an issue by hand: there is no archive command, button or key.

**Auto-archive.** The section "Auto-archive" says: "Automatically archive closed issues (completed, canceled, or duplicate) after the selected period. Changes apply within a day." A select, "Auto-archive closed items after", offers 1, 3, 6, 9 or 12 months. The default is 6.

**Auto-close.** The section "Auto-close issues" has a toggle "Auto-close stale issues". It is off by default for a new team. When on, it shows:

- "Close after being stale for": 1, 3, 6, 9 or 12 months. Default 6.
- "When closing stale issues, set status to": any Canceled-category status of the team. Default is the first one.

The toggles "Auto-close parent issues" and "Auto-close sub-issues" arrive with M3 and are hidden until then.

What the jobs do is in §6.3. An archived issue is read-only (§3.4). Restore is the only way to make it live again.

### 3.3 The team archive page (`G` `X`)

`G` `X` (or "Go to archived issues in ENG", or the "N archived issues" line at the end of the team's issue list) opens `/team/:key/archive`, titled **Archived issues**. It has two tabs:

- **Issues**: the team's archived issues, newest archived first. Rows are normal issue rows. The date column shows the archive day.
- **Recently deleted issues** (`/team/:key/archive/recently-deleted`, command "Go to recently deleted issues in ENG"): the team's deleted issues, newest deletion first. Rows are normal issue rows. The date column shows the deletion day. The server leaves out an issue once its `purgeAfter` has passed, even before the job has run (§5.2).

On both tabs:

1. Rows are a list (`J`/`K`, `↑`/`↓`). `Enter` opens the issue.
2. The row menu has **Copy ›** and **Restore** (`#`). Nothing else: every edit command is unavailable on a read-only issue (§7).
3. Empty state: "No matching issues".
4. **The page reads from the server**, because the replica holds no archived or deleted issue (§5.1, SPEC-011 §5.7). The Issues tab calls `issue.list` with `{team, includeArchived: true, filter: archivedAt is set, orderBy: archivedAt desc}`; the Recently deleted tab calls `issue.listDeleted {team}`. Each loads pages of 50 as the list scrolls (SPEC-003 cursors).
5. It shows "Loading…" until the first page arrives. Offline, a tab shows "Available when online", and the "N archived issues" line of the team list is hidden.
6. It refreshes on focus, after the user's own delete and restore confirmations, and, when the team is subscribed, on packets for the team (an `A`, the `U` of a delete or a restore, a `V`). Packet refreshes are **debounced to 1 s**, because auto-archive emits many `A`s at once. **Opening the page does not subscribe the team.**
7. Restore needs the network here, like the page. The restored row leaves the list at once, and the toast finishes on the mutation's confirmation (§3.1). The issue joins the replica through the server's packets if its team is subscribed; otherwise it is read with `issue.get` when the user opens it.

The command-menu identifier fast path (`eng-42`) opens archived and deleted issues too, through `issue.get` (they aren't in the local index, SPEC-011 §5.7). In M2, search and the "completed issues" view option include archived issues (FR-NAV-04).

### 3.4 An archived or deleted issue's page

`/issue/ENG-42` still opens. The replica doesn't hold the issue (§5.1), so the page reads it from the server: the row, description, attachments and reactions from `issue.get`, and the activity (history and comments) from one `/sync/content` request whose answer the page keeps in memory and never stores (the replica only stores content of issues it holds, SPEC-011 §5.3). It refreshes on the same triggers as the archive page (§3.3 item 6). After a restore of an issue whose team isn't subscribed, it refetches with `issue.get`. Offline it shows "Available when online". There is no banner. Properties are shown, read-only. Title and description are read-only, and the comment box and the reaction buttons are hidden. Every edit shortcut does nothing (§7).

- **Deleted:** the breadcrumb is "ENG › Recently deleted issues › ENG-42 Title". A **Deleted** badge follows the title. The activity ends with "Ada deleted the issue". The "…" menu has **Copy ›**, **Restore** (`#`) and, for Admins, **Permanently delete…**. Restore is hidden once `now ≥ purgeAfter` (§4.2).
- **Archived:** the breadcrumb is "ENG › Archived issues › ENG-42 Title". An **Archived** badge follows the title. The activity ends with "Issue was automatically archived". The "…" menu has **Copy ›**, **Restore** (`#`) and **Delete** (`Mod+Backspace`).

**Permanently delete…** opens a confirm dialog: `Permanently delete "ENG-42 – <title>"?` with "This can't be undone." Buttons: **Cancel** and **Permanently delete**. It is not a typed confirmation. It has **no keyboard shortcut**.

After the purge, the URL shows the same not-found page as an identifier that never existed (§8 E9).

## 4. Domain changes

### 4.1 States

SPEC-011 §4.1 owns the columns: `archivedAt`, `deletedAt` and `deletedById`. All three are **synced fields** of Issue (shared decision with SPEC-011: `archivedAt` stops being repo bookkeeping, see §5.1 and §12). This spec defines what sets them:

| Field | Set by | Cleared by | Notes |
|---|---|---|---|
| archivedAt | `issue.autoArchive` (system job only) | `issue.restore` | Kept while the issue is deleted |
| deletedAt | `issue.delete` | `issue.restore` | |
| deletedById | `issue.delete` (the actor's user; null for the system actor) | `issue.restore` | Shown on the Recently deleted tab (`DeletedIssue.deletedBy`), without reading history |

An issue is in exactly one state:

- **Live:** both `archivedAt` and `deletedAt` are null.
- **Archived:** `archivedAt` is set and `deletedAt` is null.
- **Deleted:** `deletedAt` is set, whatever `archivedAt` is.
- **Purged:** the row no longer exists.

`packages/domain` exports `lifecycleOf(issue)` returning `'live' | 'archived' | 'deleted'`, plus `purgeAfter(deletedAt)` (§4.2). Server and client both use them.

### 4.2 Transitions

| From | Operation | To | Rules |
|---|---|---|---|
| Live | `issue.autoArchive` (system) | Archived | Only closed issues past the team's period (§6.3) |
| Live, Archived | `issue.delete` | Deleted | `archivedAt` is kept until a restore |
| Archived | `issue.restore` | Live | No time limit |
| Deleted | `issue.restore` | Live | Clears `archivedAt` too (D12). Allowed only while `now < purgeAfter`. Otherwise `CONFLICT`: "ENG-42 was deleted more than 30 days ago and can't be restored." This holds even if the job hasn't run yet (D6). |
| Deleted | `issue.purge` (Admin), or the job once `now ≥ purgeAfter` | Purged | §4.5 |
| Archived, Deleted | any direct edit | — | `CONFLICT`: "ENG-42 is archived. Restore it to edit it." or "ENG-42 was deleted. Restore it to edit it." (§4.3) |
| Live, Archived | `issue.purge` | — | `CONFLICT`: "Delete ENG-42 first." |

A restore sets the issue's `updatedAt` to now. So the auto-archive job, which waits for a quiet period (§6.3), does not archive a restored issue again at once.

**The 30-day boundary.** `purgeAfter = deletedAt + 720 hours` (30 × 24 h, computed in UTC, so daylight saving never shifts it). A restore is allowed if and only if `ctx.now < purgeAfter`. The job selects issues with `deleted_at + interval '720 hours' <= now()`. At exactly `purgeAfter` the issue can't be restored and may be purged; there is no moment when both or neither is true.

**Idempotence.** Deleting a deleted issue, or restoring a live one, changes nothing, writes no history, emits no event and succeeds (like SPEC-011's no-op updates). Purging an issue that doesn't exist, or that the actor can't see, is `NOT_FOUND`.

### 4.3 Lifecycle rule table

This table is the one place that says how each operation treats an issue's lifecycle. The rule behind it:

- **Direct edits** by a `user`, `api` or `mcp` actor to an issue or its children are **`CONFLICT`** on an archived or a deleted issue. Nothing unarchives an issue as a side effect.
- **Cascades** from settings operations and **system** jobs still write archived and deleted issues. They change the row as needed and leave its lifecycle alone.

| Operation | Live | Archived | Deleted |
|---|---|---|---|
| `issue.update` (any field, `addLabels`/`removeLabels`), `issue.updateDescription` (SPEC-011) | applies | `CONFLICT` | `CONFLICT` |
| `comment.create`, `comment.update`, `comment.delete`, `comment.resolve`, `comment.reopen` (SPEC-013) | applies | `CONFLICT` | `CONFLICT` |
| `reaction.set` on a comment or on the issue (SPEC-013) | applies | `CONFLICT` | `CONFLICT` |
| `attachment.createFile`, `attachment.createLink`, `attachment.update`, `attachment.delete` (SPEC-014) | applies | `CONFLICT` | `CONFLICT` |
| `issue.delete` | → Deleted | → Deleted | no-op |
| `issue.restore` | no-op | → Live | → Live (before `purgeAfter`), else `CONFLICT` |
| `issue.purge` | `CONFLICT` | `CONFLICT` | → Purged |
| `label.delete` removing the label from `labelIds` (SPEC-010) | applies | applies, stays archived | applies, stays deleted |
| `attachment.setPreview` (system, SPEC-014), `files-cleanup`, `trash-purge` | applies | applies, stays archived | applies, stays deleted |
| `issue.autoArchive`, `issue.autoClose` (system, §6.3) | applies (live issues only) | skipped | skipped |
| Reads (`issue.get`, `IssueRef`, `/sync/content`, `GET /files/:id`) | yes | yes | yes (so the page and restore work) |

Status deletion is not a row: SPEC-010 refuses it while any issue, archived or deleted included, uses the status, so no cascade touches an archived or deleted issue's status.

Cascades and system writes also leave `updatedAt` alone and write no per-issue history (SPEC-010 owns the cascade details).

A new operation that writes an issue or its children **must** add a row here, and its spec must cite it. The registry lint can't check this, so the table has a unit test per row (AC-1).

### 4.4 `lockIssueForWrite`

SPEC-011 §4.8 defines the helper, its lock and the lock order; this section defines its modes from the §4.3 table. Every issue write and every child write takes the issue's row lock before any child row lock and before reading its lifecycle (only workspace, team, status and label locks come earlier, per SPEC-011 §4.8). Without it, a comment can read "live", a delete can commit, and the comment then lands on a deleted issue. A purge can also fail on a foreign key to a comment inserted after its child delete.

```
lockIssueForWrite(tx, issueId, ctx, mode) → { issue }
  mode: 'edit' | 'lifecycle' | 'cascade'
```

1. `SELECT … FROM issues WHERE id = $1 FOR UPDATE`, filtered by the actor's sync groups and the API key's `teamIds` (CLAUDE.md rule 4). A missing or invisible row is `NOT_FOUND`.
2. Applies the rule table for `mode`:
   - `edit`: archived or deleted → `CONFLICT` with the message of §4.2. It changes nothing.
   - `lifecycle`: returns the state; the delete, restore or purge handler applies §4.2.
   - `cascade`: no checks; used by settings cascades and system writes, which lock many issues in ascending id (through `repo.updateWhere` or `repo.deleteWhere`, SPEC-011 §5.1).
3. Returns the locked row, so the handler re-reads nothing it already holds.

**Lock order:** SPEC-011 §4.8's single order, workspace row → team row → status and label rows → issue rows in ascending id → thread root comment. Each writer takes the subset it needs in that order, so writers never deadlock. Handlers resolve refs before the lock (under READ COMMITTED), so they re-read any ref they rely on after taking it. The issue's sync groups come from the locked issue row, not from a team-row read.

The helper lives in `apps/server/src/issues/lifecycle.ts`. Every handler named in the §4.3 table calls it; a unit test fails if one doesn't (AC-1).

### 4.5 Purge

Purging an issue runs in **one transaction**, through the repo layer:

1. `lockIssueForWrite(…, 'lifecycle')`. The issue must be deleted (else `CONFLICT`, §4.2).
2. Delete its children, in this order. Eager children go through `repo.deleteWhere(model, 'issueId', [issueId])`, which logs a `D` per row; content children follow Q2 (below):
   1. Reactions, then comments (SPEC-013).
   2. Attachments (SPEC-014).
   3. IssueHistory and IssueContent (SPEC-011).
   4. When they exist: relations (M3), subscriptions and notifications pointing at it (M4). Sub-issues follow §4.7 (M3).
3. Delete **every `files` row the issue owns**: attachment files, inline files (images and file chips in the description and comments) and previews, as SPEC-014 §4.7 defines. This follows SPEC-014 §4.5's byte protocol: take the per-key advisory lock for each storage key (in key order), delete the rows, and record each key in the server-only `blob_release` table. No bytes are removed in the transaction.
4. Delete the Issue row.
5. Record the audit line with `ctx.audit('issue.purged', { issueId, teamId, number, actorId })` (SPEC-001 §10). Never the title. The executor writes it only once the transaction commits.

**Bytes.** `files-cleanup` (SPEC-014 §4.5, §4.6) drains `blob_release`. For each key, under the same per-key lock, it removes the bytes only if no `files` row still has that key (content addressing shares bytes across rows). This is crash-safe: the keys are committed with the purge, so a crash after commit leaves them queued for the next cleanup run. It works the same for an Admin purge from the UI or API and for the job. Bytes linger at most one cleanup interval after the purge.

**Deltas.**

- **Eager rows** (the Issue and its Attachments) each log a `D` delta.
- **Content rows** (IssueContent, IssueHistory, Comment, Reaction) log **no** `D` (Q2). The client already drops them: after a delta batch is applied, the content rows and hydration mark of any parent whose Issue row is absent are removed (SPEC-011 §5.3). A group change's `D`+`U` pair leaves the Issue present after the batch, so it keeps content; only a real delete removes it.

This keeps a purge to a handful of `sync_log` rows instead of thousands, so it holds the global sync lock only briefly and doesn't flood every client with deletes for rows they never loaded. It relaxes "every synced write is logged" for content rows whose parent is deleted, so it needs a new ADR (§12). The decision is taken (Q2, 2026-11-12); the ADR is written at the M1 acceptance gate. If that ADR were rejected, the fallback is to log one `D` per content row through `repo.deleteWhere`'s chunked insert; nothing else in this spec changes.

`files` rows are server-only and produce no delta.

**Numbers.** The team's issue counter is never decremented, so a purged number is never reused (INV-08).

**History and events.** Purge writes no history entry (the history is gone with the issue). It emits `issue.purged` to the outbox (events.md: its H column becomes "—", §12).

### 4.6 Children

Content, history, comments, reactions and attachments **follow their issue**. They keep their own rows and states, and the client hides or shows them with the issue. They are not archived or deleted row by row (D4).

The files of an archived or deleted issue stay downloadable by everyone who can see the issue (SPEC-014's visibility rule), so the archive page and the issue page can show them.

### 4.7 Sub-issues (rule for M3)

Copy Linear (D13): deleting a parent deletes its sub-issues. The delete dialog says so: `Delete "ENG-28 – <title>" and 3 sub-issues?`. Restore and purge of the group follow the same lifecycle; M3 states the details. M1 has no sub-issues.

### 4.8 History

SPEC-011 §4.4 has the kinds `created`, `updated`, `archived`, `deleted` and `restored`; the last three have empty `changes`. This spec writes three of them, plus one status change:

| Transition | Entry |
|---|---|
| `issue.autoArchive` | `archived`, actor = system. Shown as "Issue was automatically archived". |
| `issue.autoClose` | an `updated` entry with the status change, actor = system (not a system comment). SPEC-011 §4.4's line formatter shows it as "Issue was automatically closed". |
| `issue.delete` | `deleted`. Shown as "Ada deleted the issue". |
| `issue.restore` | `restored`. Shown as "Ada restored the issue". One entry, even when the restore clears both states. |
| Purge | none |

Restore writes `restored` for both states, and no other entry marks a return from archive. These kinds never fold, including the creator's 3-minute fold (SPEC-011 §4.4).

### 4.9 Migration

One migration adds:

- a partial index on `issues (deleted_at) WHERE deleted_at IS NOT NULL`, for the purge job and the Recently deleted tab;
- a nullable `teams.auto_close_status_id` (FK to `workflow_statuses`, `ON DELETE RESTRICT`: `teams` is a synced table, so a database cascade would change it without a `sync_log` row, rule 2) for §3.2. It is null only while auto-close is off;
- a check that `auto_archive_months` is one of 1, 3, 6, 9, 12 (not null, default 6) and `auto_close_months` is null or one of those (§12).

The `archived_at`, `deleted_at` and `deleted_by_id` columns come with SPEC-011's migration. The `blob_release` table comes with SPEC-014's.

## 5. Sync & permissions

### 5.1 Replica

The replica holds **live issues only** (SPEC-011 §5.7, D17). `archivedAt` is still a synced field, and `A` and `V` packets carry the full row `d` (shared sync change, §12).

| State | In the replica | How it changes |
|---|---|---|
| Archived | No. Bootstrap leaves it out. | The `A` packet removes the Issue, with a tombstone at the packet's id, and its children and hydration mark. A restore's `V` inserts it again. |
| Deleted | No. Bootstrap leaves it out. | The delete's `U` (with `deletedAt` set) removes it the same way. A restore's `U` (the live row) inserts it again. |
| Purged | No | A `D` for the Issue and a `D` for each Attachment. A client that saw the delete already removed the issue, so the `D`s only confirm its tombstones. After that batch the Issue is absent, so any content rows and hydration mark go (SPEC-011 §5.3, §4.5). |

A restore of an archived issue logs `V`. A restore of an issue that is both deleted and archived logs `V` and the `U` for `deletedAt`, in one transaction. Because both carry the full row, and the client keeps or removes the row by its final `archivedAt` and `deletedAt`, the order can't leave a replica that differs from a bootstrap.

The archive page, the Recently deleted tab and the pages of archived and deleted issues read from the server (§3.3, §3.4), so they need the network.

**What a restore sends.** The Issue row arrives with the restore's `V` or `U`, but the client dropped the issue's Attachment rows with it, and they are not part of that packet. So `issue.restore` logs them again, in the same transaction and after the Issue's `V` or `U`: one `U` per Attachment row through `repo.updateWhere` with an empty patch and `touchUpdatedAt: false` (SPEC-011 §5.1), at most 100 (SPEC-014 Q7). A subscribed client gets the issue and its attachments from the packets alone, with no refetch. Content (description, activity, comments) is read when the issue is opened (SPEC-011 §5.3). A client that doesn't subscribe to the issue's team receives none of these packets (they are in `team:<id>`; the issue row alone may also reach `user:` groups), so the UI never waits for them (§3.1, §3.3).

### 5.2 What hides them

| Surface (M1) | Archived | Deleted |
|---|---|---|
| Team issues list, the "Assigned to me" list (SPEC-012) | Hidden | Hidden |
| Archive page, tab Issues (`issue.list` with `includeArchived`, server) | Shown | Hidden |
| Archive page, tab Recently deleted issues; `issue.listDeleted` (server) | Hidden | Shown, until `purgeAfter` |
| `issue.list`, `issue.count`, `issue.groupBy` | Only with `includeArchived` | Never; `issue.listDeleted` instead |
| `issue.get`, `IssueRef` | Resolves | Resolves (so restore and the page work) |
| Command-menu identifier fast path | Opens (through `issue.get`: not in the replica) | Opens (deleted state, through `issue.get`) |
| Team issue counts on settings pages (SPEC-010, from the server) | Counted | Counted by the server's refusal (a status can't be deleted while any issue uses it); the displayed count leaves them out (`issue.groupBy`) |
| Content prefetch (SPEC-011 §5.4) | Not prefetched (not held) | Not prefetched (not held) |
| The client replica | Not stored | Not stored |

The server filters by lifecycle in SQL, and every client view still filters with `lifecycleOf` (§4.1), so no view forgets, even for an optimistic row.

### 5.3 Permissions

| Operation | Member | Admin | API key |
|---|---|---|---|
| `issue.restore` | ✅ on issues they can see | ✅ | `read_write` |
| `issue.delete` | ✅ | ✅ | `read_write` + `allowDestructive` (destructive) |
| `issue.purge` | ❌ | 🛡 | Admin owner, `read_write` + `allowDestructive` |
| `issue.listDeleted` | ✅ (issues they can see) | ✅ | `read` |
| `team.updateAutomations` | ✅ team member | ✅ | `read_write` |
| `issue.autoArchive`, `issue.autoClose` | system only: not callable by any user, key or MCP | | |

Every operation here, `issue.listDeleted` included, applies the API key's `teamIds` in SQL (permissions §3.5): every member may see every public team's group (SPEC-011 §5.7), so group filtering alone doesn't narrow a key.

Private teams: an Admin who isn't a member can't see the team's issues, so `issue.purge` on one is `NOT_FOUND`, worded as for an issue that doesn't exist (permissions §2: Admins get metadata only). The jobs are the system actor and see everything.

## 6. API

### 6.1 Operations

| Operation | Kind | Input → output, notes |
|---|---|---|
| `issue.delete` | m, destructive | `{issue}` → `{issue: IssueSummary, purgeAfter}`. `ui`: "Delete issue", shortcut `Mod+Backspace` (not while typing), available when the issue is live or archived. Always opens the confirm dialog of §3.1. |
| `issue.restore` | m | `{issue}` → `IssueOutput`. `ui`: "Restore issue", shortcut `#` (not while typing), available when the issue is archived, or deleted with `now < purgeAfter`. One operation clears whichever state applies (D12). |
| `issue.purge` | m, destructive, 🛡 | `{issue}` → `{purged: true}`. `ui`: "Permanently delete…", available on deleted issues for Admins, always with the confirm dialog of §3.4, no shortcut. |
| `issue.listDeleted` | q | Full `listInput` plus `team?` → connection of `DeletedIssue` (`IssueSummary` + `deletedBy`, `purgeAfter`). Default order `deletedAt` desc. Passes lint rule 6. |
| `team.updateAutomations` | m | `{team, autoArchiveMonths?: 1\|3\|6\|9\|12, autoCloseMonths?: 1\|3\|6\|9\|12\|null, autoCloseStatus?}` → the team. `null` turns auto-close off; turning it on with no value sets 6 months and the team's first Canceled status. `autoCloseStatus` must be a Canceled-category status of the team. `ui`: none (the settings page calls it). |
| `issue.autoArchive` | m, system only | `{issue}` → `IssueOutput`. Called by the `auto-archive` job. No `ui`, no HTTP or MCP exposure. |
| `issue.autoClose` | m, system only | `{issue}` → `IssueOutput`. Called by the `auto-close` job. No `ui`, no HTTP or MCP exposure. |

`IssueOutput` and `IssueSummary` already carry `archivedAt` and `deletedAt` (SPEC-011 §6.1). `deletedBy` is in `IssueOutput`, and `DeletedIssue` adds it for the list.

"Available when" uses a new registry `ui` predicate, `ui.available(target, store)`, so the command menu hides every edit command on an archived or deleted issue, hides "Delete issue" on a deleted one, and shows "Restore issue" only on an archived or deleted one (§12: SPEC-003 §3.1 and SPEC-005 §4 change).

Every operation passes `pnpm registry:lint` with seed-fixture examples. The fixture gains one archived and one deleted issue. System-only operations carry the registry flag `systemOnly` (§12, the same row as in SPEC-014).

### 6.2 Optimistic updates

These use the `OptimisticStore` additions SPEC-011 §6.3 lists (`unarchive`, readable `archivedAt`, `find` ordered by id).

- `issue.delete`: removes the Issue from the overlay, so it leaves every list at once. Its children are hidden because their parent is gone. The server's `U` then removes it from the base replica (§5.1). A rejection rolls the removal back.
- `issue.restore`: a no-op `optimistic` (registry rule 3 still needs one). The replica doesn't hold an archived or deleted issue, so there is no row to patch: the row returns with the server's `V` or `U` (and its Attachment `U`s, §5.1) when the team is subscribed. The UI shows the restore as pending until the mutation is confirmed (§3.1), not until a packet arrives.
- `issue.purge`: a no-op `optimistic`, for the same reason. When the server's batch arrives, the Issue stays absent, so any content goes too (SPEC-011 §5.3).
- Direct-edit operations predict nothing about the lifecycle: archived and deleted issues never reach them, because the UI disables edits (§7). An edit queued before the issue was locked is rejected by the server and rolled back (E1).
- The system-only operations have no `optimistic`.

### 6.3 Jobs

All three run as the system actor through the executor, one issue per transaction, so one failure doesn't block the rest and every change is logged once. All are idempotent and bounded, and each schedule is evaluated by pg-boss in **UTC** (ADR-0010; queue names use hyphens, like `synclog-prune`).

**`trash-purge`**, cron `'53 3 * * *'`

- **Catch-up:** when a worker starts and the last completed run is older than 24 h, it sends one job with `singletonKey: 'trash-purge'`, so several worker replicas never run it twice. The scheduled run uses the same key.
- **Selection:** issues with `deleted_at + interval '720 hours' <= now()`, oldest first, in batches of 100. Each is purged with `issue.purge`.
- **Idempotent:** keyed by issue id. An issue already gone is skipped (`NOT_FOUND` counts as done). A crash mid-run resumes on the next run.
- **Bounded:** at most 5,000 issues per run; the rest wait for the next run. So "permanently deleted after 12 Dec" can mean a little later, never earlier.
- **Bytes:** not removed by this job. `files-cleanup` drains the keys the purges recorded (§4.5).
- **Metrics:** `surface_trash_purged_total`, `surface_trash_purge_failures_total`, and the age of the oldest deleted issue (NFR-24).

**`auto-archive`**, cron `'29 3 * * *'`, same catch-up and `singletonKey` rule

- **Selection:** live issues whose status is in the Completed or Canceled category (Duplicate is a Canceled status) and where `greatest(completedAt, canceledAt, updatedAt) + autoArchiveMonths months <= now()`, using the issue's team setting. Including `updatedAt` means a restored issue (§4.2) or one that was edited after closing gets a fresh period.
- **Per issue:** `issue.autoArchive`. Batches of 100, at most 5,000 per run, oldest first.
- **Changes apply within a day:** a new period takes effect at the next run.
- **Metrics:** `surface_auto_archived_total`, `surface_auto_archive_failures_total`.
- M4 adds the creator's notification.

**`auto-close`**, cron `'17 3 * * *'`, same catch-up and `singletonKey` rule

- **Selection:** live issues in the Backlog, Unstarted or Started category, in teams with `autoCloseMonths` set, where `updatedAt + autoCloseMonths months <= now()`. Comments, reactions and attachments don't move `updatedAt` (SPEC-011), so they don't count as activity (Q3).
- **Per issue:** `issue.autoClose` moves the issue to the team's `autoCloseStatusId`, with the category side effects of SPEC-011 §4.6 and the history entry of §4.8. Same batch and cap as above.
- **Metrics:** `surface_auto_closed_total`, `surface_auto_close_failures_total`.

### 6.4 Events

`issue.deleted`, `issue.restored`, `issue.purged` and `issue.archived` (events.md; the last is emitted by `issue.autoArchive`), written to the outbox in the same transaction. No-ops emit nothing. Restore emits `issue.restored` for both states. Auto-close emits `issue.updated` like any status change.

Audit: `issue.purged` writes the `audit()` log line of §4.5. That line exists since M0 (SPEC-001 §10); the queryable audit log is M7. Nothing else in this spec writes an audit line.

## 7. UI

| Screen | Route | Notes |
|---|---|---|
| Archived issues | `/team/:key/archive` | §3.3, tab Issues. Reached by `G` `X`, the footer of the team issues list, and the command menu ("Go to archived issues in ENG"). |
| Recently deleted issues | `/team/:key/archive/recently-deleted` | §3.3, second tab. Command "Go to recently deleted issues in ENG". Actions for Admins (Permanently delete…) live on the issue page only. |
| Issue page, archived | `/issue/:identifier/:slug?` | §3.4. Read-only, with an Archived badge. |
| Issue page, deleted | `/issue/:identifier/:slug?` | §3.4. Read-only, with a Deleted badge. |
| Team automations | `/settings/teams/:key/automations` | §3.2. Linked from the team's settings overview. |

There is no `/trash` page and no workspace-wide list of deleted issues. Each team has its own.

**Command menu:** "Delete issue", "Restore issue", "Permanently delete…" (Admins), "Go to archived issues in {team}", "Go to recently deleted issues in {team}". Each shows only where `ui.available` allows it. There is no "Archive issue" or "Unarchive issue". On an archived or deleted issue, every edit command (status, priority, assignee, labels, estimate, due date, rename, comment, attach, link) is hidden, and its shortcut does nothing.

Destructive commands never rank first for a query they match only by keyword. For example, for "deleted", "Go to recently deleted issues" ranks above "Delete issue". This was a lesson from Linear, whose menu put "Delete issue" first for "deleted". It is a ranking penalty in command-menu §3.1 (§12). Delete and Permanently delete… always open a confirm dialog.

**Shortcuts** (Linear's key map, scratchpad `linear-shortcuts-2026-11-12.md`):

- `Mod+Backspace`: delete. In the `issue` scope; doesn't fire while typing.
- `#`: restore. In the `issue` scope; doesn't fire while typing; available only on an archived or deleted issue.
- `Mod+Z`: restore the last delete of this tab (§3.1). Global, not while typing.
- `G` `X`: go to the team's archive page.
- There is no archive key, no unarchive key and no purge key. Archive and Recently deleted rows are normal issue rows, so they set the `issue` scope; no `trash` or `archive` scope exists.

Added to `docs/05-design/shortcuts.md` on acceptance (§12).

## 8. Edge cases

| # | Case | Behaviour |
|---|---|---|
| E1 | Someone edits an issue offline, and it is deleted or auto-archived before the edit reaches the server | The edit is `CONFLICT` "ENG-42 was deleted. Restore it to edit it." (or "…is archived…") and the client rolls it back (NFR-08). For a description or comment edit, the rejection toast has **Copy text**, so the typing isn't lost. |
| E2 | The job archives an issue while someone has it open and is typing a comment | The comment is `CONFLICT` as in E1, with **Copy text**. The `A` packet removes the issue from the replica, and the page switches to the read-only archived view fed by `issue.get` (§3.4). |
| E3 | Two people delete and restore the same issue at once | Both take the issue row lock, so the server applies them in order; history shows both. |
| E4 | A restore arrives at or after `purgeAfter`, before the job ran | `CONFLICT` (§4.2); the job purges it on its next run. |
| E5 | The issue is purged while someone has its page open | The page shows a deleted issue, read from the server. The Issue `D` makes it refresh, `issue.get` answers `NOT_FOUND`, and the page switches to not-found ("This issue was deleted permanently."). Queued edits for it are `NOT_FOUND` and roll back. |
| E6 | A purge transaction fails (crash, error) | It rolls back: the issue stays deleted, nothing is recorded in `blob_release`, and the next run retries. |
| E7 | The server crashes after a purge commits, before cleanup | The keys are in `blob_release`; the next `files-cleanup` run removes the bytes. |
| E8 | Two issues share bytes (the same content) and one is purged | Cleanup keeps the bytes while any `files` row still has the key. |
| E9 | Someone opens `/issue/ENG-42` after the purge | The not-found page, worded as for an identifier that never existed. |
| E10 | An Admin tries to delete a status that archived or deleted issues use | Refused by SPEC-010's rule for any status with issues. Restore therefore always lands in an existing status. |
| E11 | A label on an archived or deleted issue is deleted | It is removed from the issue's `labelIds` (SPEC-010), without changing its lifecycle or `updatedAt`; a restore brings the issue back without it. |
| E12 | An Admin purges an issue of a private team they're not in | `NOT_FOUND`; the job purges it after 30 days. |
| E13 | A Member opens Recently deleted issues | They see the team's deleted issues they can see, with Restore; no purge action. |
| E14 | A user presses `Mod+Z` right after a delete, while offline | `issue.restore` queues and applies on reconnect if it's still before `purgeAfter`; otherwise it is rejected with the §4.2 message. The issue isn't in the replica, so nothing reappears until the server's packet arrives; the toast shows the restore as pending. |
| E15 | A comment is posted while another user deletes the issue | The second to take the issue row lock loses: either the comment lands and then the issue is deleted, or the comment is `CONFLICT`. Never a comment on a deleted issue. |
| E16 | A comment insert races a purge | The purge locks the issue first; the comment waits, then gets `NOT_FOUND`. The purge never fails on a foreign key. |
| E17 | Someone reacts to a comment on an archived issue | `CONFLICT` "ENG-42 is archived. Restore it to edit it." Reactions are edits too. |
| E18 | A user types `Mod+Backspace` or `Mod+Z` in the description editor | The editor deletes text or undoes typing; the issue isn't deleted or restored. |
| E19 | A team's period is lowered from 12 to 1 month | The next `auto-archive` runs archive every closed issue past the new period, 5,000 per run, so a large backlog takes several days. |
| E20 | Someone restores an archived issue that closed long ago | It is live again, and `updatedAt` is now, so the job leaves it alone for another full period. |
| E21 | Auto-close and a user edit the same issue at once | Both take the issue row lock. If the user's edit lands first, the issue is no longer stale and the job's `WHERE` re-check (under the lock) skips it. |
| E22 | Someone tries to delete the team's auto-close status | SPEC-010 refuses it, like the default status: "This status closes stale issues. Choose another one in Settings → Automations first." Turning auto-close on requires a Canceled status. |
| E23 | The archive page or a deleted issue's page is opened offline | "Available when online" (SPEC-011 E34). The team's live lists still work from the replica. |
| E24 | Someone else restores, deletes or the job archives an issue of the team while its archive page is open | If the team is subscribed, the packet (`V`, `U` or `A`) makes the open tab refresh (debounced to 1 s), so the row joins or leaves the list. Otherwise the page refreshes on focus. Focus follows SPEC-012 E2. |
| E25 | A delete is rejected (the issue was purged meanwhile, or a permission changed) | The optimistic removal rolls back and the row returns to the list, with a toast giving the server's message. |

## 9. Acceptance criteria

> **Held:** tests that need a browser, a running stack or Postgres are not written for now ([plans README §6](../07-plans/README.md#6-testing-hold-e2e-smoke-and-integration)), except private-team leak tests and the sync property suite.

| AC | Criterion | Test |
|---|---|---|
| AC-1 | Every row of the §4.3 table holds: each listed operation calls `lockIssueForWrite` with the right mode and gets the listed result for a live, an archived and a deleted issue. The transitions of §4.2 hold and repeated calls change nothing. | unit (one case per table row, fake repo) + property (any sequence of lifecycle and edit operations keeps an issue in exactly one state) |
| AC-2 | Every direct edit of an archived issue is `CONFLICT` "ENG-42 is archived. Restore it to edit it.", and of a deleted issue "ENG-42 was deleted. Restore it to edit it.", with no repo write. No operation unarchives as a side effect. Settings cascades and system writes still apply and leave the lifecycle and `updatedAt` alone. | unit (handler repo calls on a fake repo) |
| AC-3 | `purgeAfter = deletedAt + 720 h`. A restore of a deleted issue 1 ms before it succeeds and returns the issue to Live (clearing `archivedAt` and `deletedAt`, setting `updatedAt`); at it and after it, `CONFLICT`. Restoring an archived issue has no time limit. | unit (fake clock, exact boundary) |
| AC-4 | Purge removes the issue and every child row of §4.5 in one transaction, logs `D` for the Issue and each Attachment and none for content rows, deletes every file row the issue owns (attachment, inline, preview), records their keys in `blob_release`, keeps the team counter, and never reuses the number. | unit (cascade plan: row and `D` counts on a fake repo) + integration ⏸ |
| AC-5 | Bytes are removed only by `files-cleanup`, only for keys in `blob_release`, and only when no `files` row has the key. A crash after the purge commits and before cleanup still ends with the bytes removed. An Admin purge removes the bytes the same way as the job. | unit (fake blob store, fake clock) |
| AC-6 | The `trash-purge` job selects exactly the issues with `deleted_at + 720 h <= now` (exact-boundary cases), purges in batches of 100, resumes after a crash without double work, stops at 5,000 per run, and a second start with the same `singletonKey` doesn't run it twice. | unit (fake clock, fake executor, fake queue) + integration ⏸ |
| AC-7 | The `auto-archive` job selects exactly the live, closed (Completed or Canceled category) issues where `greatest(completedAt, canceledAt, updatedAt) + N months <= now`, with N from the issue's team (exact-boundary cases); skips open, archived and deleted issues; leaves a just-restored issue alone; writes the `archived` entry with the system actor; stops at 5,000 per run; and a second start with the same `singletonKey` doesn't run it twice. | unit (fake clock, fake executor, fake queue) |
| AC-8 | The `auto-close` job selects exactly the live Backlog, Unstarted and Started issues with `updatedAt + N months <= now` in teams with auto-close on; moves them to the team's auto-close status with the SPEC-011 §4.6 category side effects and a system `updated` entry; skips a team with no auto-close status; skips issues that stopped being stale after the lock. | unit (fake clock, fake executor) |
| AC-9 | Each M1 surface of §5.2 shows exactly the states listed: archived issues only on the archive page's Issues tab, with `includeArchived` and through the fast path; deleted issues only in the Recently deleted tab (until `purgeAfter`), `issue.listDeleted` and the fast path. | unit (`lifecycleOf`, list filters, query builders) |
| AC-10 | Permissions of §5.3: Admin-only purge; `allowDestructive` for delete and purge; the API key's `teamIds` narrowing on `issue.listDeleted`, `issue.restore`, `issue.purge` and `team.updateAutomations`; `issue.autoArchive` and `issue.autoClose` can't be called by a user, a key or MCP. | unit |
| AC-11 | Private-team leak: for a non-member, `issue.listDeleted` (with `withTotal`) never returns or counts a private team's issues; `issue.purge`, `issue.restore` and `issue.delete` on one are `NOT_FOUND`, worded as for a missing issue; `/sync/content` and `GET /files/:id` for a deleted private issue and its attachments are `NOT_FOUND`; the `U`, `A`, `V` and `D` deltas of these transitions, including the jobs' archive, never reach non-members; MCP `search_operations` examples for the new operations leak nothing. A key with `teamIds=[A]` sees nothing of team B in any of them. | integration (leak test, not held) |
| AC-12 | History gets the entries of §4.8, with one `restored` entry per restore, and no other entry marks a return from archive. | unit |
| AC-13 | Each mutation's `optimistic` produces the rows the server commits, apart from server fields: delete removes the Issue; restore and purge predict nothing. The sync property suite includes delete, restore, auto-archive and purge in its generator, and checks that archive → restore, and a purge, leave the replica equal to a fresh bootstrap (which holds no archived or deleted issue). | unit + property (sync suite, not held) |
| AC-14 | `Mod+Backspace` and `#` don't fire while focus is in a text field or the editor. `Mod+Z` restores only the last delete made in this tab, once, and not while typing. No binding exists for archive, unarchive or purge. `#` and `Mod+Backspace` don't conflict with any other binding in the `issue` scope. | unit (shortcut engine, conflict test) |
| AC-15 | The delete dialog shows the identifier, title and the 30-day text of §3.1, and no Undo toast follows. The "Permanently delete…" dialog is a plain confirm (no typed text). The command menu hides each command where `ui.available` is false (every edit command on an archived or deleted issue; "Restore issue" only on archived or deleted ones) and never ranks a destructive command first for a query it matches only by keyword. | unit (component and ranking tests) |
| AC-16 | The Automations page offers only 1, 3, 6, 9, 12 months; auto-archive defaults to 6 and can't be off; auto-close is off by default for a new team, turns on at 6 months with the first Canceled status, and only accepts a Canceled-category status of the team. | unit (operation validation, component) |
| AC-17 | Keyboard only: delete with `Mod+Backspace` and confirm with `Enter`, restore with `Mod+Z`; delete again, open Recently deleted with `G` `X` and its tab, and restore with `#`; restore an archived issue with `#`. | e2e ⏸ (checked by hand) |
| AC-18 | Every operation passes `pnpm registry:lint`; examples run against the seed fixture. | unit |
| AC-19 | The archive page reads from the server (§3.3): the Issues tab from `issue.list` (`includeArchived`, `archivedAt` set, newest archived first) and the Recently deleted tab from `issue.listDeleted`, which leaves out issues past `purgeAfter`. It shows "Loading…" until the first page, "Available when online" offline, and refreshes on focus, after the user's own delete and restore confirmations, and, for a subscribed team, on an `A`, a delete or restore `U` or a `V` of the team, debounced to 1 s. Opening it does not subscribe the team. | unit (archive data source with a fake server and fake packets) |
| AC-20 | The page of an archived or deleted issue renders read-only from `issue.get` and an in-memory `/sync/content` answer, stores nothing in the replica, and shows "Available when online" offline. `Mod+Z` after a delete shows the restore as pending until the mutation is confirmed, and an unsubscribed team's page then refetches with `issue.get`; a rejected delete returns the row (E25). | unit (page data source, last-delete flow, fake server) |
| AC-21 | `issue.restore` re-logs the issue's Attachment rows after the Issue's `V` or `U`, in the same transaction: one `U` each through `repo.updateWhere` with an empty patch and `touchUpdatedAt: false`, at most 100, and none for an issue with no attachments or for a no-op restore (§5.1). A client that dropped them has them again from the packets alone. | unit (handler with a fake repo) + `sync-client` unit (pool) |

## 10. Metrics & performance

Budgets, measured once the perf hold lifts (⏸, plans README §6):

- Delete and restore: p95 < 50 ms on the server.
- Purge of one issue with 500 comments and 50 attachments: < 1 s, with the global sync lock held for < 50 ms.
- The archive page's first page (50 rows) answers in < 200 ms p95 on a LAN with 10,000 archived issues in the team (`issue.list` and `issue.listDeleted` use the `deleted_at` index and the issue indexes of SPEC-011 §4.10).
- One auto-archive run of 5,000 issues finishes in < 5 min.

Job metrics as in §6.3. An audit line per purge.

## 11. Open questions

Each has a proposed default.

| # | Question | Proposed default |
|---|---|---|
| Q3 | Does a comment or reaction count as activity for auto-close? | No: staleness follows `updatedAt` (SPEC-011). Linear's behaviour not observable; kept. |

### Decisions

| # | Decision | Date |
|---|---|---|
| D1 | Deleted issues stay in the client replica, flagged by `deletedAt`: the archive page and restore work offline, a restore needs no refetch, and the replica holds at most 30 days of them. **Superseded by D17.** | 2026-11-12 |
| D2 | Who deleted an issue is stored on the row (`deletedById`, SPEC-011), so the Recently deleted tab shows it without reading history. (It said "offline"; D17 made the tab need the network.) | 2026-11-12 |
| D3 | Copy Linear: deleting asks for confirmation (`Delete "ENG-42 – <title>"?`, with the 30-day text) and shows no Undo toast. `Mod+Z` right after a delete restores the last delete of the tab until M2's general undo. This replaces the first draft's "no dialog, 8 s Undo toast" and design-system §4's rule for reversible deletes (§12). | 2026-11-12 |
| D4 | Children are not archived or deleted row by row; their state derives from the issue. Fewer deltas, and a restore is exact. state-machines §2 changes to match (§12). | 2026-11-12 |
| D5 | Copy Linear: archive is automatic only. There is no archive or unarchive operation, command, menu entry or key. A daily job archives closed issues after the team's period. This removes the earlier "open issues can be archived manually" rule. | 2026-11-12 |
| D6 | No restore at or after `purgeAfter`, even if the job hasn't run: the 30 days are the rule, not the job's timing. | 2026-11-12 |
| D7 | Anyone who can see the issue can restore it, like delete (permissions §3.3). | 2026-11-12 |
| D8 | Retention is 30 days, fixed in v1 (FR-ISS-10). | 2026-11-12 |
| D9 | Copy Linear: archived and deleted issues are read-only. Every direct edit (fields, description, labels, comments, reactions, attachments) is `CONFLICT`. Nothing unarchives on edit: the earlier edit-unarchives rule, the `archived: {from, to}` history change, the extra history entry for a return from archive and the optimistic code's unarchive prediction are removed. Settings cascades (label delete) and system jobs still write them. | 2026-11-12 |
| D10 | Jobs run daily in UTC: `auto-close` 03:17, `auto-archive` 03:29, `trash-purge` 03:53. 100 per batch, 5,000 per run. | 2026-11-12 |
| D11 | Copy Linear: "Trash" becomes "Recently deleted". There is no `/trash` page: the team archive page (`G` `X`, `/team/:key/archive`, "Archived issues") has the tabs "Issues" and "Recently deleted issues". The spec's title is now "Recently deleted & archive"; the filename stays `SPEC-015-trash-archive.md` so links stay valid. | 2026-11-12 |
| D12 | Copy Linear: restore is `#`, for archived and deleted issues alike. One operation, `issue.restore`, returns the issue to Live and clears whichever states are set (simpler than two operations or a return-to-archived step). A restore sets `updatedAt` so the archive job doesn't undo it. Removes the `trash`/`archive` page scopes and their `R`/`U` keys. | 2026-11-12 |
| D13 | Copy Linear: deleting a parent deletes its sub-issues, and the dialog says so (§4.7). M3 builds it. This replaces the old Q1 and state-machines §2's "sub-issues are not trashed with the parent". | 2026-11-12 |
| D14 | Copy Linear: "Permanently delete…" (Admin) opens a plain confirm dialog, not a typed identifier. It has no shortcut. | 2026-11-12 |
| D15 | Copy Linear: the team **Automations** page holds auto-archive (1/3/6/9/12 months, default 6, "Changes apply within a day") and auto-close of stale issues (off by default, 6 months, a Canceled status). FR-WF-08 and FR-WF-09 move from M4 to M1. Auto-close parent and sub-issues are M3; the creator's archive notification is M4. | 2026-11-12 |
| D16 | Linear's Recently deleted tab is per team; Surface's is too. The old workspace-wide Trash and the sidebar Trash entry are gone. | 2026-11-12 |
| Q2 | Accepted: purge deletes content rows without logging a `D` per row (§4.5). The ADR is written at the M1 acceptance gate; the per-row fallback stays in the code, off by default. User decision. | 2026-11-12 |
| D17 | Copy Linear, through partial issue loading (SPEC-011 §5.7, ADR-0020): archived and deleted issues are never stored on the client. An `A` or a delete's `U` removes the issue; restore's `V` or `U` inserts it again, and `issue.restore` re-logs the issue's attachments. The archive page, the Recently deleted tab and their issue pages read from the server, online only, read-only, refreshed on focus, on the user's own confirmations and (debounced, subscribed teams only) on packets; the restore toast ends on the mutation's confirmation. Delete's optimistic removes the row; restore's and purge's predict nothing. Replaces D1. | 2026-11-12 |

## 12. Changes to accepted docs on acceptance

| Doc | Section | Exact change | Superseding ADR? |
|---|---|---|---|
| sync-protocol | §4.3, §11 | `A` and `V` packets carry the full row `d`, applied as upsert plus flag; `V` for a missing row re-inserts it. `archivedAt` is a synced field and the client derives `$archived` from it. Changelog v0.7, `schemaHash` bump. (Shared with SPEC-010 and SPEC-011.) | No |
| sync-protocol | §4.2, §11 | Content rows deleted with their issue log no `D` (Q2). The client side needs no new wire rule: content is dropped when its Issue is absent after a batch (SPEC-011 §5.3 and its §12 row for sync-protocol §4.2, §6). | **Yes**: a new ADR, because skipping the `D`s relaxes "every synced write is logged" (architecture rule 2) |
| SPEC-002 | Decisions | Record the two sync changes above (A/V full rows; content rows of a purged issue log no `D`, Q2 accepted 2026-11-12). | — |
| sync-protocol | §4.1, §4.3 | Relies on SPEC-011's v0.8 row: archived and deleted issues are not bootstrapped, and an `A` or a delete's `U` removes the Issue on the client; restore's `V` or `U` inserts it (D17). | ADR-0020 |
| SPEC-003 | §8 | Relies on SPEC-011's §12 change: `store.unarchive`, readable `archivedAt`, `store.find` ordered by id. No optimistic code predicts an unarchive. | No |
| SPEC-003 | §3.1 `ui` entry | Registry `ui` gains `available(target, store)`. | No |
| SPEC-003 | §3.1 definition fields | Add `systemOnly: true` to the registry definition: the operation is callable only by the system actor in every environment, and is hidden from the API, catalog, OpenAPI, MCP and the command menu; it is exempt from rule 2's seed run and rule 4. Used by `attachment.setPreview`, `issue.autoArchive` and `issue.autoClose`. (`internal` stays for dev-only debug ops.) Same row in SPEC-014 and SPEC-015. | No |
| SPEC-005 | §3 routes | `/team/:key/archive`, `/team/:key/archive/recently-deleted` and `/settings/teams/:key/automations` go live. The reserved `/trash` route is removed. (SPEC-012 adds the other M1 routes in its own row.) | No |
| SPEC-005 | §4, §5 | The command menu filters by `ui.available`. The shortcut engine gets a per-binding `whileTyping` flag (false for `Mod+Backspace`, `#` and `Mod+Z`). No new page scopes. | No |
| command-menu | §3.1 | Ranking penalty: a destructive command never ranks first for a query it matches only by keyword. | No |
| shortcuts | §2, §3 | `#` (restore) and `Mod+Backspace` (delete) in `issue`, not while typing; `Mod+Z` restores the last delete (until M2's undo stack); `G` `X` goes to the team archive page; no archive, unarchive or purge binding. Listed once with the full key map in SPEC-012 §12. | No |
| design-system | §4 | Reversible deletes no longer run at once with an Undo toast: deleting an issue asks for confirmation (D3). | No |
| PRD | FR-WF-08, FR-WF-09 | Move from M4 to M1. FR-ISS-10 wording: "Recently deleted" for 30 days, restore, Admin permanent delete; archive is automatic only. | No |
| state-machines | §2 | Remove the `Archived → Live: unarchive (manual) / any edit` edge; archive is automatic only (`autoArchiveMonths`). `Archived → Live` and `Deleted → Live` are both **restore**, which clears both states. "Trashed" becomes "Deleted" (shown as Recently deleted). Archived and deleted issues are read-only. Children "follow their issue" instead of "are archived with it". Restore allowed while `now < deletedAt + 720 h`. "File bytes are removed" becomes "by `files-cleanup` after commit". Parent deletion deletes sub-issues (M3). Auto-close adds a history entry, not a system comment. | No |
| domain-model | §3 (Team) | `autoArchiveMonths` is one of 1, 3, 6, 9, 12, default 6, never null. `autoCloseMonths` is null (off) or one of those. Add `autoCloseStatusId` (a Canceled status of the team; set whenever auto-close is on; a status it names can't be deleted). | No |
| domain-model | §1 | `archivedAt` is set only by the automatic job. | No |
| domain-model | §7 | Add `issue.restore`, `issue.purge`, `issue.listDeleted`, `team.updateAutomations`, and the system-only `issue.autoArchive` and `issue.autoClose`. No `issue.archive` or `issue.unarchive`. | No |
| permissions | §3.3 | Add `issue.listDeleted` (Member ✅, Admin ✅) and the restore row. | No |
| permissions | §3.5 | Team members and Admins edit team Automations. | No |
| permissions | §6 | Issue purge also deletes inline files and previews; bytes go through `blob_release`. | No |
| events | `issue.purged` row | H becomes "—" (purge writes no history). | No |
| events | `issue.archived`, `issue.unarchived` | `issue.archived` is emitted by the system job only; remove `issue.unarchived`. | No |
| glossary | Archive, Recently deleted | Deleted issues are called "Recently deleted". Archive is automatic and read-only. | No |
