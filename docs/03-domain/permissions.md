# Surface: Permissions & Sync Groups

Status: **Draft v0.1** · Date: 2026-11-06 · Implements: FR-MEM, FR-TEAM-05, NFR-14

*Changed 2026-11-12 (M1 acceptance gate, SPEC-010 to SPEC-015 §12): issues and their children are in `team:<id>` for public teams too, with a public team's issue also in its creator's and assignee's `user:` groups ([ADR-0020](../04-architecture/adr/0020-partial-issue-sync.md)); drafts; team settings, workspace labels and Automations; restore, Recently deleted and purge; threads and issue reactions; attachments and file visibility; new leak checks for every M1 model, content route and read operation.*

Two questions decide every access check:
1. **Visibility:** *can this user's client receive this record?* This is decided by **sync groups** and enforced at the sync layer, the API, and MCP.
2. **Action:** *can this user perform this operation on a record they can see?* This is decided by the **permission matrix** and enforced by the Operation Registry.

A user can never act on something they cannot see.

---

## 1. Principals

| Principal | Description |
|---|---|
| **Admin** | Workspace administrator |
| **Member** | A regular user |
| **Team member** | A user with a TeamMembership in the specific team |
| **API key / MCP** | Acts *as its owner*, further narrowed by the key's scope (`read` / `read_write`), `teamIds`, and `allowDestructive` |
| **System** | Automations and jobs. Not subject to checks, but always attributed in history. |

---

## 2. Sync groups (visibility)

| Sync group | Who receives it | What belongs to it |
|---|---|---|
| `workspace` | Every active user | Workspace, users (public fields), **public** teams and their memberships, statuses, labels, templates, cycles, workspace labels, initiatives, projects that include ≥ 1 public team, shared workspace views, workspace documents |
| `team:<id>` | Members of **private** team `<id>`. For a **public** team: every connection whose client subscribes to the team (any active user may). | Issues and all issue children, for every team, public or private. For a private team also: the team and its memberships, statuses, labels, templates, cycles, team views, team documents. |
| `user:<id>` | Only user `<id>` | Preferences, personal views, view preferences, favorites, subscriptions, notifications, API key metadata, drafts (`Draft`, SPEC-012), and the issues of **public** teams that user `<id>` created or is assigned (not their children) |

**Rules**
- **Issues** ([ADR-0020](../04-architecture/adr/0020-partial-issue-sync.md), SPEC-011 §5.7): a private team's issue is in `team:<id>` only. A public team's issue is in `team:<id>`, `user:<creatorId>` and, when assigned, `user:<assigneeId>`. A private team's issue never carries a `user:` group.
- **Children of an issue** (content, history, comments, reactions, attachments) carry the issue's `teamId` and are in `team:<teamId>` only, never in the issue's `user:` groups. Milestones, project updates, and their comments inherit the project's groups.
- **Team subscriptions** (SPEC-011 §5.7): a connection's groups are `workspace`, `user:<id>`, `team:<id>` for each private team the user is a member of, and `team:<id>` for each public team its client subscribes to. The server accepts a subscription to a public team, or to a private team the user is a member of. Anything else (an unknown id, a private team the user isn't in) is ignored the same way, and the partial bootstrap answers it with an empty stream.
- **Projects:** a project belongs to `workspace` if any of its teams is public. Otherwise it belongs to the union of its private teams' groups. Every member of any of those private teams sees the whole project, but only the issues from teams they can see.
- **Relations across scopes:** an `IssueRelation` is synced only to users who can see **both** issues. Its groups are the intersection of the two issues' groups.
- **Initiatives** are always `workspace`. Projects inside an initiative are filtered by the project's own visibility.
- **Notifications** that reference a record the user can no longer see are hidden on the client and removed by the server.
- **Group changes** (a user joins or leaves a private team, or a team changes privacy) emit `G` (sync-group change) deltas. On join, the client fetches the group's data. On leave, the client **purges** the group's data from IndexedDB and memory. An assignee change on a public team's issue changes the row's groups: the repo logs `D` with the old groups, then `U` with the new ones (sync-protocol §6).
- **Drafts** are in their owner's `user:<id>` group only. A draft respects no team permission: it is the owner's own data, and the server never resolves its `teamId` or `issueId` into anything visible.

**Private teams and Admins:** Admins see a private team's **metadata** (name, key, member list) in Settings → Teams through a non-synced admin query. They can add members, including themselves, and every such action is audit-logged. Admins do **not** receive a private team's content unless they are members.

---

## 3. Permission matrix (actions)

✅ allowed · ❌ not allowed · 👤 own records only · 🛡 Admin only

