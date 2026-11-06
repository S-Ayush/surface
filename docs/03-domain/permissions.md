# Surface: Permissions & Sync Groups

Status: **Draft v0.1** · Date: 2026-11-06 · Implements: FR-MEM, FR-TEAM-05, NFR-14

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
| `workspace` | Every active user | Workspace, users (public fields), **public** teams and their memberships, statuses, labels, templates, cycles, issues and all issue children, workspace labels, initiatives, projects that include ≥ 1 public team, shared workspace views, workspace documents |
| `team:<id>` | Members of **private** team `<id>` | That team and its memberships, statuses, labels, templates, cycles, issues and children, team views, team documents |
| `user:<id>` | Only user `<id>` | Preferences, personal views, view preferences, favorites, subscriptions, notifications, API key metadata, drafts (v2) |

**Rules**
- Children **inherit** their parent's groups: comments, reactions, attachments, history, issue labels, and relations from the issue; milestones, project updates, and their comments from the project.
- **Projects:** a project belongs to `workspace` if any of its teams is public. Otherwise it belongs to the union of its private teams' groups. Every member of any of those private teams sees the whole project, but only the issues from teams they can see.
- **Relations across scopes:** an `IssueRelation` is synced only to users who can see **both** issues. Its groups are the intersection of the two issues' groups.
- **Initiatives** are always `workspace`. Projects inside an initiative are filtered by the project's own visibility.
- **Notifications** that reference a record the user can no longer see are hidden on the client and removed by the server.
- **Group changes** (a user joins or leaves a private team, or a team changes privacy) emit `G` (sync-group change) deltas. On join, the client fetches the group's data. On leave, the client **purges** the group's data from IndexedDB and memory.

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
| Edit team settings (workflow, labels, estimates, cycles, triage, templates) | ❌ | ✅ | ✅ |
| Create a team | ✅ (any member) | — | ✅ |
| Change privacy (public ↔ private) | ❌ | ❌ | 🛡 |

*Private teams: non-members can do nothing (they cannot see the team at all).*

### 3.3 Issues & children (on teams the user can see)
| Operation | Member | Admin |
|---|---|---|
| Create an issue | ✅ (non-members of the team: lands in Triage if enabled) | ✅ |
| Edit any property, move, set parent or relations | ✅ | ✅ |
| Triage actions (accept / decline / duplicate / snooze) | Team members only | ✅ |
| Delete (trash) / restore an issue | ✅ | ✅ |
| Purge from trash | ❌ | 🛡 |
| Comment, react | ✅ | ✅ |
| Edit / delete a comment | 👤 | ✅ (delete only) |
| Delete an attachment | 👤 or team member | ✅ |

### 3.4 Planning, knowledge & views
| Operation | Member | Admin |
|---|---|---|
| Create / edit / trash projects, milestones, initiatives | ✅ | ✅ |
| Post a project update | ✅ | ✅ |
| Edit / delete a project update | 👤 | ✅ (delete only) |
| Create / edit / trash documents | ✅ | ✅ |
| Create a shared or personal custom view | ✅ | ✅ |
| Edit a shared view | ✅ | ✅ |
| Delete a shared view | 👤 owner | ✅ |
| "Set display as default for everyone" | ✅ | ✅ |
| Personal data (notifications, favorites, subscriptions) | 👤 | 👤 |

### 3.5 API key / MCP narrowing
| Key scope | Effect |
|---|---|
| `read` | Only operations with `kind = query`. Mutations return `FORBIDDEN`, and `search_operations` hides them. |
| `read_write` | Queries plus non-destructive mutations |
| `allowDestructive` | Additionally allows operations flagged `destructive` (`*.delete`, `team.removeMember`, `user.deactivate`, …) |
| `teamIds` | The key sees and acts only on those teams' data, as a subset of what its owner can see |
| Admin operations | Allowed only if the owner is an Admin **and** the key is `read_write` (and destructive where flagged) |

---

## 4. Enforcement points

| Layer | Check |
|---|---|
| **Sync bootstrap & deltas** | The server sends only records whose groups intersect the user's groups. Tested by the private-team isolation suite (NFR-14). |
| **Operation Registry** | Before the handler runs: (1) authenticate the actor, (2) check the key scope, (3) resolve references and confirm they are **visible** to the actor, (4) check the permission matrix rule, (5) validate invariants inside the DB transaction. |
| **File downloads** | The URL is authorised against the attachment's issue visibility on every request. |
| **Search (server-side, API / MCP)** | Results are filtered by visibility *before* ranking, so counts don't leak either. |
| **Client** | Hides UI for actions the user lacks. This is a convenience only and never the source of truth. |

---

## 5. Leak checklist (must be covered by tests)

- [ ] Non-member bootstrap contains zero rows from private team X.
- [ ] A private-team issue, mentioned as `X-12` in a public comment, renders as a plain "inaccessible issue" chip for non-members.
- [ ] A relation between a public issue and a private issue is not synced to non-members.
- [ ] `issue.count` / `issue.groupBy` through the API exclude invisible issues.
- [ ] A notification is never generated for a user who cannot see the record.
- [ ] After a user is removed from private team X, their client purges X's data and the server rejects their reads of it.
- [ ] Webhook payloads for private-team events are sent only if an Admin explicitly includes private teams (default: excluded).
- [ ] An API key with `teamIds=[A]` cannot read team B through MCP `search_operations` examples or errors.

---

## 6. Purge & reference rules (INV-21)

| When purging… | Then… |
|---|---|
| Issue | Cascade-delete comments, reactions, attachments and files, history, labels, relations, subscriptions, and notifications. Null `parentId` on its sub-issues. |
| Project | Null `projectId` and `projectMilestoneId` on its issues. Cascade-delete milestones, updates and their comments, ProjectTeam, ProjectMember, InitiativeProject, and its documents. |
| Initiative | Cascade-delete InitiativeProject rows. |
| Document | Hard delete. Mentions of it render as "deleted document". |
| User | **Never purged.** Users are only deactivated. |
| Team | Not supported in v1 (archive is v2). |
