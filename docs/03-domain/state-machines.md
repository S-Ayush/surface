# Surface: State Machines & Lifecycle Rules

Status: **Draft v0.1** · Date: 2026-11-06 · Related: [domain-model](domain-model.md), [events](events.md)

Automated transitions (marked ⚙️) run **server-side** inside the same transaction as their trigger, or in the background job queue (pg-boss) for time-based rules. Every automated change is written to history with `actorKind = system`.

---

## 1. Issue status categories

Users may move an issue from any status to any other status, *except* where noted. Side effects depend only on the **category** being entered or left.

```mermaid
stateDiagram-v2
  [*] --> Triage: created by non-member (triage on)
  [*] --> Backlog: created (default status)
  [*] --> Unstarted: created (default / chosen)
  Triage --> Unstarted: Accept (to default status)
  Triage --> Backlog: Accept (to default status)
  Triage --> Canceled: Decline
  Triage --> Duplicate: Mark duplicate
  Backlog --> Unstarted
  Unstarted --> Started
  Started --> Completed
  Started --> Canceled
  Completed --> Started: reopen
  Canceled --> Backlog: reopen
  Duplicate --> Backlog: remove duplicate relation
```

| Entering category | Side effects ⚙️ |
|---|---|
| **Started** | Set `startedAt` if null. Clear `completedAt` and `canceledAt`. If cycle auto-add is on and the issue has no cycle, add it to the current cycle (or the next one during a cooldown). |
| **Completed** | Set `completedAt`. Clear `canceledAt`. If cycle auto-add is on and the issue has no cycle, add it to the current cycle (or the *previous* one during a cooldown). If `parentAutoComplete` is on and all siblings are closed, complete the parent too. |
| **Canceled** | Set `canceledAt`. Clear `completedAt`. |
| **Duplicate** | Only reachable through `issue.markDuplicate` (INV-11). Sets `canceledAt`. |
| **Backlog / Unstarted** (from a closed category) | Clear `completedAt` and `canceledAt` (this is a reopen). |
| **Triage** | Only on creation, or through an explicit "Move to triage". Clears `cycleId` (INV-14). |

| Leaving category | Side effects ⚙️ |
|---|---|
| **Triage** | Set `triagedAt`. Clear `snoozedUntil`. |
| **Duplicate** | Only by deleting the duplicate relation. The issue goes to the team's default status. |

Cross-cutting rules ⚙️:
- **Adding to a cycle** promotes an issue in the Backlog category to the first Unstarted status.
- **Removing from a cycle** never changes status.
- **Leaving any closed category** (a reopen) makes the issue eligible for rollover again.

---

## 2. Issue lifecycle (archive & trash)

```mermaid
stateDiagram-v2
  [*] --> Live
  Live --> Archived: ⚙️ closed for ≥ autoArchiveMonths
  Archived --> Live: unarchive (manual) / any edit
  Live --> Trashed: delete
  Archived --> Trashed: delete
  Trashed --> Live: restore (≤ 30 days)
  Trashed --> Purged: ⚙️ 30 days elapsed / Admin purge now
  Purged --> [*]
```

- **Archived:** still in the replica and in search (flagged), hidden from default views. Its children (comments, attachments) are archived with it.
- **Trashed:** hidden everywhere except Trash. Relations are kept so a restore is lossless. Sub-issues are **not** trashed with the parent; they lose their parent link on purge.
- **Purged:** a hard delete. Comments, reactions, attachments, history, relations, labels, and subscriptions are cascade-deleted, file bytes are removed, and notifications pointing to it are deleted. A `delete` delta is broadcast. The issue number is **not** reused (INV-08).
- **Auto-close** ⚙️ (optional): Live issues in Backlog, Unstarted, or Started that haven't been updated for ≥ `autoCloseMonths` move to Canceled, with a system comment.

Projects, documents, and initiatives follow the same Live → Trashed → Purged lifecycle. Projects and cycles also archive ⚙️ automatically after `autoArchiveMonths` once they are completed or canceled.

---

## 3. Triage flow

```mermaid
stateDiagram-v2
  [*] --> InTriage: created by non-member / moved to triage
  InTriage --> Snoozed: snooze(until)
  Snoozed --> InTriage: ⚙️ until reached / new comment
  InTriage --> Accepted: accept [requires priority? (v2 option)]
  InTriage --> Declined: decline (+ optional comment)
  InTriage --> Duplicated: mark duplicate of X
  Accepted --> [*]: status = team default
  Declined --> [*]: status = Canceled
  Duplicated --> [*]: status = Duplicate, relation → X
```