### 3.1 Workspace & people
| Operation | Member | Admin |
|---|---|---|
| View workspace, users, public teams | ✅ | ✅ |
| Update workspace settings, signup policy, MCP toggle | ❌ | ✅ |
| Create / revoke invites | ❌ | ✅ |
| Change roles, deactivate / reactivate users | ❌ | ✅ |
| Update own profile and preferences | ✅ | ✅ |
| View audit log, manage webhooks, view System page | ❌ | ✅ |
| Create / revoke **own** API keys | ✅ | ✅ |
| Revoke **any** API key | ❌ | ✅ |

### 3.2 Teams
| Operation | Non-member (public team) | Team member | Admin |
|---|---|---|---|
| View team and its data | ✅ | ✅ | ✅ (private: metadata only, unless a member) |
| Join / leave | ✅ join | ✅ leave | ✅ |
| Add / remove members | ❌ | ✅ | ✅ |
| Edit team settings: workflow statuses (create, edit, reorder, delete), default status, team labels (create, edit, archive, unarchive, delete, move to the workspace), estimate settings, Automations (auto-archive, auto-close), cycles, triage, templates | ❌ | ✅ | ✅ |
| Create a team | ✅ (any member) | — | ✅ |
| Change privacy (public ↔ private) | ❌ | ❌ | 🛡 |

*Private teams: non-members can do nothing (they cannot see the team at all).*

**Workspace labels** (SPEC-010 D9): every team uses them, so team membership doesn't apply. Every Member and Admin can read, create, edit, move between groups, archive, unarchive and delete them. A team label can move to the workspace; a workspace label never moves to a team (SPEC-010 D11). A label named by uuid is checked against **its own team**, whatever `team` the call names: a member of ENG who names ENG for a DES label gets `FORBIDDEN` (SPEC-010 D28).

### 3.3 Issues & children (on teams the user can see)
| Operation | Member | Admin |
|---|---|---|
| Create an issue | ✅ (non-members of the team: lands in Triage if enabled) | ✅ |
| Edit any property, move, set parent or relations | ✅ | ✅ |
| Triage actions (accept / decline / duplicate / snooze) | Team members only | ✅ |
| Delete an issue (it goes to Recently deleted) | ✅ | ✅ |
| Restore an archived or deleted issue | ✅ | ✅ |
| List recently deleted issues (`issue.listDeleted`) | ✅ | ✅ |
| Permanently delete (purge) a deleted issue | ❌ | 🛡 |
| Comment, reply, react (on a comment or on the issue) | ✅ | ✅ |
| Resolve or reopen a thread | ✅ | ✅ |
| Edit / delete a comment | 👤 | ✅ (delete only) |
| Attach a file or a link | ✅ | ✅ |
| Rename or remove an attachment | 👤 or team member | ✅ |

- **Archived and deleted issues are read-only** (SPEC-015 §4.3): every direct edit by a person, an API key or MCP (fields, description, labels, comments, reactions, attachments) is `CONFLICT` until the issue is restored. Nobody archives an issue by hand: archive is automatic only. Settings cascades and system jobs still write these issues.
- **System-only operations** (`issue.autoArchive`, `issue.autoClose`, `attachment.setPreview`) are run by the system actor only. No user, API key or MCP client can call them.

### 3.4 Planning, knowledge & views
| Operation | Member | Admin |
|---|---|---|
| Create / edit / delete projects, milestones, initiatives | ✅ | ✅ |
| Post a project update | ✅ | ✅ |
| Edit / delete a project update | 👤 | ✅ (delete only) |
| Create / edit / delete documents | ✅ | ✅ |
| Create a shared or personal custom view | ✅ | ✅ |
| Edit a shared view | ✅ | ✅ |
| Delete a shared view | 👤 owner | ✅ |
| "Set display as default for everyone" | ✅ | ✅ |
| Personal data (notifications, favorites, subscriptions, drafts) | 👤 | 👤 |

### 3.5 API key / MCP narrowing
| Key scope | Effect |
|---|---|
| `read` | Only operations with `kind = query`. Mutations return `FORBIDDEN`, and `search_operations` hides them. |
| `read_write` | Queries plus non-destructive mutations |
| `allowDestructive` | Additionally allows operations flagged `destructive` (`*.delete`, `team.removeMember`, `user.deactivate`, …) |
| `teamIds` | The key sees and acts only on those teams' data, as a subset of what its owner can see. It narrows in SQL on every read path and ref (issues, statuses, labels, comments, attachments, files, `issue.listDeleted`), because any user may subscribe to a public team's group and a public team's issues also reach `user:` groups (SPEC-011 §5.6). |
| `teamIds` and workspace labels | A key narrowed by `teamIds` can't mutate workspace labels, or move a team label to the workspace (it creates one): `FORBIDDEN`. It can still read workspace labels and apply them on its teams' issues (SPEC-010 §5). |
| Admin operations | Allowed only if the owner is an Admin **and** the key is `read_write` (and destructive where flagged) |

