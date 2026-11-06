# Surface: Domain Events Catalogue

Status: **Draft v0.1** · Date: 2026-11-06 · Related: [domain-model](domain-model.md), [state-machines](state-machines.md)

Every committed operation emits one or more **domain events**, inside the same DB transaction (an outbox table). One event stream feeds every consumer, so history, notifications, webhooks, and audit can never disagree.

```
Operation ─► DB transaction ─┬─► entity rows + sync_actions (lastSyncId) ─► WebSocket deltas
                             └─► event_outbox ─► consumers (pg-boss jobs)
                                                  ├─ History writer        (sync)
                                                  ├─ Subscription updater  (sync)
                                                  ├─ Notification fan-out  (async)
                                                  ├─ Webhook dispatcher    (async)
                                                  ├─ Audit logger          (sync, server-only)
                                                  └─ Automations (cycle auto-add, parent auto-complete…)
```

**Event envelope**
```json
{ "id": "uuidv7", "type": "issue.updated", "occurredAt": "…", "lastSyncId": 18234,
  "actor": { "kind": "user|api|mcp|system", "userId": "…", "apiKeyId": "…" },
  "subject": { "type": "issue", "id": "…" },
  "changes": { "statusId": { "from": "…", "to": "…" } },
  "data": { } }
```

Consumer legend: **H** History · **S** Subscriptions · **N** Notifications · **W** Webhooks · **A** Audit · **Auto** Automations

| Event | Emitted when | H | S | N (who is notified) | W | A |
|---|---|---|---|---|---|---|
| `issue.created` | Issue created (any path) | ✓ | creator, assignee, mentioned | assignee (if not the actor). Triage-responsible members if the issue is in triage. | ✓ | — |
| `issue.updated` | Any property change (`changes` lists the fields) | ✓ | new assignee, newly mentioned | see the rows below | ✓ | — |
| ↳ assignee changed | `changes.assigneeId` | ✓ | new assignee | new assignee | ✓ | — |
| ↳ status → Completed / Canceled | category change | ✓ | — | subscribers | ✓ | — |
| ↳ priority → Urgent | priority change | ✓ | — | assignee | ✓ | — |
| ↳ description mentions added | new @mention | ✓ | mentioned users | mentioned users | — | — |
| `issue.moved_team` | Team move | ✓ | — | subscribers | ✓ | — |
| `issue.deleted` / `issue.restored` / `issue.purged` | Trash lifecycle | ✓ | — | — | ✓ | purge only |
| `issue.archived` / `issue.unarchived` | Archive lifecycle | ✓ | — | creator (on auto-archive) | ✓ | — |
| `issue.triaged` | Accept / decline / duplicate | ✓ | — | creator | ✓ | — |
| `relation.created` / `relation.deleted` | Relation change | ✓ (both issues) | — | assignee of the *blocked* issue (on `blocks`) | ✓ | — |
| `comment.created` | New comment or reply | ✓ | commenter, mentioned | subscribers + mentioned (not the actor) | ✓ | — |
| `comment.updated` / `comment.deleted` | Edit / delete | — | newly mentioned | newly mentioned | ✓ | — |
| `reaction.added` / `reaction.removed` | Reaction toggled | — | — | — (no notification in v1) | ✓ | — |
| `attachment.created` / `attachment.deleted` | Attachment change | ✓ | — | — | ✓ | — |
| `cycle.started` / `cycle.completed` | ⚙️ cycle job | — | — | — | ✓ | — |
| `cycle.rolled_over` | ⚙️ an issue moved to the next cycle | ✓ | — | — | — | — |
| `project.created` / `project.updated` / `project.deleted` | Project change | — | lead, members | lead (on assignment), members (status → completed) | ✓ | — |
| `project_update.created` | Update posted | — | — | project lead + members + subscribers | ✓ | — |
| `project_update.reminder_due` | ⚙️ reminder job | — | — | project lead | — | — |
| `initiative.created` / `initiative.updated` | Initiative change | — | owner | owner (on assignment) | ✓ | — |
| `document.created` / `document.updated` / `document.deleted` | Document change | — | — | mentioned users | ✓ | — |
| `team.created` / `team.updated` / `team.privacy_changed` | Team change | — | — | — | ✓ | privacy |
| `team.member_added` / `team.member_removed` | Membership change | — | — | the added user | ✓ | ✓ |
| `user.invited` / `user.joined` | Invite / signup | — | — | Admins (on join) | — | ✓ |
| `user.role_changed` / `user.deactivated` / `user.reactivated` | Admin action | — | — | the affected user | — | ✓ |
| `auth.login` / `auth.login_failed` / `auth.password_reset` | Auth | — | — | — | — | ✓ |
| `api_key.created` / `api_key.revoked` | Key change | — | — | — | — | ✓ |
| `webhook.created` / `webhook.updated` / `webhook.disabled` | Webhook change | — | — | Admins (on auto-disable) | — | ✓ |
| `workspace.updated` | Settings change | — | — | — | — | ✓ |

**Rules**
- **Actor suppression:** the actor is never notified of their own event.
- **Visibility:** notifications and webhook payloads are filtered by the recipient's visibility ([permissions](permissions.md) §2).
- **MCP / API mutations** are always audit-logged (`actorKind = mcp | api`) as well as written to history.
- **Event names are a public contract** (webhooks), so renaming one requires a new ADR.
