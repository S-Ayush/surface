# SPEC-011: Issues core: create, properties, history, IDs

Status: **Accepted** (2026-11-12, M1 acceptance gate) · Milestone: **M1** · Date: 2026-11-12 (review round 1 applied 2026-11-12; D11 and the §6.4 status wording 2026-11-13; D13, D14 2026-11-16)
Implements: FR-ISS-01, 02 (domain and operation; the composer UI is SPEC-012), 03 (the M1 properties, §2), 04 (operations), 05, 08 (identifier and URL forms) · NFR-01, 02, 06, 07, 08, 10, 14 · sync-protocol §2 and §4.2 (content models, first use) · the issue half of SPEC-010 AC-10, AC-12
Depends on: SPEC-010 (statuses, labels, estimates), SPEC-002 (sync), SPEC-003 (registry, filter engine, lists)
Related: [domain-model §4.6, §4.10, §6](../03-domain/domain-model.md) · [state-machines §1](../03-domain/state-machines.md) · [events](../03-domain/events.md) · [sync-protocol §2, §4.2, §4.3, §5.4](../04-architecture/sync-protocol.md) · SPEC-012 (UI) · SPEC-013 (comments, editor) · SPEC-014 (attachments) · SPEC-015 (recently deleted, archive)

---

## 1. Problem & goal

Surface has teams and workflows but nothing to track. This spec adds the **issue**: its identifier, its M1 properties, its rich-text description, and an activity history that says who changed what and when. It also adds the first **content** models to the sync engine, so descriptions and history load on demand while issue rows stay in the eager replica. The goal is that creating or changing an issue is instant on the author's screen, reaches teammates in under 150 ms, and is never lost, including offline.

This spec also owns four things the other M1 specs build on: the content-model design (hydration, storage, the `/sync/content` contract), the issue lifecycle columns and the server lock every issue write takes, archive state on the wire, and the `OptimisticStore` additions. SPEC-013, SPEC-014 and SPEC-015 cite these sections instead of restating them.

## 2. Scope

**In scope**

- The Issue entity with the M1 properties: team, number and identifier, title, description, status, priority, assignee, labels, estimate, due date, manual sort order, creator, the category timestamps (`startedAt`, `completedAt`, `canceledAt`), and the lifecycle columns (`archivedAt`, `deletedAt`, `deletedById`) that SPEC-015's operations set.
- `IssueContent` (description) and `IssueHistory` as **content** models: the `GET /sync/content` contract, hydration, client storage, caching and prefetch (§5.2–§5.4). SPEC-013's Comment and Reaction use the same machinery.
- Archive state on the wire: `A` and `V` packets carry the full row, and `archivedAt` is a synced field (§5.5).
- **Partial issue loading** (§5.7, ADR-0020): the client holds the live issues (not archived, not deleted) of the teams it subscribes to and the live issues assigned to or created by the user; other issues load on demand. Completed and canceled issues stay in the replica until they are archived. Archived and deleted issues are read from the server.
- The `OptimisticStore` additions (§6.3).
- The server write path for issues and their children: `lockIssueForWrite` and the lock order (§4.8).
- Server-assigned issue numbers that are never reused once committed (INV-08).
- Operations to create, update, update the description, get, list, count and group issues, for the web client, the HTTP API and MCP.
- Status category side effects (state-machines §1) and the invariants INV-06, INV-07 (exclusive groups only), INV-08, INV-20.
- The issue side of SPEC-010's label cascades: `label.delete` removes a label from issues, and moving a label into a group touches none (AC-16, AC-17). Status delete has no cascade: SPEC-010 refuses it while any issue uses the status, and the foreign key backs that up (AC-15).
- Read-only archived and deleted issues: every edit is refused (§6.1), and the activity wording (§4.4).
- The slugged issue URL (§4.1).
- Domain events `issue.created` and `issue.updated` written to the outbox (consumers come in M4 and M6).

**Out of scope**

- All UI: composer, issue page, list view, shortcuts, drafts (SPEC-012).
- Comments and reactions, and the shared editor schema (SPEC-013). This spec stores the description as editor JSON validated by that schema.
- Attachments (SPEC-014). The delete, restore, purge and auto-archive operations and their lifecycle rules (SPEC-015 §4); this spec declares the columns they set and the lock they use.
- The `Draft` model and the drafts UI (SPEC-012, §5.1). Description history (Q18).
- Project, milestone, cycle and parent (M3), triage and snooze (M4), team moves (FR-ISS-09, M3), relations (M3). Their columns arrive with their milestones (Q1). The PRD rows change accordingly (§12).
- Bulk update and multi-select (M2), undo and redo (M2), global search (M2), mentions (M4), description merge UI (FR-COL-10, M4).
- **BroadcastChannel cross-tab notifications** (SPEC-002 §2 put them in M1): deferred, see Q16. Each tab already has its own socket and applies every delta, and the shared IndexedDB with per-row versions keeps tabs consistent (`storage.prop.test.ts`). The one cross-tab need M1 has, not evicting content another tab has open, uses Web Locks (§5.4).

## 3. User flows

The screens are SPEC-012's. The flows here describe what the system does.

### 3.1 Create

1. A client dispatches `issue.create` with a client-generated UUIDv7 `id`, a team, a title, and any of: description, status, priority, assignee, labels, estimate, due date.
2. The optimistic row appears at once with identifier `ENG-…` (number pending, sync-protocol §5.2).
3. The server locks the team's counter row, takes the next number, computes the sort key, writes the issue, its content and one `created` history entry, and commits. The delta carries the number; the identifier becomes `ENG-42` everywhere.
4. An API or MCP caller gets the issue back with its identifier in the response.

### 3.2 Change a property

`issue.update` changes any subset of title, status, priority, assignee, estimate and due date, and adds or removes labels. Each field is written on its own (NFR-07: per-field last-writer-wins), so two people changing different fields both win. Labels change by add and remove intents, merged on the server, so two people adding different labels both keep theirs. A status change into another category applies the category side effects in the same transaction. One history entry records every field the operation changed.

### 3.3 Edit the description

`issue.updateDescription` sends the whole document with the `baseVersion` it was edited from. If someone saved in between, the server answers `CONFLICT` and the client keeps the user's text (Q4). Otherwise the version goes up by one. Saving the description (and creating an issue with one) also claims the inline files it references, in the same transaction, through one server function `claimInlineFiles(tx, doc, issue, actor)` that SPEC-013 (comments) and SPEC-014 (files) share (SPEC-014 §4.3).

### 3.4 Open an issue

The issue row is already in the replica. It opens at `/issue/ENG-42/<slug>` (§4.1). Its description and history are fetched with `GET /sync/content` the first time, stored in IndexedDB, and kept live by deltas from then on (§5.2–§5.4).

## 4. Domain changes

### 4.1 Issue (eager)

| Field | Type | Rules |
|---|---|---|
| id | uuid | UUIDv7 from the client (SPEC-003 §8) or the server |
| teamId | Team | Set at creation; can't change in M1 (moving teams is M3) |
| number | int? | Assigned by the server in the creating transaction. Null only in the client overlay before the delta arrives. |
| title | string | 1–255 characters after trimming. Line breaks are replaced by spaces. |
| statusId | WorkflowStatus | A status of `teamId` (INV-06), never Triage or Duplicate in M1 (§4.6). Defaults to the team's default status. |
| priority | 0–4 | `0` none, `1` urgent, `2` high, `3` medium, `4` low (`PRIORITIES`). Default 0. |
| assigneeId | User? | An active user who can see the team (for a private team, a member: INV-18 in M7) |
| labelIds | uuid[] | §4.2. Displayed ordered by label name; stored in insertion order. |
| estimate | int? | Valid on the team's scale **when written** (SPEC-010 §4.3). Null clears it. Refused while the scale is `off`. |
| dueDate | `YYYY-MM-DD`? | A calendar date, no time zone |
| sortOrder | fractional key | Global manual order (domain-model §4.6), §4.5 |
| creatorId | User | The actor (for `api`/`mcp`, the key's owner). **Never null**: on an update, the groups builder tells a public team's issue from a private one by the stored `user:<creatorId>` group, so it never reads the team row after the issue lock (§4.8, §5.7). A future path that creates issues without a creator must carry an explicit flag instead. |
| startedAt, completedAt, canceledAt | timestamptz? | Maintained by the server from category changes (INV-20, §4.6) |
| archivedAt | timestamptz? | Set only by the daily auto-archive job (SPEC-015 §4). Cleared only by restore (SPEC-015). No user edit sets or clears it. A synced field (§5.5). |
| deletedAt, deletedById | timestamptz?, User? | Set by `issue.delete`, cleared by restore (SPEC-015) |
| createdAt, updatedAt | timestamptz | Server time. `updatedAt` moves when an issue field or its description changes, and on restore (SPEC-015 §4.2). It doesn't move for a child row (comment, reaction, attachment) or a label cascade (§4.9). |

**Identifier** = `team.key-number`, derived and never stored. `IssueRef` accepts a UUID or an identifier (SPEC-003 §4). A pending issue has no identifier yet: the client refers to it by id until the delta arrives.

**URL** = `/issue/ENG-42/<slug>`. The slug comes from the title: lowercase words joined by hyphens, letters and digits only, cut at 60 characters on a word boundary (`issueSlug` in `packages/domain`). The slug is cosmetic. Any slug, or none, resolves to the issue, and the client replaces the URL with the current slug. Copy URL copies the slugged URL. The slug of a private team's issue appears only to people who can already see the issue, so it leaks nothing (permissions §5).

### 4.2 Labels on an issue

Labels are a `labelIds` array on the Issue row, not a separate model (Q17). This keeps the eager size within budget (§10), makes optimistic writes deterministic, and leaves no join-table unique index to collide on.

- A label on an issue is a label of the issue's team or a workspace label (INV-06), never a group, and not archived **when added** (SPEC-010 §4.2). An archived label already on an issue stays.
- **One label per exclusive group (INV-07) is enforced when labels are written.** A group is single-select by default (`exclusive`, SPEC-010 §4.2). An operation that adds a label of an exclusive group G removes the issue's other labels of G in the same write (Q6). A multi-select group (`exclusive` false) has no such rule. An operation that adds no label of G leaves G's labels alone. So an issue that carries two labels of an exclusive G, because a label was moved into G after both were applied, or G was switched to single-select (SPEC-010 D20), keeps both until someone adds a label of G. The picker shows the clash (SPEC-012). Linear's behaviour for this case isn't observable; kept.
- At most 20 labels per issue (Q8).
- **Merging:** `addLabels` and `removeLabels` are applied on the server, under the issue row lock (§4.8), to the stored array. Adding a label the issue already has, or removing one it doesn't have, is a no-op for that label, not an error.

### 4.3 IssueContent (content)

One row per issue, `id` = the issue's id:

| Field | Type | Notes |
|---|---|---|
| issueId | Issue | Equal to `id`; the content parent (§5.3) |
| teamId | Team | Denormalised, equal to the issue's `teamId` (§5.1) |
| description | json | Editor JSON (SPEC-013 schema). The empty description is `EMPTY_DOC`, not null. At most 200 KB of JSON (Q9). |
| version | int | Starts at 1, +1 per save |

The server validates `description` with `validateDoc` from `@surface/editor/schema` (SPEC-013). `EMPTY_DOC` and `DOC_SCHEMA_VERSION` live in `packages/domain`, so `packages/operations` can use them. `DOC_SCHEMA_VERSION` feeds `computeSchemaHash`, so a schema change reloads clients.

**Search text is server-only.** The plain text of the description goes in a server-only table, `issue_search_text (issue_id PK → issues ON DELETE CASCADE, description_text)`. The server derives it with the editor package and writes it in the same transaction as the content. It is not a synced field, and optimistic code never computes it. It can't be a column of `issue_content`, because a synced table holds only its model's fields (`apps/server/src/db/README.md`). SPEC-013 does the same for comment text.

### 4.4 IssueHistory (content)

| Field | Type | Notes |
|---|---|---|
| issueId | Issue | The content parent |
| teamId | Team | Denormalised (§5.1) |
| actorKind | `user` \| `api` \| `mcp` \| `system` | |
| actorId | User? | Null for `system`. For `api` and `mcp`, the key's owner. |
| apiKeyId | ApiKey? | For `api` and `mcp` (domain-model §4.10) |
| kind | `created` \| `updated` \| `deleted` \| `restored` \| `archived` | `deleted`, `restored` and `archived` have empty `changes`. `archived` is written only by the auto-archive job (actor `system`). The auto-close job writes an `updated` entry with the status change (actor `system`, SPEC-015 §4.8). Later milestones add theirs (e.g. `moved_team`, `rolled_over`). |
| changes | json | Below |
| createdAt, updatedAt | timestamptz | `updatedAt` moves when an entry is folded (below) |

**`changes`** maps a field to `{ from, to }`.

- A reference is stored **with its display name**, so the entry stays readable after the referenced row is renamed or deleted: `status: { from: {id, name, category}, to: {…} }`, `assignee: { from: {id, name} | null, to: … }`.
- Labels are `labels: { added: [{id, name, color}], removed: […] }`. Attachments (SPEC-014) are `attachments: { added: [{id, kind, title}], removed: […] }`.
- Scalars are plain: `title`, `priority`, `estimate`, `dueDate`.
- The description is `description: true` (changed), never its text.
- **An edit never changes lifecycle state.** Archived and deleted issues are read-only (§6.1), so no edit writes an archive or restore entry. Restore writes one `restored` entry (SPEC-015).
- A `created` entry's `changes` holds only `{ to }`, for each field set at creation that differs from its default (`description: true` when it isn't empty).
- **No snapshot of what a viewer can't see.** An entry never stores the name of a row that some viewer of the issue can't see. In M1 every reference (the team's statuses, team or workspace labels, users, the issue's attachments) is visible to anyone who sees the issue. Later kinds that cross teams (`moved_team`, relations in M3) must store only what the issue's viewers may see, or resolve names when read.