---

## 4. Enforcement points

| Layer | Check |
|---|---|
| **Sync bootstrap & deltas** | The server sends only records whose groups intersect the connection's groups, in bootstrap (full and partial), deltas (`A` and `V` included, with `syncGroups` cut to the connection's) and `/sync/content`. Tested by the private-team isolation suite (NFR-14). |
| **Operation Registry** | Before the handler runs: (1) authenticate the actor, (2) check the key scope, (3) resolve references and confirm they are **visible** to the actor, (4) check the permission matrix rule, (5) validate invariants inside the DB transaction. |
| **File downloads** | One rule on every request (`GET`, `HEAD`, `If-None-Match`, `?download=1`) and in `FileRef` (SPEC-014 §4.2), after key `teamIds` narrowing. An unclaimed `attachment` or `inline` upload is readable by its uploader only. A file owned by an issue (attachment or inline file, or a preview of one) is readable by whoever can see the issue, archived and deleted included, with no uploader exception. A detached file is readable by nobody. Avatars and the logo keep the M0 rule. Anything else is `404`, identical to a missing file. **One exception** (SPEC-014 D28, 2026-11-24): `attachment.createFile`'s `file` input (`FileRefIncludingDetached`) also resolves a detached `attachment` file whose issue the actor sees, so an undone removal can attach it again to the same issue. Downloads and every other `FileRef` never use it, so the download matrix is unchanged. |
| **Search (server-side, API / MCP)** | Results are filtered by visibility *before* ranking, so counts don't leak either. |
| **Client** | Hides UI for actions the user lacks. This is a convenience only and never the source of truth. |

---

## 5. Leak checklist (must be covered by tests)

*Updated 2026-11-24 (M1 docs catch-up):* items covered by a named test are ticked, with the test files (all in `apps/server/test/`, integration tests that the testing hold exempts). Unticked items belong to features that are not built yet, or have no named test.