- **Entry rule:** an issue is created in the Triage status when the team has `triageEnabled` and the creator is **not** a member of the team. A member can also choose "Move to triage".
- **Responsible members** (`triageResponsible`) get a notification for every new triage issue.
- **Disabling triage** moves all issues currently in triage to the team's default status ⚙️ (with confirmation).

---

## 4. Cycle lifecycle

```mermaid
stateDiagram-v2
  [*] --> Upcoming: ⚙️ generated (keep N upcoming)
  Upcoming --> Active: ⚙️ startsAt reached
  Active --> Completed: ⚙️ endsAt reached
  Completed --> [*]
```

A background job runs **each hour** and handles every team whose local midnight boundary has passed:

1. **Complete** active cycles whose `endsAt ≤ now`:
   1. Freeze `snapshot` (the graph data).
   2. **Rollover** ⚙️: every *open* issue in the cycle moves to the next cycle. Issues in Backlog or Triage, and closed issues, stay put.
   3. Set `completedAt`.
2. **Activate** upcoming cycles whose `startsAt ≤ now`.
3. **Generate** new upcoming cycles until there are `cycleUpcomingCount` of them. Each starts after the previous cycle's end plus the cooldown.

The job is **idempotent**: each step is keyed by (`cycleId`, step), so a crash or restart mid-run never double-rolls.

**Settings changes** (duration, weekday, cooldown) regenerate only *upcoming cycles that have no issues*. Upcoming cycles that already have issues keep their dates (the user is warned).
**Disabling cycles** completes the active cycle (with rollover cleared, so issues lose their cycle), deletes the upcoming cycles, and keeps the completed ones.

---

## 5. Project status

Users can move a project between any of the statuses `backlog`, `planned`, `in_progress`, `paused`, `completed`, and `canceled`.

| Entering | Side effects ⚙️ |
|---|---|
| `in_progress` | Set `startedAt` if null |
| `completed` | Set `completedAt`. If there are open issues, the UI warns (and offers to cancel or move them); they stay open by default. |
| `canceled` | Set `canceledAt` |
| any other status, from completed or canceled | Clear `completedAt` / `canceledAt` |

**Update reminders** ⚙️: a weekly job (`Workspace.updateReminder`) notifies the **lead** of each `in_progress` project that has had no update in the last 6 days.

---

## 6. Users, invites & auth

```mermaid
stateDiagram-v2
  state Invite {
    [*] --> Pending
    Pending --> Accepted: signup via token
    Pending --> Revoked: admin revokes
    Pending --> Expired: ⚙️ expiresAt (7 days)
  }
  state User {
    [*] --> Active
    Active --> Deactivated: admin deactivates
    Deactivated --> Active: admin reactivates
  }
```

- **Deactivate** ⚙️: delete all sessions, revoke API keys, remove the user from team triage responsibility, and **unassign** their open issues (a history entry is recorded). Their authored content is kept.
- **Demote an Admin:** rejected if it would leave no active Admin (INV-01).
- **Tokens:** a magic link is single-use, lasts 15 minutes, and invalidates the user's other unused magic links. A password reset is single-use, lasts 1 hour, and on use logs out the user's other sessions.

---

## 7. Notifications

```mermaid
stateDiagram-v2
  [*] --> Unread: ⚙️ event for subscriber (not the actor)
  Unread --> Read: open / mark read
  Read --> Unread: mark unread
  Unread --> Snoozed: snooze(until)
  Read --> Snoozed: snooze(until)
  Snoozed --> Unread: ⚙️ until reached
  Unread --> Deleted
  Read --> Deleted
  Snoozed --> Deleted
```

- Users are **never notified of their own actions**.
- **Grouping:** a new event with the same `groupKey` while one is Unread **updates** that notification (adds the event, bumps the time) instead of creating a new row.
- **Retention:** read notifications are deleted ⚙️ after 90 days. Each user keeps at most 2,000 (the oldest read ones are removed first).

---

## 8. Webhook delivery

```mermaid
stateDiagram-v2
  [*] --> Pending
  Pending --> Succeeded: 2xx
  Pending --> Retrying: non-2xx / timeout (10s)
  Retrying --> Succeeded: 2xx
  Retrying --> Failed: after 6 attempts (1m, 5m, 30m, 2h, 6h)
```

- After 20 consecutive failed deliveries, the webhook is **auto-disabled** ⚙️, an Admin is notified, and the event is recorded in the audit log.