**Activity lines.** The issue page renders each entry from its `kind`, `changes` and actor (SPEC-012). The wording is Linear's:

| Entry | Line |
|---|---|
| `created` | "<name> created the issue" |
| status change | "<name> moved from <A> to <B>" |
| assignee set to the actor | "<name> self-assigned the issue" |
| assignee set to someone else | "<name> assigned the issue to <B>" |
| assignee cleared | "<name> removed assignee" |
| `deleted` | "<name> deleted the issue" |
| `restored` | "<name> restored the issue" |
| `archived` (auto-archive job) | "Issue was automatically archived" |
| status change by the auto-close job (actor `system`) | "Issue was automatically closed" |

SPEC-012 words the other fields in the same style. When the actor kind is `api` or `mcp`, the line and the entry's comments show "via API" or "via MCP" after the name.

**Folding** (FR-ISS-05). Folding happens in the updating transaction, after the issue row lock (§4.8), so two concurrent edits can't lose a fold. The folded row gets a `U` delta.

1. **Creator fold.** A change by the issue's **creator** within 3 minutes of creation is merged into the `created` entry. The field's `to` becomes the new value, and the field is dropped if the new value is its default. Changes by anyone else, or later, get their own entry. Linear folds the same way (Q10). "The creator" is the actor of the `created` entry, matched by kind, user and key: the same person through the API or MCP is someone else. The fold applies only while the `created` entry is still the issue's latest entry (D15).
2. **Description fold.** A `description`-only change by an actor is merged into the issue's latest history entry when that entry is the same actor's `description`-only `updated` entry and is at most 10 minutes old (counted from its `updatedAt`). Otherwise it gets its own entry. This applies to every actor, so autosave (SPEC-013) doesn't flood history.

### 4.5 Numbering and order

- `team_issue_counters` (server-only, SPEC-001) is incremented in the creating transaction with one upsert, `INSERT … ON CONFLICT (team_id) DO UPDATE SET last_number = last_number + 1 RETURNING`, so a team without a counter row gets one. The row lock it takes orders concurrent creates in one team.
- Numbers are **gap-free in commit order**. A create that rolls back also rolls back its counter update, so its number goes to the next create. No number is visible before its create commits, so nothing visible is reused.
- INV-08 is about committed numbers: a committed number is never reused, including after the issue is purged (the counter never goes down). A unique index on `(team_id, number)` backs it.
- **Sort key.** `sortOrder` is global (domain-model §4.6). A new issue goes first: the server computes a key before the lowest key of the team's issues **after** taking the counter row lock, so two creates in one team never get the same key. Keys carry a random suffix (jitter), so creates in two teams at once differ too. Reads order by `(sortOrder, id)`, so even an equal pair has a stable order. The key functions (`keyBefore`, `keyBetween`) are new code in `packages/domain`, with property tests. No dependency is added.

### 4.6 Status changes

Side effects depend only on the **category** entered or left (state-machines §1). A change between two statuses of the same category changes `statusId` and nothing else: moving between two Completed statuses keeps `completedAt`.

| Change of category | Server side effects in the same transaction |
|---|---|
| into Started | `startedAt` set if null; `completedAt`, `canceledAt` cleared |
| into Completed | `completedAt` set; `canceledAt` cleared |
| into Canceled | `canceledAt` set; `completedAt` cleared |
| into Backlog or Unstarted from a closed category (a reopen) | `completedAt`, `canceledAt` cleared. `startedAt` is kept: it records the first start. |
| into Triage or Duplicate | Refused in M1 with `INVALID_INPUT` on `status` ("Triage and Duplicate are set by their own actions"). Triage arrives in M4, Duplicate with relations in M3. |

**INV-20, exactly:**
- In Completed, `completedAt` is set and `canceledAt` is null.
- In Canceled, `canceledAt` is set and `completedAt` is null.
- In Backlog, Unstarted and Started, both are null.
- In Started, `startedAt` is set. Once an issue has been Started, `startedAt` may stay set in any category.
- A create applies the side effects of its initial status's category.

The optimistic update predicts the timestamps with `store.now`; the delta corrects them.

### 4.7 Invariants enforced here

INV-06 (status and labels belong to the team), INV-07 (as written in §4.2), INV-08 (§4.5), INV-20 (§4.6). Each has a unit test on the domain function and an executor test. The child-row `teamId` invariant (§5.1) has a unit test on the repo helpers.

### 4.8 Server write path: `lockIssueForWrite`

Every write to an issue or to one of its children goes through one server helper, `lockIssueForWrite(tx, issueId, ctx, mode)`, with the modes `edit`, `lifecycle` and `cascade` that SPEC-015 §4.4 defines from its rule table. It:

1. takes `SELECT … FOR UPDATE` on the issue row;
2. returns the issue's lifecycle state (live, archived, deleted);
3. applies the lifecycle rule for the mode: `edit` refuses with `CONFLICT` on an archived or deleted issue ("ENG-42 is archived. Restore it to edit it." / "ENG-42 was deleted. Restore it to edit it."), and never changes lifecycle state. `lifecycle` (delete, restore, purge) follows SPEC-015 §4.

Callers: `issue.update`, `issue.updateDescription`, comment and reaction writes (SPEC-013), attachment writes (SPEC-014), and SPEC-015's operations and purge. Label cascades (§4.9) and `system` jobs (auto-archive, auto-close) lock issues in `cascade` mode: they skip the lifecycle rule and may write archived and deleted issues.

**Groups come from the locked issue row.** Today every `repo.update` and `repo.insert` reads the team row `FOR SHARE` to compute sync groups (`apps/server/src/sync/models.ts:61-69`), which would put the team lock **after** the issue lock. In this slice, the repo derives the groups of an Issue and of its children from the issue row the handler already locked. It reads the team row only when `teamId` changes (M3 team moves).

**Lock orders.** Refs are resolved before the transaction's locks, under READ COMMITTED, so a handler **re-reads** every row it relies on (status, labels, the description version) after taking its locks. Label limits and INV-07 are checked on that re-read.

One global order: **workspace row → team row → status and label rows → issue rows, in ascending id → thread root comment.** A writer takes only the subset it needs, so a team label's writer starts at the team row and a workspace label's at the workspace row. (Status rows are in the order because an edit that sets a status takes a key lock on it.) Every writer takes the subset it needs, in that order:

| Writer | Locks, in order |
|---|---|
| `issue.create` | team row `FOR SHARE` (its sync groups) → `FOR KEY SHARE` on the status and labels it writes → the team's counter row (`UPDATE … RETURNING`, a server-only table) → the new issue row |
| Issue and child edits | team row only if `teamId` changes (M3), first → `FOR KEY SHARE` on the status and labels the edit **newly sets**, in id order → issue row `FOR UPDATE` → thread root comment `FOR UPDATE` (comments, SPEC-013) |
| Label cascades (§4.9, SPEC-010 §4.4) | team row (workspace row for workspace labels) `FOR UPDATE` → the label row `FOR UPDATE` → affected issue rows `FOR UPDATE`, in ascending id |
| `label.moveToWorkspace` (SPEC-010 §4.4) | workspace row `FOR UPDATE` → team row `FOR UPDATE` → the label rows `FOR UPDATE`. It takes no issue lock: no issue is read or written. |

Status delete (SPEC-010) is not a cascade: it moves no issue and takes no issue lock, so it adds nothing to this order. It is refused while any issue uses the status, and `ON DELETE RESTRICT` backs that up.

Because every writer follows one order, edits and cascades don't deadlock:
- An edit takes its status and label key locks **before** its issue lock. If a `label.delete` cascade holds that label, the edit waits while holding no issue. When the cascade commits, the edit's re-read finds the label gone and answers `CONFLICT` (E19). A status deleted meanwhile is the same: the re-read, or the foreign key, answers `CONFLICT`.
- A cascade's `FOR UPDATE` on the label waits for edits that already hold a key lock on it. Those edits never wait on the cascade, so they finish. Once the cascade holds the row, no edit can newly add that label, so the set of issues it rewrites is final.
- An edit that doesn't set the status or a label takes no key lock on it. Postgres skips the foreign key check when `status_id` is unchanged.
- Two cascades in one team serialise on the team row.

### 4.9 Label cascades from SPEC-010

These run inside SPEC-010's operations. They are settings changes, not issue edits:
- no history entry, no `issue.updated` event, no `updatedAt` change;
- no lifecycle rule: archived and deleted issues are included and keep their state.

`label.delete` uses `repo.updateWhere` with `touchUpdatedAt: false` (§5.1), takes its locks in the §4.8 order, and holds the global sync lock for its append.

| Cascade | What happens to issues |
|---|---|
| `label.delete` | The label's id is removed from `labelIds` of every issue that has it, archived and deleted ones included. Not reversible. |
| Moving a label into a group (SPEC-010) | No issue is touched (§4.2). |

### 4.10 Migration

One migration adds:

- `issues`, `issue_content` and `issue_history`, with `sync_groups` columns and GIN indexes like every synced table;
- `issue_search_text` (server-only, §4.3);
- foreign keys:
  - to `teams`, `users`, and `workflow_statuses` (`ON DELETE RESTRICT`, so a status can't vanish under an issue);
  - from `issue_content` and `issue_history` to `issues` (`ON DELETE RESTRICT`). Purge deletes these rows explicitly before the issue, through `repo.deleteWhere` with `log: false` (SPEC-015 §4.5, its Q2 decision). A cascade would hide that choice;
- no foreign key from `issue_history.api_key_id` to API keys until M6 adds the keys table; the column is a plain uuid until then;
- no foreign key for `labelIds` (Postgres has no array foreign keys): the handler checks them, and the `label.delete` cascade keeps them clean;
- indexes:
  - the `(team_id, number)` unique index;
  - `(sort_order COLLATE "C", id)` for manual order;
  - a GIN index on `label_ids`;
  - a `pg_trgm` index on `lower(title COLLATE "und-x-icu")` for `contains` filters (PLAN-003 S5 note);
  - `issue_content(issue_id)` and `issue_history(issue_id, created_at)`;
- `archived_at`, `deleted_at` and `deleted_by_id` on `issues`.

Timestamps are `timestamptz(3)`.

## 5. Sync & permissions

### 5.1 Models

| Model | Load | Sync groups (`groupsOf`) | `teamColumn` | Notes |
|---|---|---|---|---|
| Issue | eager, per subscribed team (§5.7) | `team:<teamId>`; for a public team also `user:<creatorId>` and `user:<assigneeId>` (§5.7) | `issues.team_id` | Without the description (sync-protocol §2). Declares `groups`. Archived and deleted rows are not stored on the client (§5.7) |
| IssueContent | content, parent `Issue` by `issueId` | `team:<teamId>` | `issue_content.team_id` | |
| IssueHistory | content, parent `Issue` by `issueId` | `team:<teamId>` | `issue_history.team_id` | |

SPEC-012 adds the `Draft` model (a user's composer and comment drafts, synced in the `user:<id>` group, so every device sees them). It has no `teamColumn` and no content parent, and it is not an issue row. Its schema-hash and sync-property-suite effects are listed in SPEC-012 §12.

- **Child rows carry `teamId`** (D4). Every child row of an issue stores a denormalised `teamId`: IssueContent and IssueHistory here, Comment, Reaction and Attachment in SPEC-013 and SPEC-014. So the API key `teamIds` filter works unchanged, and the child's group `team:<teamId>` needs no join.
  - Invariant: it equals the issue's `teamId`. The repo sets it from the locked issue row, never from input. A child's groups are `team:<teamId>` only, never the issue's `user:` groups (§5.7).
  - Moving an issue between teams (M3) must rewrite it on every child.
- **`defineModel` gains `parent`.** Content models declare `parent: { model: 'Issue', field: 'issueId' }`. It is part of the schema hash.
- **Repo bulk writes.**
  - `repo.flush` inserts `sync_log` rows in chunks of at most 5,000 per statement, to stay under Postgres's limit of 65,535 bind parameters.
  - A new `repo.updateWhere(model, ids, patch, { touchUpdatedAt })` refuses a patch that touches `teamId` (a team change rewrites groups, M3), locks the rows in ascending id, runs one `UPDATE` per chunk, and logs one `U` per row in chunked inserts. `repo.update` always sets `updatedAt` and does a per-row lock and group read (`repo.ts:98-101`), about three queries per issue, so cascades can't use it. Cascades (§4.9) pass `touchUpdatedAt: false`. An **empty patch** is accepted and means "log each row again": it writes no column and logs one `U` with the stored row. `issue.restore` uses it to send an issue's Attachment rows again (§5.7, SPEC-015 §5.1).
  - A new `repo.deleteWhere(model, column, ids, { log })` deletes in bulk and logs one `D` per row, in the same chunks. Purge (SPEC-015) uses it. `log: false` writes no `sync_log` rows. The repo accepts it only for a content model whose parent row is deleted, with a logged `D`, in the same transaction (an assertion in `flush`); clients drop the content of an absent parent (§5.3). It is the one unlogged repo write, for purge (SPEC-015 §4.5, its Q2 decision and the ADR it needs).
  - Budget: at most 2 s for 10,000 rows while holding the global sync lock. This is an accepted rare stall, measured once perf tests resume (⏸).
- Every write goes through the repo layer (`sync/repo.ts`), which logs `sync_log` rows in the same transaction (architecture rule 2).
- In the creating transaction, the repo logs an Issue row **before** its content rows (§5.3).
- The `schemaHash` changes, so connected clients reload once after the deploy (SPEC-002 E7).

### 5.2 Content loading: `GET /sync/content`

First use of sync-protocol §4.2. This is the full contract; it replaces §4.2's two lines on acceptance (§12).

**Request:** `GET /sync/content?parents=issue:<id>,issue:<id>…&userId=<uuid>&schemaHash=<hash>`, with the session cookie, like bootstrap.

- 1–50 distinct parents, each `issue:<uuid>`.
- Unknown or invisible parents are left out of the answer, never an error (§5.6).

**Response:** `application/x-ndjson`, gzip when accepted, decoded by a codec in `packages/sync-protocol`:

```jsonc
{"t":"meta","lastSyncId":18234,"parents":["issue:0193…"],"rows":57}
{"t":"row","m":"IssueContent","d":{"id":"0193…","issueId":"0193…","teamId":"…","description":{…},"version":3}}
{"t":"row","m":"IssueHistory","d":{…}}
…
{"t":"end","rows":57}
```

- `parents` lists the requested parents that were found and are visible. Every one of them is hydrated by this answer, even one with no rows (an issue with no comments).
- Rows are IssueContent, IssueHistory, and SPEC-013's Comment and Reaction. The client store checks each `d` against its model, as for bootstrap.
- All of it is read in one `REPEATABLE READ` snapshot that includes `max(sync_id)`. That is `lastSyncId`, called `C` below.
- `meta.rows` and `end.rows` count the row frames, as for bootstrap, so a truncated stream is detected.
- **Size budget (D16).** One answer holds at most about 4 MiB of row JSON. The server measures each visible parent's rows and takes whole parents in request order while they fit; the first is always taken, however large. A parent it leaves out is absent from `parents`, exactly like an invisible one, so the client doesn't mark it hydrated and asks for it again (alone, or in a later batch). A single-parent request is never cut.

**Errors before the first frame** (SPEC-003 body):

| Status | When |
|---|---|
| `400` | No parents, more than 50, or a malformed or duplicate parent; a `userId` that isn't a UUID; no `schemaHash` (as `POST /sync/mutate`; PLAN-011 S5a) |
| `401` | Not signed in, or signed in as someone other than `userId` |
| `403` | An API key. Content is for sync clients; API callers use `issue.get`. |
| `426 CLIENT_OUTDATED` | No `userId`, or a `schemaHash` that differs from the server's. The client reloads, as for bootstrap. |
| `503` | The server is starting |

### 5.3 Hydration

A parent is **hydrated** when the client holds all of its content and keeps it live.

1. **Hydrating.** When a tab sends a content request, it marks each requested parent `hydrating`, in memory in that tab.
2. **Buffering.** While a parent is hydrating, that tab **buffers** the content packets for it instead of dropping them.
3. **Applying the answer.**
   - The tab stores the answer's rows with version `C`, through the storage's existing per-row version and tombstone rule (`storage/types.ts`).
   - It skips every parent whose Issue row is missing or tombstoned in the replica (for example, purged while the request was in flight). That parent's rows are not stored and it is not marked hydrated, so no orphan rows appear.
   - It marks the found parents hydrated, then replays its buffered packets with id > `C`. Older ones are already in the snapshot.
   - Requested parents that weren't found go back to not hydrated, and their buffer is dropped.
   - A failed request drops the buffer and the mark. The next prefetch or open retries the parent.
4. **Live.** `I` and `U` content packets for a hydrated parent are applied like any delta. `I` and `U` content packets for a parent that is neither hydrated nor hydrating are dropped: they would be partial.
   - **`D` packets for content are always applied, as tombstones**, hydrated or not. An `A`, `V` or `D` packet carries only `mid` (`socket.ts:97-99`, `delta-writer.ts:50-53`), so a tab can't tell a `D`'s parent. Applying it everywhere is safe: a tombstone for a row the tab never held costs one small IDB record, and it makes a later answer at a lower `C` unable to resurrect the row.
   - **Content is dropped when its parent is gone.** After a whole delta batch is applied, the content rows and hydration mark of any parent whose Issue row is now absent are removed. A group change logs `D` then `U` for the same Issue in one batch (sync-protocol §6; the hub never splits the pair), so an issue that stays visible keeps its content. A purge (SPEC-015) leaves the Issue absent, so its content goes.
5. **A created issue is hydrated by its `I` packet.** Every content row of an issue is written in the creating transaction or later, and the repo logs the Issue row first (§5.1). So the `I` packet for an Issue marks it hydrated, for every client that receives it **and whose tab subscribes to the issue's team**. A connection that holds the Issue only through a `user:` group receives the `I` but none of the content rows (§5.7), so it must not mark the issue hydrated. This is a delta rule; optimistic code never touches hydration.
6. **Mutating content hydrates first.** Each content operation declares its parent with `contentParent(input)` in `defineOperation` (a new optional field; SPEC-003 §3 change, §12). When `contentParent` names a content row instead of an Issue (`{ model: 'Comment', id }`, from an operation whose input is a `CommentRef`), dispatch first resolves it to that row's `issueId` through the store; a row the store doesn't hold is treated like a parent that was never hydrated: offline it is refused, and online it is sent without waiting, because the client can't tell which issue to hydrate and the server checks the row (D13). Dispatch **awaits hydration** of that parent, and the parent's rows being paged into memory, before it runs the `optimistic`. So the `I` delta of the confirmed row is never dropped, and the overlay's `find` and `patch` see the parent's rows (§5.4). The seq is taken after the wait, and later dispatches wait behind it in a first-in, first-out chain, so mutations keep the order they were called in. Offline, with a parent that was never hydrated, the UI offers no content edit: the description is read-only and the comment box is hidden (SPEC-013 E20); a dispatch that still arrives (an API or a race) is refused at once with "Available when online" instead of waiting. Online, a parent whose load fails (a server or network error) is refused with "Couldn't load ENG-42. Try again.", not "Available when online" (D14). So no hydration-gated confirmation is needed, and the queue's confirmation rule (sync-protocol §5.1) is unchanged.
7. **Resync** clears every hydration mark with the rest of the replica.

The old rule "skip deltas at or below the answer's `lastSyncId`" is removed. The per-row versions already make an older packet a no-op.

### 5.4 Client storage, cache and prefetch

- **Persistent hydrated set.** The hydrated set lives in IndexedDB, in a store written in the **same IDB transaction** as the content rows it covers. Tabs share it. The keep-or-drop decision for a content packet (§5.3 step 4) reads the shared set, so a parent one tab hydrated is kept live by every tab.
- **Lazy reads.** A warm start doesn't page content models into memory. Content rows are read per parent, through a per-parent IDB index on `issueId`, when an issue is opened or prefetched, or before a content mutation is dispatched (§5.3 step 6). Packets for a hydrated parent that isn't in memory are written to IDB only.
- **Paging in rebuilds the overlay.** The overlay's `find` and `patch` see only rows held in memory (`overlay.ts:133-147`). When a parent's rows are paged in, the overlay is rebuilt, so pending mutations on those rows replay against them. Without this, `comment.update`'s patch would do nothing and `comment.delete`'s `find` would see no replies.
- **Cache size.** At most 2,000 hydrated issues per replica, least recently opened evicted first (Q11). The hydrated mark records `openedAt`: set when the content is fetched, raised when the issue is opened. A parent hydrated by a live `I` packet counts as never opened (D18).
  - Eviction removes a parent's rows and its hydrated mark in one IDB transaction. The rows are deleted, not tombstoned; tombstones stay (D18).
  - A tab holds a shared Web Lock `<replica>:content:<issueId>` while an issue is open (D18). Eviction takes each candidate's lock exclusively with `ifAvailable` and skips any parent whose lock is held, so no tab loses an open issue.
  - Where Web Locks are unavailable (plain HTTP, `locks.ts`), nothing is evicted from a shared replica. An in-memory replica belongs to one tab and is evicted without locks.
  - A tab checks the limit at start, after it stores fetched content, after a live packet hydrates a parent, and when it closes an issue.
- **Prefetch:**
  - open issues assigned to the user in subscribed teams (the 100 most recently updated);
  - the first 50 visible rows of the current list (debounced 200 ms). "Visible" is the list's rendered window, overscan included (D18);
  - an issue on hover, after 150 ms;
  - on an issue page, the issues `J` and `K` open next (D18).

  Prefetch stores content without paging it into memory. It runs only while the socket is `online`, for issues the replica holds in followed teams, and subscribes to nothing. At most 50 parents per request and 4 content requests in flight. Parents already hydrated are not requested. A parent the size budget left out of an answer (D16) is asked for again; an invisible one is not. Opening an issue whose prefetch is in flight waits for it instead of asking twice.
- **Offline:** content that was never hydrated shows "Available when online" (sync-protocol §5.3). This is the state while the socket is offline or retrying after a failed attempt, not while it first connects (E11, D18).
- **Catch-up:** on reconnect, deltas for hydrated parents arrive with catch-up as usual.

### 5.5 Archive state on the wire

Today the repo logs `archivedAt` as bookkeeping, so the client never sees it. The client only has the `$archived` flag that `A` and `V` packets set, and a `V` packet carries only the row id. So the client can't show "Archived on <date>", and it can't restore a row it dropped. From this spec:

- `archivedAt` is a **declared field** on models that archive: Issue here, Label in SPEC-010. The client derives `$archived` from it. A row is archived by the auto-archive job (Issue) or by a user (Label) and restored by restore (SPEC-015).
- `A` and `V` packets carry the **full row** `d` (already in `sync_log.data`). The client applies them as an upsert plus the flag. A `V` for a row the client doesn't hold inserts it.
- The delta writer sends that row through `clientRow`, like `I` and `U`, so `syncGroups` is cut to the connection's groups (`delta-writer.ts:44-48`, SPEC-002 Q6). The raw `sync_log.data` holds every group. AC-10's leak suite checks `A` and `V` frames.
- The frame-level `archived` flag (sync-protocol §4.1) is derived from `archivedAt` from then on (§12).
- **Issues differ from labels on the client:** an archived Label stays in the replica with its flag; an archived or deleted Issue is removed from it (§5.7), and restore's `V` inserts it again.
- `I` still inserts a live row, and `U` still keeps the archived state. Restore emits `V` (SPEC-015). No edit changes the archived state, because archived issues are read-only (§6.1).
- This is sync-protocol v0.7, with a `schemaHash` change (§12). The sync property suite gains a check that archive, restore, delete and label cascades, in any interleaving, equal a fresh bootstrap.

### 5.6 Permissions & visibility

| Operation | Rule |
|---|---|
| Create, update, update the description, get, list, count, groupBy | Any active user who can see the team (permissions §3.3). Non-members of a **public** team can create and edit its issues (triage routing comes in M4). |
| API key / MCP | Mutations need `read_write`; nothing here is `destructive` (permissions §3.5) |

- Private team issues are invisible to non-members. Every `IssueRef` to one is `NOT_FOUND`, worded as for an issue that doesn't exist. Lists, counts and groups leave them out. Bootstrap, catch-up, live deltas and `/sync/content` never carry them or their content (permissions §5).
- **One visibility set for reads.** Every server read path (queries, `IssueRef` resolution, `/sync/content`, `GET /files/:id`) filters with `visibleGroups(actor)`: every group the actor may see, including every public team's `team:<id>`. It never uses a socket's groups, which hold only the subscribed teams (§5.7), so an unsubscribed public team stays readable.
- **API key `teamIds`** narrow in SQL on every read path, because any user may subscribe to a public team's group and a public team's issues also reach `user:` groups (PLAN-003 As built; permissions §3.5).
  - The read paths are `issue.list`, `count`, `groupBy` and `get`, and the resolution of `IssueRef`, `StatusRef` and `LabelRef`.
  - An issue of a team outside the key's teams is `NOT_FOUND`, worded as for one that doesn't exist.
  - Mutations check the same.
- **Subscriptions** (§5.7): a subscription to an unknown team and to a private team the user isn't in are ignored identically, and the partial bootstrap answers both with an empty stream. No `user:` group ever carries a private team's issue or any child row.

### 5.7 Partial issue loading (ADR-0020)

The client holds the issues the user works on, not every issue it may see. Statuses, labels, teams, memberships, users and every other eager model stay fully replicated (sync-protocol §2). This copies Linear (ADR-0020).

**Sync groups of issue rows** (§5.1):

| Row | Groups |
|---|---|
| Issue of a **private** team | `team:<teamId>` |
| Issue of a **public** team | `team:<teamId>`, `user:<creatorId>`, and `user:<assigneeId>` when assigned |
| Child rows (IssueContent, IssueHistory, and SPEC-013/014's Comment, Reaction, Attachment) | `team:<teamId>` only |

- A private team's issue never carries a `user:` group, so leaving the team (or being assigned nothing there) can't leak it.
- An assignee change on a public team's issue changes its groups. The repo logs `D` with the old groups, then `U` with the new ones (sync-protocol §6): the old assignee, if they don't otherwise receive the team, gets the `D`; the new one gets the `U`.
- The Issue model declares a `groups` field (cut to the connection's groups, SPEC-002 Q8), so the client can tell which of its groups keep a row.

**A connection's groups** are `workspace`, `user:<id>`, `team:<id>` for each private team the user is a member of (as today), and `team:<id>` for each **public team the client subscribes to**. The client subscribes to:
- every public team it is a member of (read from its TeamMembership rows), and
- up to **5 other public teams, on demand**: when the user opens that team's issue list or one of its issues. The least recently opened is dropped first. The set is stored in IndexedDB, per replica.

The server accepts a subscription to a public team, or to a private team the user is a member of. Anything else (an unknown id, a private team the user isn't in) is **ignored the same way**, so the answer reveals nothing (§5.6).

**Wire (sync-protocol v0.8):**
- `GET /sync/ws?…&teams=<id>,<id>`: the public teams to subscribe from the start (members and on-demand). Catch-up uses the accepted set. With `teams` the first message is `subscribed` (at `since`); without it (a client from before v0.8) the connection follows every team the user is a member of, public ones included, and gets no `subscribed` (sync-protocol §4.3).
- Client → server `{"t":"subscribe","teams":["…"]}` and `{"t":"unsubscribe","teams":["…"]}`. Server → client `{"t":"subscribed","teams":["…accepted"],"at":<id>}`: from the packet after `at`, the connection receives the team's deltas. An ignored team is left out of `teams`, exactly as an unknown one is.
- Server → client `{"t":"unsubscribed","teams":["…"],"at":<id>}`: no packet of those teams follows `at`. Socket messages are ordered, so every earlier packet of those teams has already reached the client.
- After `subscribed`, the client loads the team with the **partial bootstrap** `GET /sync/bootstrap?groups=team:<id>&userId=…&schemaHash=…` (reserved by sync-protocol §4.1, enabled now). It streams the rows in that group (Issues and their eager children) from one snapshot, with `lastSyncId` = `C`, each row's `groups` cut to the connection's (home groups plus the accepted teams), so the user's own issue keeps `user:<id>`. For a team that is unknown or invisible to the user (including a private team the user isn't in) the answer is **byte-identical** to the one for an unknown id: the same `meta` apart from `lastSyncId` and `serverTime`, and `rows: 0`. It is never an error. The only errors are checked before the first frame, with one `schemaHash` rule for every endpoint (as `/sync/content`, §5.2): no `userId`, or a `schemaHash` that differs from the server's, is `426 CLIENT_OUTDATED`, and the client reloads; no `schemaHash` is `400 INVALID_INPUT`.
- **Writing the answer (`writePartialRows`).** Eager packets carry full rows, so nothing is buffered (unlike content, §5.3). But the in-memory pool keeps no per-row versions, so a plain write of the answer could undo a packet above `C` that arrived during the load. The tab therefore writes the answer through a version-aware storage call, `writePartialRows(rows, C)`:
  - a row is skipped when storage holds a newer version of it, or a tombstone at or above `C`;
  - it starts no new generation, and never moves `meta.lastSyncId` or the tab's `lastSyncId`;
  - the tab applies the same rule to its pool: while a load is pending it remembers, per row, the id of the last packet that changed it, and skips the answer's row (and the sweep's removal) for a row a packet above `C` changed. So a packet above `C` that arrived during the load wins over the answer in the pool and in storage alike. (The pool is not reloaded from storage: storage writes are queued behind live packets, so a reload could undo a later packet; D12.)
  - a child row of the answer is skipped when its issue is gone after the write (a later purge's lone `D`, whose children's deletes are not logged).
- Full bootstrap without `groups` covers the user's home groups: `workspace`, `user:<id>`, and the member teams, public and private. The client then subscribes its on-demand teams again.

**Unsubscribing** (an on-demand team dropped, or the user leaves a public team): the client sends `unsubscribe` and removes the team's rows **only when the `unsubscribed` ack arrives**, because packets of the team may still be in flight before it (none follow it). It then removes every Issue row whose `groups` no longer meet the connection's groups, with its children, content and hydration mark. A row also in `user:<id>` (assigned to or created by the user) stays, **but its content and hydration mark are dropped**, as for every issue of that team: content of such a row would not stay live (below). Leaving a **private** team keeps today's path (`resync(groups)` until M7).

**Several tabs, one replica.** Tabs share one IndexedDB replica (SPEC-002 E5), but each tab has its own socket and subscribes on its own. So a team's rows are complete only while some tab follows the team, and three rules keep a later tab correct:
- **Per-team cursor.** `teamThrough[teamId]` in the IDB `meta` is the sync id through which that team's rows are complete. A tab advances it, for each team it is subscribed to, when it advances its own applied id.
- **Reload on start or reconnect.** A tab that subscribes to team T with `teamThrough[T]` below its `since` (or absent, for example after a partial bootstrap that never finished) runs the partial bootstrap for T again. It then removes T's stored rows that are absent from the answer and older than `C`: they were deleted, archived or moved while no tab followed T.
- **Removal lock.** Every tab subscribed to T holds a shared Web Lock on T, scoped to the replica like the replica's other locks (`<replica>:team:<id>`, written `surface-team:<id>` below). Removing T's rows (an unsubscribe ack, LRU eviction) takes that lock exclusively with `ifAvailable`, and skips the removal if another tab holds it. Without Web Locks, team rows are never removed, as for content eviction (§5.4).

**A team's privacy change must not leak through live subscriptions** (an M7 obligation, with the group rewrite of §5.1): a public to private flip drops `team:X` (or sends `resync(groups)`) for every connection subscribed to X whose user isn't a member, and the hub re-checks the `teams=` list at connect. The flip must also regroup every issue of the team through the repo (`D` then `U`), because an edit infers a public issue from its stored `user:<creatorId>` group: without the regroup, the next edit keeps the `user:` groups.

**Content needs the team's subscription.** Child rows travel only in `team:<teamId>` (above), so content of an issue the client holds only through a `user:` group would not stay live. The client therefore hydrates and prefetches content (§5.3, §5.4) only for issues of subscribed teams. Hydration marks follow the same rule: an Issue `I` marks an issue hydrated only when its team is subscribed (§5.3 step 5). Opening an issue held only through a `user:` group subscribes its team on demand first, like opening any other issue of that team.

**Eager children leave with their issue.** When a delta batch leaves an Issue absent (archive, delete, purge, or a group change that really removes it), the client removes its eager children (SPEC-014's Attachment), its content and its hydration mark **after the whole batch is applied**, so a `D`+`U` group-change pair that keeps the Issue keeps them too (§5.3, sync-protocol §6). An unsubscribe removes them with the team's rows, on the ack. Content models name their issue through `parent`; eager children are listed with their parent field in `EAGER_ISSUE_CHILDREN` (`@surface/domain/model`, the client's `ISSUE_CHILDREN`), which SPEC-014's Attachment joins; the server marks the same models `issueChild`.

**Archived and deleted issues are not stored in the replica:**
- Bootstrap (full and partial) leaves out Issue rows with `archivedAt` or `deletedAt` set, and their children.
- Any `I`, `U`, `A` or `V` packet whose row has `archivedAt` or `deletedAt` set **removes** the Issue from the replica with a tombstone at the packet's id, with its children and hydration mark. (This covers a label-cascade `U` on an archived or deleted issue, which carries the row with its state, §4.9.) A later `V` or `U` of the live row (restore) inserts it again.
- **Restore brings the attachments back.** A restore's `V` or `U` carries only the Issue row, and the client dropped the Attachment rows with the issue. So `issue.restore` logs the issue's Attachment rows again, after the Issue's `V`/`U` and in the same transaction: one `U` each through `repo.updateWhere` with an empty patch and `touchUpdatedAt: false` (§5.1), at most 100 (SPEC-014 D20). Content comes back by hydration when the issue is opened.
- The archive page, the recently deleted tab and an archived or deleted issue's page read from the server: `issue.list` with `includeArchived` and the filter "`archivedAt` is set", `issue.listDeleted` and `issue.get` (SPEC-015). They are read-only (D7), need the network, and show "Available when online" offline. An archived or deleted issue's activity and comments come from one `/sync/content` read held in memory for that page (never stored, not hydrated): the endpoint already returns content of archived and deleted parents the actor can see (SPEC-015 §4.3). They refresh as SPEC-015 §3.3 says: on focus, after the user's own delete and restore confirmations, and on packets of the team when it is subscribed (debounced). Opening them does not subscribe the team.

**What stays local, what asks the server:**

| View or value | Source |
|---|---|
| Lists of member teams, My issues (Assigned, Created), drafts | Replica; offline |
| List of another public team | Replica after an on-demand subscription; "Loading…" until the partial bootstrap is applied; offline and never subscribed: "Available when online" |
| An issue opened by link or ID that the replica doesn't hold | `issue.get`, then a subscription to its team if public and live; the page renders as soon as the row is local |
| Archive page, recently deleted, an archived or deleted issue | Server queries (above) |
| Counts over issues the client may not hold: label usage, issues per status, "N archived issues" | Server queries: `label.usage` (SPEC-010 §6), `issue.groupBy` and `issue.count` (§6.1) |
| Title and ID search in `Mod+K` | The local index (ADR-0008) over held issues; an exact identifier not held falls back to `issue.get` |
| Content prefetch (§5.4) | Issues of subscribed teams only |

## 6. API

### 6.1 Operations

| Operation | Kind | Input → output, notes |
|---|---|---|
| `issue.create` | m | `{id?, team, title, description?, status?, priority?, assignee?, labels?: LabelRef[], estimate?, dueDate?}` → `IssueOutput`. `status` is a `StatusRef` in `team`; `assignee` a `UserRef` (`me` works); `labels` resolve in `team` (SPEC-010). `ui`: **Create issue…** (opens the composer, SPEC-012). |
| `issue.update` | m | `{issue, title?, status?, priority?, assignee?: UserRef \| null, estimate?: int \| null, dueDate?: date \| null, addLabels?: LabelRef[], removeLabels?: LabelRef[]}` → `IssueOutput`. A label in both lists is `INVALID_INPUT`. `ui`: none. A registry entry has one `ui`, so each command ("Change status…", "Assign to me", …) is a SPEC-012 **property command** that dispatches `issue.update` with a partial input (a new SPEC-005 §4 command kind, listed in SPEC-012 §12). |
| `issue.updateDescription` | m | `{issue, baseVersion, description}` → `{issue: {id, identifier}, version}`. `CONFLICT` when `baseVersion` ≠ the stored version. The error carries no extra fields (SPEC-003 §9, D3); the client reads the current version from its replica. Every accepted save raises `version` by one; a save that doesn't change the text moves nothing else (D17). |
| `issue.get` | q | `{issue, fields?}` → `IssueOutput`, with `description` as Markdown and as JSON (Q12). |
| `issue.list` | q | `listInput` (SPEC-003 §7.1: filter, orderBy, limit, cursor, includeArchived, withTotal) plus `team?` → connection of `IssueSummary`. Filters on every M1 field: status and label **names** within `team`, `status.category`, `assignee` (`me`), `creator`, `priority`, `estimate`, `dueDate`, `labels` (has any, has all, has none), and created, updated, completed and archived dates (`archivedAt` is set, for the archive page, §5.7). `orderBy` accepts `archivedAt` too (the archive page sorts by it). |
| `issue.count` | q | `countInput` (filter, `team?`, includeArchived) → `{count}`. |
| `issue.groupBy` | q | `{filter?, team?, includeArchived?, by: 'status' \| 'assignee' \| 'priority' \| 'label'}` → `{groups: [{key, name, count}]}`. `key` is the id (or the priority number), or `null` for "No assignee" and "No label". By label, an issue counts in each of its labels. At most 500 groups. |

- `IssueSummary` = id, identifier, team key, title, status (id, name, category), priority, assignee (id, name), labels (id, name, color), estimate, dueDate, createdAt, updatedAt, completedAt, archivedAt, deletedAt, deletedBy (id, name), url. `url` is absolute: `SURFACE_URL` with `/issue/ENG-42/<slug>` appended, a trailing slash on `SURFACE_URL` dropped (D11).
- `IssueOutput` adds the description, creator, `startedAt`, `canceledAt`, `version`, `attachments[]` (SPEC-014) and `reactions[]` (emoji, count, mine: the reactions on the issue itself, SPEC-013 §4.2).
- `fields` can ask for any path of the full shape (SPEC-003 E6 lands here).

**Lifecycle** (SPEC-015 §4):
- Archived and deleted issues are **read-only**. `issue.update` and `issue.updateDescription` on an archived issue are `CONFLICT`: "ENG-42 is archived. Restore it to edit it." On a deleted issue: "ENG-42 was deleted. Restore it to edit it." The same refusal applies to comment, reaction and attachment writes (SPEC-013, SPEC-014). It holds even when the update would change nothing.
- Edits never unarchive. Restore (SPEC-015) is the only way back.
- `issue.list`, `count` and `groupBy` always leave out deleted issues, and leave out archived ones unless `includeArchived` is set.
- `issue.get` returns both, with `archivedAt` and `deletedAt` set.

Every operation has `summary`, `description`, ≥ 2 keywords, examples that run against the seed fixture, `permission`, and an `optimistic` for the web-used mutations. `pnpm registry:lint` passes. The seed fixture gains a few ENG issues for the examples.

### 6.2 Optimistic updates

Each mutation's `optimistic` predicts the rows the server commits, except server-computed fields (number, `sortOrder`, history, search text).

- `issue.create` inserts the Issue and, if a description was given, the IssueContent (version 1, `teamId` set).
  - The Issue has number `null`, `labelIds` with the group rule applied, `sortOrder` before the lowest key in the store, and category timestamps from `store.now`.
  - The optimistic `sortOrder` takes its jitter from the issue id, never from `Math.random`, so every rebuild of the overlay gives the same key (SPEC-003 §8). The server computes the real key (§4.5); `sortOrder` is a server-computed field like the number.
  - It predicts no history and doesn't touch hydration (§5.3 step 5).
- `issue.update` patches the given fields, `labelIds` (adds, removes and the group rule), the category timestamps on a category change, and `updatedAt`.
- `issue.updateDescription` patches the IssueContent's `description`, `version` (+1) and `updatedAt`, and the Issue's `updatedAt` when the text changes (D17). It predicts nothing for Markdown, for a stale `baseVersion` (the server's `CONFLICT`), or for an archived or deleted issue.
- The web client always sends the description as editor JSON. Markdown input is for API and MCP callers, and the server converts it.

### 6.3 `OptimisticStore` additions

SPEC-003 §8 changes on acceptance (§12):

- **`store.unarchive(model, ref)`** clears the overlay's archived flag and sets `archivedAt` to null. Restore's `optimistic` (SPEC-015) uses it. `store.archive` also sets `archivedAt` to `store.now`.
- **Archived state is readable.** `store.get` and `store.find` return `archivedAt` like any field (§5.5).
- **`store.find(model, fields)`** already exists (added 2026-11-12). It is the lookup by field that the cascades need, for example the issues of a label. **Code change in this slice:** today it returns base rows in iteration order, then draft and layer rows (`overlay.ts:175-180`). It must return its results ordered by id, so replays are deterministic.

No edit's `optimistic` unarchives anything: the UI disables edits on archived and deleted issues (SPEC-012), and the server refuses them. If an issue is archived or deleted by a delta while an edit is queued, the server answers `CONFLICT` and the client rolls the edit back (E26).

### 6.4 Errors

SPEC-003 shape, naming the field:

- "Title is required." · "Title must be 255 characters or fewer."
- "ENG doesn't use estimates. Turn them on in team settings, or leave the estimate empty."
- "5 is not on ENG's fibonacci scale (1, 2, 3, 5, 8)."
- "Bug is a label group. Choose one of its labels."
- "An issue can have up to 20 labels. Remove one first."
- "Triage and Duplicate are set by their own actions."
- Another team's status reads like an unknown one (`NOT_FOUND`, SPEC-003 §4): 'Status "Todo" not found in ENG. Use a status name of that team, or a status id.'
- "That status was deleted. Choose another status." / "That label was deleted. Choose another label." (`CONFLICT`, §4.8)
- "ENG-42 is archived. Restore it to edit it." / "ENG-42 was deleted. Restore it to edit it." (`CONFLICT`)
- "Someone changed this description since you opened it. Your text is kept: copy it, then reload." (`CONFLICT`)
- "Description is too long. Attach the long parts as a file." (`INVALID_INPUT` on `description`: over 200 KB of editor JSON, Q9)

## 7. UI

None in this spec (SPEC-012). The command-menu identifier fast path (`eng-87` → **Open ENG-87**, command-menu §3.1) starts working here because issues exist; it opens `/issue/:identifier` (the client adds the slug, §4.1).

## 8. Edge cases

| # | Case | Behaviour |
|---|---|---|
| E1 | Two clients create issues in ENG at the same moment | Both commit, with consecutive numbers in commit order and different sort keys. Each client shows `ENG-…` until its own delta arrives. |
| E2 | An issue is created offline and the app reloads before it reaches the server | It stays in the overlay as `ENG-…` (the queue survives reloads, SPEC-002) and gets its number on reconnect. |
| E3 | A create is rejected (e.g. a label was archived meanwhile) | The overlay row disappears and a toast explains why. Its transaction rolled back, so the next create gets the number it would have had. |
| E4 | Two people change the same field at once | Server order wins (NFR-07). Each change gets its own history entry, unless a fold applies (§4.4). |
| E5 | Two people add different labels at once | Both stay: the server merges add intents under the issue lock. |
| E6 | Two people add different labels of the same exclusive group at once | The later commit's label replaces the earlier one (INV-07). History shows both changes. |
| E7 | The same label is added twice at once | The second add is a no-op for that label; no error. |
| E8 | The scale changes after an estimate was set | The estimate stays; it is shown off-scale (SPEC-010 E5). A later `issue.update` that doesn't touch `estimate` doesn't revalidate it. |
| E9 | An assignee is deactivated (M7) | Out of scope here; `UserRef` refuses inactive users for new assignments (SPEC-003 Q5). |
| E10 | The description is edited in two tabs | The second save gets `CONFLICT` (§3.3). |
| E11 | An issue is opened offline before its content was ever fetched | The title and properties show; the description and history say "Available when online". |
| E12 | `issue.update` changes nothing (same values) | On a live issue it succeeds, writes no history, emits no event, and returns the issue. On an archived or deleted issue it is `CONFLICT` like any edit (§6.1). |
| E13 | An identifier doesn't exist, is in a private team the actor can't see, or is in a team outside the API key's teams | `NOT_FOUND`, worded the same for all three. |
| E14 | Team keys | Don't change in v1 (FR-TEAM-08 is v2). Aliases (`IssueIdentifierAlias`) arrive with team moves in M3. |
| E15 | Content arrives for an issue whose row the client doesn't have | Ignored; the client never stores content without its parent. |
| E16 | A history entry names a status, label or user that was later renamed or deleted | It shows the stored name from the time of the change. |
| E17 | A comment is written while the issue's content request is in flight | The tab buffers the packet and applies it after the answer (§5.3); the comment shows. |
| E18 | Tab A hydrates an issue while tab B has it closed | B keeps the issue live from then on, because the hydrated set is shared (§5.4). Opening it in B reads from IDB. |
| E19 | A status is deleted (it had no issues) while an `issue.update` into it is in flight | The edit's re-read, or the foreign key, fails: `CONFLICT`, "That status was deleted. Choose another status." The client rolls back. |
| E20 | The issue is archived or deleted and a `label.delete` removes a label from it | It keeps its state; `updatedAt` and history don't change (§4.9). |
| E21 | Autosave saves the description five times in a minute | One history entry, folded (§4.4). Each save still sends the full IssueContent row to every connection subscribed to the team (§10). |
| E22 | An `issue.update` adds label L while `label.delete` of L is running | If the edit took its key lock first, the cascade waits for it and then rewrites that issue too. Otherwise the edit waits, then finds L gone: `CONFLICT`, "That label was deleted. Choose another label." No deadlock, no half-done cascade (§4.8). An edit into status S racing `status.delete` of S ends the same way (E19), or SPEC-010 refuses the delete because the issue now uses S. |
| E23 | An issue is purged while a content request for it is in flight | The tab applies the Issue `D` first. When the answer arrives, that parent is skipped: no rows stored, not hydrated (§5.3). |
| E24 | An issue moves to a team the user can still see (M3), or its team's privacy changes | The repo logs `D` then `U` for the Issue in one batch. After the batch the Issue is present, so its content and hydration mark stay (§5.3). |
| E25 | A comment is deleted on an issue this tab never hydrated | The `D` is stored as a tombstone. A later content answer at a lower `C` can't bring the comment back. |
| E26 | An issue is archived (auto-archive) or deleted while a queued edit of it is waiting to be sent | The server answers `CONFLICT` (§6.1), the client rolls the edit back and a toast says why. Nothing is unarchived. |
| E27 | The URL has a wrong or missing slug (`/issue/ENG-42/old-title`) | It resolves to ENG-42 and the client replaces the slug with the current one (§4.1). A wrong identifier is `NOT_FOUND` (E13). |
| E28 | Issue ENG-42 (public team ENG, user not a member) is assigned to the user | The repo's `D`+`U` pair adds `user:<id>` to its groups; the user receives the `U` and the issue shows in My issues, without subscribing to ENG (§5.7). |
| E29 | It is reassigned away from the user | The user gets the `D` and the issue leaves the replica, unless they created it or subscribe to ENG. |
| E30 | A packet above `C` (an `A`, a `D`, or a delete's `U`) for a team arrives before that team's partial bootstrap answer | Applied at once (full rows). The answer is written through `writePartialRows(rows, C)`, which skips a row that storage holds newer or as a tombstone at or above `C`; the pool skips the rows a packet above `C` changed during the load. The packet is not undone (§5.7). |
| E31 | The user opens a sixth non-member team | The least recently opened on-demand team is unsubscribed and, on the `unsubscribed` ack, its rows removed, except the user's own issues (`user:` group), whose content and hydration marks are dropped (§5.7). |
| E32 | A client asks to subscribe to a private team it isn't in, or a team id that doesn't exist | Both are ignored identically, and the partial bootstrap for either is an empty stream (§5.6). |
| E33 | An issue the user has open is archived by the job or deleted in another tab | The packet removes it from the replica; the open page switches to the read-only view fed by `issue.get` (SPEC-012 E3). |
| E34 | Offline, the user opens a non-member team's list or the archive page | "Available when online". Member teams and My issues still work. |
| E35 | Two tabs of one user follow different teams (one opened team T on demand, the other did not), or a tab starts after T's rows went stale | A tab updates the shared replica only for the teams it is subscribed to, and advances `teamThrough` for them. A tab that subscribes to T with `teamThrough[T]` below its `since` reruns T's partial bootstrap and removes T's stored rows that are absent from the answer and older than `C` (§5.7). |
| E36 | A tab unsubscribes from T (or LRU drops it) while another tab is subscribed to T | The removal takes `surface-team:T` exclusively with `ifAvailable`, finds it held, and skips. T's rows stay. Without Web Locks, team rows are never removed (§5.7). |

## 9. Acceptance criteria

> **Held:** tests that need a browser, a running stack or Postgres are not written for now ([plans README §6](../07-plans/README.md#6-testing-hold-e2e-smoke-and-integration)), except private-team leak tests and the sync property suite.

| AC | Criterion | Test |
|---|---|---|
| AC-1 | `issue.create` validates title, status, priority, assignee, labels, estimate and due date (§4.1). It defaults status to the team's default and priority to 0. | unit |
| AC-2 | Numbers are sequential per team in commit order, with no gaps. Concurrent creates never share a number or a sort key. A rolled-back create's number goes to the next create. A committed number is never reused, including after purge. | sync property suite (real server: concurrent creates in one team, with rejected creates) + unit (`keyBefore`/`keyBetween` properties) |
| AC-3 | Status changes apply the side effects of §4.6 only on a category change, and INV-20 (as defined in §4.6) holds after any sequence of status changes. Triage and Duplicate are refused. | unit + property |
| AC-4 | Label rules: team or workspace labels only; never a group; never newly an archived label; adding one of an exclusive group removes the others of that group, and a multi-select group keeps them; at most 20. Add and remove intents from two clients merge; a duplicate add is a no-op. | unit + sync property suite (two clients, label adds and removes, same-group adds) |
| AC-5 | History: one entry per changing operation, with every changed field. References carry names. Key actors get `apiKeyId`. Creator changes within 3 minutes fold into `created`. Description-only changes by one actor within 10 minutes fold. No-op updates write nothing. `deleted`, `restored` and `archived` entries have empty `changes`. | unit |
| AC-6 | `issue.updateDescription` bumps the version, rejects a stale `baseVersion` with `CONFLICT` (no extra fields), and writes the search text to `issue_search_text`. | unit + integration ⏸ |
| AC-7 | Each mutation's `optimistic` produces the rows the server commits, apart from server fields (number, `sortOrder`, history, search text). Rebuilding the overlay twice gives identical rows (the optimistic `sortOrder` jitter comes from the issue id; `store.find` is ordered by id). | unit |
| AC-8 | The sync property suite (SPEC-002 AC-2/AC-3) runs with Issue operations and **content models** in its generator, and stays green at 1,000 cases. The generator interleaves content fetches with deltas, content deletes, purges, group changes (`D`+`U` pairs), socket drops and evictions, and compares with a fresh fetch (E23–E25). | sync property suite |
| AC-9 | `GET /sync/content` follows §5.2: visible parents only, rows consistent with `lastSyncId`, the error statuses, and truncated streams detected. Hydration follows §5.3: buffered packets are replayed after the answer, an Issue `I` hydrates the issue (only when its team is subscribed), and a content mutation on a parent that isn't hydrated hydrates it first. | unit (codec, client hydration with a fake server) + integration ⏸ (endpoint) |
| AC-10 | Private-team leak: a non-member's bootstrap, catch-up, deltas and `/sync/content` carry no row of the team's issues, content or history. Every operation naming such an issue is `NOT_FOUND`. `issue.list`, `count` and `groupBy` exclude them. An API key limited to team A gets the same for a public team B. | integration (leak test, not held) |
| AC-11 | `issue.list` filters on every field of §6.1, and the client evaluator and SQL compiler agree on the Issue model. This re-runs the PLAN-003 S5 conformance harness for Issue, through the real codec. | integration (conformance; allowed under the testing hold, Q13) |
| AC-12 | Every operation passes `pnpm registry:lint`; its examples run against the seed fixture. | unit |
| AC-13 | Creating an issue by keyboard in one tab shows it in another in < 150 ms p95; opening a hydrated issue takes < 100 ms (NFR-01, 02). | e2e perf ⏸ (checked by hand) |
| AC-14 | The average JSON size of an Issue row over the seed distribution (titles, label counts and nullable fields as in §10) is at most 650 bytes. A replica's eager total at the reference scale fits the per-replica 35 MB budget (§10, Q15), measured for the **worst case** (the member teams plus the 5 largest on-demand teams), not only the seed's team split. | unit (row size, worst-case total from the seed distribution) + perf ⏸ (total) |
| AC-15 | No issue ever points at a missing status. `issues.status_id` is `ON DELETE RESTRICT`, and an `issue.update` into a status deleted meanwhile is `CONFLICT` (E19). Status delete itself is SPEC-010's (refused while any issue uses the status). | unit (re-read handler) + integration ⏸ (foreign key) |
| AC-16 | Moving a label into a group touches no issue. The next add of a label of that exclusive group removes the issue's other labels of it (§4.2). This is the issue half of SPEC-010 AC-10, as SPEC-010 decides it. | unit |
| AC-17 | `label.delete` removes the label from `labelIds` of every issue that has it (live, archived, deleted), with no history, event, `updatedAt` or lifecycle change. This is the issue half of SPEC-010 AC-12. | integration ⏸ + unit (cascade function) |
| AC-18 | Archive on the wire (§5.5): `A` and `V` carry the full row; a `V` for a missing row inserts it; archive, restore, delete and label cascades in any interleaving equal a fresh bootstrap. | unit (codec, pool) + sync property suite |
| AC-19 | A child row's `teamId` always equals its issue's `teamId`; the repo sets it from the locked issue row. | unit |
| AC-20 | Lock order (§4.8): issue edits, comment writes and label cascades never deadlock. An edit racing a `label.delete` either is rewritten by the cascade or answers `CONFLICT`; no issue is left pointing at a deleted label (E22). | sync property suite (real server: concurrent edits and cascades) |
| AC-21 | `repo.updateWhere` locks rows in ascending id, leaves `updatedAt` alone when `touchUpdatedAt` is false, logs one `U` per row in chunks of at most 5,000, and accepts an empty patch as "log the row again", and refuses a patch that touches `teamId`; `repo.deleteWhere` logs one `D` per row the same way, and accepts `log: false` only for a content model whose parent is deleted with a logged `D` in the same transaction. | unit (statement builder) + integration ⏸ |
| AC-22 | Dispatching a content mutation awaits hydration of its `contentParent` and pages its rows into memory, and the overlay rebuild then replays pending mutations on them. Offline with an unhydrated parent, the UI offers no content edit. | unit (fake server, fake-indexeddb) |
| AC-23 | Archived and deleted issues are read-only: `issue.update`, `issue.updateDescription` and the child writes of SPEC-013 and SPEC-014 answer `CONFLICT` with the §6.4 message, even for a no-op, and change no lifecycle state. `cascade` and `system` writes still succeed. | unit (lock helper) + integration ⏸ |
| AC-24 | `issueSlug` gives lowercase hyphenated words, at most 60 characters, on a word boundary, and an empty slug for a title with no letters or digits. `/issue/ENG-42` with any slug resolves to the same issue (E27). | unit (property) |
| AC-25 | The activity line of each entry kind follows §4.4: created, moved from A to B, self-assigned, assigned to B, removed assignee, deleted, restored, automatically archived, automatically closed, and the "via API" / "via MCP" suffix. | unit (line formatter in `packages/domain`) |
| AC-26 | Partial loading (§5.7): a full bootstrap carries the live issues of the user's member teams and the live issues of public teams assigned to or created by the user, and nothing else; no archived or deleted issue; child rows carry only `team:<teamId>`; a private team's issue never carries a `user:` group. | unit (groups builder) + integration ⏸ (bootstrap contents) |
| AC-27 | Subscribing to a public team loads its live issues through the partial bootstrap and keeps them live; unsubscribing removes them on the `unsubscribed` ack, except rows still in the user's groups (whose content and hydration marks are dropped); at most 5 on-demand teams. A packet above `C` that arrives before the answer is never undone (`writePartialRows`). With several tabs, a team whose `teamThrough` is behind is reloaded and swept, and its rows are not removed while another tab holds `surface-team:<id>` (E35, E36). Subscribes, unsubscribes, reassignments, archives, deletes and restores, interleaved with deltas and socket drops, leave a replica equal to a fresh bootstrap with the same subscriptions. | unit + sync property suite (not held) |
| AC-28 | Private-team leak through subscriptions: a non-member's `subscribe` to a private team and a `?groups=team:<id>` partial bootstrap behave exactly as for an unknown team (ignored and absent from the `subscribed` ack; the partial bootstrap is byte-identical to an unknown team's, apart from `lastSyncId` and `serverTime`); no `user:` group delivers a private team's issue or any child row. | leak test (not held) |
| AC-29 | An archived or deleted Issue is never stored on the client: bootstrap leaves it out, and any `I`, `U`, `A` or `V` whose row has `archivedAt` or `deletedAt` set removes it with its children; a later restore `V` or `U` inserts it again, and the restore's Attachment `U`s bring its attachments back. | unit + sync property suite (not held) |

## 10. Metrics & performance

- `issue.create` and `issue.update` p95 < 50 ms on the server, excluding the network.
- Optimistic render of a property change < 16 ms; opening a hydrated issue < 100 ms (NFR-01).
- `/sync/content` for 50 issues p95 < 200 ms on a LAN.
- **Eager size, measured** on compact JSON of realistic rows:
  - A full Issue row is 708 bytes: 2 labels, a 60-character title, an assignee, an estimate and two category timestamps.
  - A sparse one is 517 bytes: no labels, assignee, estimate or timestamps, and a short title.
  - The average is about 610 bytes, so all 100k issues would be ≈ 61 MB raw, over sync-protocol §2's 35 MB. With partial loading (§5.7, Q15) a replica holds only its subscribed teams' live issues and the user's own: a user in teams holding 40k live issues has ≈ 24 MB. The 35 MB budget stays and is now **per replica**. It is measured at the reference scale for the worst case: the member teams plus the 5 largest on-demand teams, not only the seed's team split (§12).
  - **Tombstones accumulate.** Each removed issue leaves a tombstone in IndexedDB (so an older packet can't bring it back), and they are not counted in the budget above. They are compacted when the replica is re-bootstrapped (a schema change, a resync or a sign-out). Compacting them earlier is a follow-up if the perf test shows it matters.
- **Bandwidth of descriptions.** Each description save sends the full IssueContent row (up to 200 KB) to every connection subscribed to the team's group, hydrated or not, because the hub doesn't know what a client has hydrated. Autosave is debounced (on blur, or after 2 s idle, SPEC-013), so a typical edit session sends a few rows, not one per keystroke. `sync_log` keeps each for 30 days.
- Log events: none new (history is the record; the queryable audit log is M7).

## 11. Open questions

None. Every question has been decided; see the Decisions table below.

### Decisions

| # | Decision | Date |
|---|---|---|
| Q2 | No issue is created in or moved to Triage or Duplicate in M1 (§4.6). Both need features of later milestones. | 2026-11-12 |
| Q3 | Anyone who can see a public team can create and edit its issues (permissions §3.3). Triage routing for non-members is M4. | 2026-11-12 |
| D1 | Issue numbers are gap-free in commit order, and INV-08 covers committed numbers (§4.5). In Postgres, a rolled-back counter update can't leave a gap, so the earlier "gaps on rollback" wording was wrong. | 2026-11-12 |
| D3 | A description `CONFLICT` carries no `currentVersion`. SPEC-003 §9 error bodies have no details field, and the client has the current version in its replica. | 2026-11-12 |
| D4 | Child rows of an issue carry a denormalised `teamId` (§5.1), so sync groups and API key team filters reuse the team-row path. | 2026-11-12 |
| D5 | Lock orders (§4.8): issue edits take `FOR KEY SHARE` on the status and labels they newly set, then lock the issue; label cascades lock the team (or workspace) row, then the label `FOR UPDATE`, then issues in id order. One global order: workspace → team → status/label → issue → thread root. Groups come from the locked issue row. This has no cycle, so it replaces the earlier exception that relied on deadlock retries (review round 2: `repo.update` reads the team row after the issue lock today). | 2026-11-12 |
| D6 | Copy Linear: the issue URL carries a title slug, `/issue/ENG-42/<slug>`. Any slug resolves, and the client replaces it with the current one (§4.1). | 2026-11-12 |
| D7 | Copy Linear: archived and deleted issues are read-only. Every edit, comment, reaction and attachment write is `CONFLICT` ("ENG-42 is archived. Restore it to edit it."). Nothing unarchives on edit, so the optimistic code's predicted unarchive, the `archived: {from,to}` history field and the `unarchived` entry are gone. Restore is the only way back. Reverses D2. Label cascades and system jobs still write these issues (§4.8, §4.9). | 2026-11-12 |
| D8 | Copy Linear: a status can't be deleted while any issue uses it, so there is no `status.delete` cascade, replacement or lock-order exception here. SPEC-010 owns the refusal. Reverses the status half of D5. | 2026-11-12 |
| D9 | Copy Linear: activity lines read "<name> created the issue", "moved from A to B", "self-assigned the issue", "assigned the issue to B", "removed assignee", "deleted the issue", "restored the issue", and "Issue was automatically archived". Lines show "via API" or "via MCP" for those actors. History kinds are `created`, `updated`, `deleted`, `restored`, `archived` (§4.4). | 2026-11-12 |
| D10 | Copy Linear: label groups are single-select by default (`exclusive`), so INV-07 and the replace-on-add rule apply only to exclusive groups (§4.2). | 2026-11-12 |
| D11 | Copy Linear: `url` is absolute, built from `SURFACE_URL` (§6.1). The client builds the same shape from the page's origin when it needs one. | 2026-11-13 |
| D12 | PLAN-011 S4c as built (§5.7): the pool applies a partial answer by an in-memory "changed above `C`" guard instead of reloading the rows from storage, because storage writes queue behind live packets; the team lock is named per replica (`<replica>:team:<id>`); eager issue children are a fixed list (`ISSUE_CHILDREN`) rather than a runtime registration. A row's `groups` in a shared replica is cut to the connection of the tab that wrote it last, so its public `team:` groups can differ between tabs; the client decides on followed `teamId`s and the `user:` group, which every tab's connection has. | 2026-11-13 |
| D13 | PLAN-011 S5b as built (§5.3 step 6): a content mutation whose `contentParent` names a content row the store doesn't hold is sent online without waiting for hydration (there is no issue to hydrate; the server resolves and checks the row), and refused offline with "Available when online". | 2026-11-16 |
| D14 | PLAN-011 S5b review (§5.3 step 6, E11): a content mutation whose parent fails to load while the connection is up (a server or network error) is refused with "Couldn't load ENG-42. Try again." (`ContentLoadFailedError`). "Available when online" stays for offline, never-hydrated parents, where waiting for the connection is the fix. | 2026-11-16 |
| D15 | PLAN-011 S6 as built (§4.4): both folds merge only into the issue's **latest** entry, so an entry never changes after a later one exists. The creator fold also needs the same actor identity as the `created` entry (kind, user and key): an API or MCP change by the creator is its own entry, so its "via API" line stays. | 2026-11-16 |
| D16 | PLAN-011 S6 as built (§5.2): a content answer is capped at about 4 MiB of row JSON (`CONTENT_ANSWER_BUDGET_BYTES`), by whole parents in request order, the first always taken. A left-out parent is absent from `meta.parents`, as an invisible one is, and the client asks again. No wire change: S5b's client fetches one parent per request, and S7's prefetch retries the parents left out. | 2026-11-16 |
| D17 | PLAN-011 S6 as built (§4.1, §6.1): a description save whose text equals the stored one (compared as JSON, key order ignored) raises `version` only. The issue's `updatedAt`, the history and the `issue.updated` event stay, as an `issue.update` that changes nothing writes nothing (E12). The version still moves, but a client must not rely on that to chain saves: a second save sent with a *predicted* `baseVersion` overwrites someone else's edit when the first save is refused, because the second then matches the other person's version. So the editor keeps one save in flight, drops any queued save on `CONFLICT` instead of sending it, and saves only when the text changed (PLAN-012 S4b). | 2026-11-16 |
| D18 | PLAN-011 S7 as built (§5.4): the content lock is named per replica, `<replica>:content:<issueId>`, like the team lock (D12), so two replicas in one browser never block each other. Eviction deletes a parent's live content rows (tombstones stay), so a refetch starts clean. An in-memory replica is evicted without Web Locks, since one tab owns it. Prefetch stores rows without paging them in, so a prefetched issue costs no memory until it is opened; its mark counts from the fetch, and a mark from a live `I` packet counts as never opened. Copy Linear: an issue page also prefetches the issues `J` and `K` open next, and a list prefetches its rendered window (overscan included) rather than exactly the rows on screen. "Available when online" (E11) shows once a connection attempt has failed, not during the first connect. A tab that keeps an issue open while it is deleted or archived and then restored reloads its content when the row comes back (found by PLAN-015 S2). | 2026-11-16 |
| Q13 | The filter conformance run for Issue (Postgres) is allowed under the testing hold, as an exception the user granted at the M1 gate. | 2026-11-12 |
| Q15 | Copy Linear: partial issue loading (§5.7, ADR-0020) instead of raising the budget. The 35 MB eager budget stays, per replica. VISION §6 changes with it (§12). | 2026-11-12 |
| Q18 | Description history stays v2 (PRD FR-ISS-14); M1 shows only the "updated the description" activity line. | 2026-11-12 |
| Q1 | The M3/M4 columns (project, milestone, cycle, parent, triage, snooze) come with their features. Each milestone adds its columns and model fields in its migration, so M1 doesn't ship fields nothing can set. The `schemaHash` change then is a reload, not a migration problem. PRD FR-ISS-03 is updated to match (§12). Accepted as proposed at the M1 gate. | 2026-11-12 |
| Q4 | Description conflicts use a version check from day one, before the merge UI (FR-COL-10, M4). On `CONFLICT` the editor keeps the user's text and offers "Copy my text" and "Discard and reload". No silent overwrite. Accepted as proposed at the M1 gate. | 2026-11-12 |
| Q5 | Titles have no line breaks: they are replaced by spaces. Accepted as proposed at the M1 gate. | 2026-11-12 |
| Q6 | Copy Linear: adding a label from an exclusive group the issue already has a label of replaces the old one in the same operation. A multi-select group keeps both. Accepted as proposed at the M1 gate. | 2026-11-12 |
| Q7 | A new issue goes first in manual order (a key before the team's lowest), until M2 adds manual ordering controls. Linear's behaviour is not observable. Accepted as proposed at the M1 gate. | 2026-11-12 |
| Q8 | An issue has at most 20 labels. Linear's behaviour is not observable. Accepted as proposed at the M1 gate. | 2026-11-12 |
| Q9 | A description is at most 200 KB of editor JSON. Images are files (SPEC-014), not inline data. Accepted as proposed at the M1 gate. | 2026-11-12 |
| Q10 | History folding: creator changes within 3 minutes fold into `created` (FR-ISS-05); description-only changes fold per actor within 10 minutes (§4.4); other rapid edits are separate entries. Linear's behaviour is not observable. Accepted as proposed at the M1 gate. | 2026-11-12 |
| Q11 | The content cache holds 2,000 hydrated issues per replica, least recently opened evicted first, never one that is open in a tab. Accepted as proposed at the M1 gate. | 2026-11-12 |
| Q12 | API and MCP callers get the description as both Markdown and editor JSON, and may send either (`description` as a Markdown string or a JSON object), converted by the shared editor schema (SPEC-013). MCP clients work in Markdown. The web client always sends JSON. Accepted as proposed at the M1 gate. | 2026-11-12 |
| Q14 | A pending issue (no number yet) has the route `/issue/<id>` until the number arrives. Then the URL is replaced with `/issue/ENG-42/<slug>` (§4.1), without a new browser history entry. Accepted as proposed at the M1 gate. | 2026-11-12 |
| Q16 | BroadcastChannel (SPEC-002 §2 says M1) is deferred to "later, if measured". Each tab keeps its own socket; the shared IDB with per-row versions keeps tabs consistent, and eviction uses Web Locks (§5.4, §5.7). A channel would only save duplicate work. SPEC-002 §2 and architecture.md change (§12). Accepted as proposed at the M1 gate. | 2026-11-12 |
| Q17 | Issues hold labels as `labelIds`, not an IssueLabel model (domain-model lists IssueLabel), for three reasons: the size budget (an IssueLabel row is ≈ 200 bytes, so ~40 MB at 100k issues with 2 labels each), deterministic optimistic writes, and no unique-index races. Filters, grouping and the history entry don't change. domain-model changes (§12). Accepted as proposed at the M1 gate. | 2026-11-12 |

## 12. Changes to accepted docs on acceptance

These are not edited until this spec is accepted. Each needs a dated "what changed" note in the doc. Partial issue loading (§5.7) changes ADR-0002's "full metadata replica" clause, so ADR-0020 supersedes that clause; nothing else contradicts an accepted ADR.

| Doc | Section | Exact change | ADR? |
|---|---|---|---|
| sync-protocol | §2 | Content models declare a parent (`parent: {model, field}` in `defineModel`). Issue is eager **per subscribed team** (§5.7): archived and deleted issues and other teams' issues are not bootstrapped. The 35 MB budget is per replica (Q15). | ADR-0020 |
| VISION | §6, third non-goal | "No partial *metadata* sync" becomes "partial *issue* sync only (ADR-0020); every other metadata model stays fully replicated". | ADR-0020 |
| ADR-0002 | Status line only | "Superseded in part by ADR-0020 (the full metadata replica clause)". | ADR-0020 |
| sync-protocol | §4.1, §4.3, §6 | Partial bootstrap `?groups=team:<id>` enabled (byte-identical for unknown and invisible teams, `rows: 0`); `teams` on the socket URL; `subscribe`, `unsubscribe`, `subscribed` and `unsubscribed {teams, at}` messages (the client removes a team's rows on the ack); a connection's groups add the subscribed public teams; bootstrap leaves out archived and deleted issues; an `A` or delete `U` removes an Issue on the client. v0.8. | ADR-0020 |
| permissions | §2 | Issues and their children are in `team:<id>` for public teams too; a public team's issue is also in `user:<creatorId>` and `user:<assigneeId>`; any active user may subscribe to a public team's group; children keep `team:<id>` only. Two obligations for later milestones, recorded here so they are not missed: (M7) a team's public to private flip drops `team:X`, or sends `resync(groups)`, for every connection subscribed to X whose user isn't a member, and the hub re-checks the `teams=` list at connect; (M3) an IssueRelation's groups can't be the intersection of its two issues' `team:` groups, which is empty for two public teams, so M3 must define them (for example the union, since both teams are public). | ADR-0020 |
| sync-protocol | §1 (Authority) | Name the two client-side base removals that no packet drives: content eviction (§5.4) and team removal on the `unsubscribed` ack and on LRU (§5.7). Both only remove rows the server already stopped sending, under the Web Lock rules. | ADR-0020 |
| SPEC-002 | §2, E5 | Multi-tab: tabs share one replica and each has its own socket, so the meaning of the replica cursor changes. `meta.lastSyncId` says what one tab applied; completeness of a team's rows is `teamThrough[teamId]` (§5.7). Add a decision row. | ADR-0020 |
| ADR-0008 | none (note in ADR-0020) | The client index covers held issues; an identifier not held falls back to `issue.get`. | No |
| sync-protocol | §4.1 | Drop "a later `V` packet carries only the id"; `archivedAt` is a field of models that archive, and the frame's `archived` flag is derived from it (§5.5). | No |
| sync-protocol | §4.2 | Replace it with the contract of §5.2 and the hydration rules of §5.3: buffering; an `I` hydrates; content `D`s always apply as tombstones; answers skip parents whose Issue is gone; content is dropped when its Issue is absent after a batch; a content mutation hydrates its parent first. | No |
| sync-protocol | §4.3 | `A` and `V` carry the full row `d`, through `clientRow` (groups cut to the connection's); a `V` for a missing row inserts it (§5.5). | No |
| sync-protocol | §6 | A group change's `D`+`U` pair keeps the row's content on clients that still see it, because content is dropped only when the Issue is absent after the whole batch (§5.3). | No |
| sync-protocol | §8 | The schema hash input gains each model's `parent` declaration (and SPEC-013's `DOC_SCHEMA_VERSION`). | No |
| sync-protocol | §5.4 | The description conflict carries no `currentVersion`. The client keeps the user's text (Q4) until the M4 merge UI. A status deleted meanwhile is `CONFLICT` (already the example). | No |
| sync-protocol | §9 | Prefetch: open issues assigned to me (100 most recent), the first 50 visible rows, hover after 150 ms; no "current cycle" until M3. Content cache: 2,000 issues. At most 4 content requests in flight. | No |
| sync-protocol | §10, §11 | Content models and archive interleavings join the property suite. Change log: v0.7 (A/V full rows, a `schemaHash` change; PLAN-011 S2); v0.8 (partial issue loading, the row above; PLAN-011 S4b); then the `/sync/content` contract and content models, whose `parent` field changes the `schemaHash` without a version bump of its own (PLAN-011 S5a). | No |
| SPEC-002 | §2 | Content models: delivered by SPEC-011/013. BroadcastChannel: "Later (optimisation)", per Q16. Add a decision row for archive state on the wire (§5.5). | No |
| SPEC-003 | §4 | `IssueRef` (UUID or identifier) narrows by API key `teamIds`. | No |
| SPEC-003 | §7.1 (line 197) | "Cycle-relative values arrive with cycles (M3)", not M1. | No |
| SPEC-003 | §3 | `defineOperation` gains an optional `contentParent(input)`, naming the content parent a mutation writes under; dispatch awaits its hydration (§5.3 step 6). | No |
| SPEC-003 | §8 | Add `store.unarchive` (for restore); `store.archive` sets `archivedAt`; archived state is readable through `archivedAt`; `store.find` results are ordered by id (a code change); the overlay is rebuilt when content is paged in. `sortOrder` joins the server-computed fields; optimistic jitter comes from the row id. | No |
| architecture | rule 2 / repo layer | The repo gains `updateWhere` (bulk update with `touchUpdatedAt`) and `deleteWhere`, both logging one `sync_log` row per row in chunks. Issue and child groups come from the locked issue row, not a team-row read (§4.8). | No |
| domain-model | §2 (Issues row) | Remove IssueLabel: labels are `labelIds` on Issue (Q17). | No |
| domain-model | §4.6 | The description moves to IssueContent (with `version`), and `descriptionText` is server-only. Add `labelIds` and `deletedById`. Estimates are "valid when written". Add the sortOrder rules of §4.5. | No |
| domain-model | §4.10 | Add `kind`, `teamId`, `updatedAt`, name snapshots, the two fold rules, and the rule against snapshotting what a viewer can't see. `apiKeyId` stays. | No |
| domain-model | §6 (INV-07, INV-08) | INV-07: only for exclusive label groups, enforced when labels are written (§4.2, SPEC-010 D10). INV-08: committed numbers. | No |
| domain-model | §4.10 (history kinds) | Kinds are `created`, `updated`, `deleted`, `restored`, `archived`; there is no `unarchived` and no `archived` field inside an `updated` entry (D7). | No |
| domain-model, state-machines | Issue lifecycle | `archivedAt` is set only by the auto-archive job and cleared only by restore; archived and deleted issues are read-only (D7). | No |
| SPEC-005 | §3 (routes) | `/issue/:identifier/:slug?`: the slug is optional and cosmetic; the app replaces it with the current one (§4.1, D6). | No |
| architecture | line 180 (multiple tabs) | BroadcastChannel is a later optimisation; content eviction uses Web Locks. | No |
| PRD | FR-ISS-03 | Project, milestone, cycle and parent: M3. | No |
| PRD | line 171 (undo note under FR-ISS) | `Cmd+Z` undo of property changes arrives with FR-NAV-06 in M2. | No |
| PRD | FR-ISS-10 | "Archived issues are searchable" comes with global search in M2. M1 has the team's archived list (SPEC-015). | No |
| METHODOLOGY | line 180 (M1 contents) | Add attachments, recently deleted and archive, and the basic rich editor. | No |
| METHODOLOGY | line 183 (M4) | "Rich editor" becomes mentions and the description merge UI. | No |
| METHODOLOGY | line 186 (M7) | Drop "archive / delete / restore" (now M1). | No |
| METHODOLOGY | line 197 | "Move team" is M3 (PRD FR-ISS-09). | No |
| METHODOLOGY | line 216 | Run cycles inside Surface from M3; M1 runs the backlog only. | No |
| Specs index | SPEC-011 row | Drop FR-TEAM-04 (SPEC-010 owns it). | No |