- [x] Non-member bootstrap contains zero rows from private team X. *Covered: `sync-groups.int.test.ts`, `issue-leak.int.test.ts`, `content-leak.int.test.ts`, `attachment-leak.int.test.ts`, `draft-groups.int.test.ts`.*
- [ ] A private-team issue, mentioned as `X-12` in a public comment, renders as a plain "inaccessible issue" chip for non-members.
- [ ] A relation between a public issue and a private issue is not synced to non-members.
- [x] `issue.count` / `issue.groupBy` through the API exclude invisible issues. *Covered: `issue-leak.int.test.ts`, `lifecycle-leak.int.test.ts`.*
- [ ] A notification is never generated for a user who cannot see the record.
- [ ] After a user is removed from private team X, their client purges X's data and the server rejects their reads of it.
- [ ] Webhook payloads for private-team events are sent only if an Admin explicitly includes private teams (default: excluded).
- [ ] An API key with `teamIds=[A]` cannot read team B through MCP `search_operations` examples or errors. *Until MCP lands (M6), `lifecycle-leak.int.test.ts` checks `GET /api/ops`, where `search_operations` will take its examples, for the lifecycle operations. M6's MCP leak test reruns that catalog check against `search_operations` itself (PLAN-015 S5).*
- [x] **Team subscriptions** (SPEC-011): a subscription to an unknown team and to a private team the user isn't in are ignored identically, and the partial bootstrap `?groups=team:<id>` answers both with an empty stream. No `user:` group ever carries a private team's issue or any issue child row. *Covered: `subscribe-leak.int.test.ts`, `comment-leak.int.test.ts`, `attachment-leak.int.test.ts`.*
- [x] **Issue reads** (SPEC-011, SPEC-015): `issue.list`, `issue.count`, `issue.groupBy`, `issue.get`, `issue.listDeleted` and `IssueRef` never return or resolve a private team's issue for a non-member (`NOT_FOUND`, worded as for one that doesn't exist), and an API key's `teamIds` narrow them on public teams too. `issue.purge` by an Admin who isn't a member is `NOT_FOUND`. *Covered: `issue-leak.int.test.ts`, `lifecycle-leak.int.test.ts`, `resolvers.int.test.ts`.*
- [x] **`/sync/content`** leaves out unknown and invisible parents the same way (never an error), and never returns a private team's description, history, comments or reactions to a non-member. *Covered, including a parent cut by the byte budget (SPEC-011 D16): `content-leak.int.test.ts`, `comment-leak.int.test.ts`, `lifecycle-leak.int.test.ts`.*
- [x] **`A` and `V` frames** carry the full row through `clientRow`, with `syncGroups` cut to the connection's groups, like `I` and `U`. *Covered: `archive-wire-leak.int.test.ts`, `issue-leak.int.test.ts`.*
- [ ] **History** never stores the name of a row that some viewer of the issue can't see (SPEC-011 §4.4). *No named test yet. In M1 it holds by construction: an edit can't give an issue another team's status or label (`issue-leak.int.test.ts`, INV-06), users are visible to everyone, and attachments belong to the issue.*
- [x] **Statuses and labels** (SPEC-010): `status.list`, `label.list`, `label.usage`, `StatusRef` and `LabelRef` never return or resolve a private team's statuses or labels for a non-member. `label.usage` counts and `removedFromIssues` include only issues the actor can see. *Covered: `status-leak.int.test.ts`, `label-leak.int.test.ts`, `archive-wire-leak.int.test.ts`, `resolvers.int.test.ts`.*
- [x] **Comments and reactions** (SPEC-013): `comment.list` and `CommentRef` never return or resolve a private team's comment for a non-member (`NOT_FOUND`). *Covered: `comment-leak.int.test.ts`, `lifecycle-leak.int.test.ts`.*
- [x] **Attachments and files** (SPEC-014): `AttachmentRef`, `FileRef` and `GET /files/:id` (`GET`, `HEAD`, `If-None-Match`, `?download=1`) follow the visibility matrix of SPEC-014 §4.2: an invisible, detached or someone else's unclaimed file is `404`, byte-identical to a missing file apart from `correlationId`, and an uploader who leaves a private team loses access to its files. A saved document that names an invisible file is refused with one message for every case. *Covered: `files-leak.int.test.ts`, `attachment-leak.int.test.ts`, `lifecycle-leak.int.test.ts`; the one-message refusal also in `attachment-claim.test.ts` (unit).*
- [x] **Drafts** (SPEC-012): another user's drafts never reach a replica, and a draft for a team the user left holds nothing the user couldn't already see. *Covered: `draft-groups.int.test.ts`.*
- [x] **Archived and deleted issues** (SPEC-015; added 2026-11-24, PLAN-015 S5): every operation that takes an issue, comment or attachment ref answers an archived or deleted private-team issue like an unknown one, for a Member, an Admin outside the team (E12) and a key limited to other teams (E13), and writes nothing; `issue.listDeleted` and the lists and counts that take archived issues leave it out; `/sync/content` and `GET /files/:id` of such an issue are byte-identical to an unknown one; its lifecycle deltas never reach an outsider; `issue.purge` by a non-member Admin is `NOT_FOUND`. *Covered: `lifecycle-leak.int.test.ts`, `issue-leak.int.test.ts`.*

**Accepted exception (SPEC-001 D2, 2026-11-07):** team keys are unique across the workspace (INV-03), so a non-member can learn that a private team's key is taken (`team.create` answers `CONFLICT`, `team.suggestKey` skips the key). Nothing else about the team: the answer never carries its name or id. Every other reference to a private team by a non-member is `NOT_FOUND`, worded exactly as for a team that doesn't exist (`server/test/team-ops-leak.int.test.ts`).

---

## 6. Purge & reference rules (INV-21)

| When purging… | Then… |
|---|---|
| Issue | Delete, through the repo (foreign keys never cascade): reactions, comments, attachments, history, content, relations (M3), subscriptions and notifications (M4). Delete **every file row the issue owns**: attachment files (detached or not), inline files, and their previews (SPEC-014 §4.7). File rows follow the byte protocol (SPEC-014 §4.5): each storage key goes to the server-only `blob_release` table, and `files-cleanup` removes the bytes after commit only when no other row uses them. The Issue and its Attachments log a `D`; content rows log none (SPEC-015 §4.5). Sub-issues: M3 (deleting a parent deletes its sub-issues, SPEC-015 §4.7). |
| Project | Null `projectId` and `projectMilestoneId` on its issues. Cascade-delete milestones, updates and their comments, ProjectTeam, ProjectMember, InitiativeProject, and its documents. |
| Initiative | Cascade-delete InitiativeProject rows. |
| Label (hard delete, SPEC-010) | Its id is removed from `labelIds` on every issue that has it (archived and deleted ones included), with no history and no `updatedAt` change. A group is deleted only when it has no labels. |
| Status (hard delete, SPEC-010) | Refused while any issue uses it (archived and deleted ones included), and for the default and auto-close statuses. Nothing cascades. |
| Document | Hard delete. Mentions of it render as "deleted document". |
| User | **Never purged.** Users are only deactivated. |
| Team | Not supported in v1 (archive is v2). |
