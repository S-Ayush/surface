# ADR-0024: Job queue names and the M1 queues

Status: **Accepted** (with SPEC-014 and SPEC-015 at the M1 acceptance gate, 2026-11-12) · Date: 2026-11-12 · Supersedes the queue list and the "every job runs operations" sentence of [ADR-0010](0010-jobs-pg-boss.md); the choice of pg-boss stands.

## Context
[ADR-0010](0010-jobs-pg-boss.md) chose pg-boss and listed the queues the product would need, with dotted names (`archive.sweep`, `trash.purge`, `cycle.tick`, …). It also said every job runs operations through the executor as `system`.

M0 built three queues with hyphenated names: `idempotency-prune`, `synclog-prune` and `email-send` (`apps/server/src/jobs/index.ts`, `mail/job.ts`). Two of them delete server-only rows directly, not through an operation. M1 adds six queues (SPEC-014, SPEC-015), and the specs name them with hyphens, like the code. SPEC-015 also splits ADR-0010's `archive.sweep` into an automatic archive and an automatic close.

## Decision
- **Names** are lowercase and hyphenated, `<area>-<action>`, like the code. ADR-0010's later queues keep their purpose under hyphenated names when they are built (`cycle-tick`, `notify-fanout`, `webhook-deliver`, …).
- **Queues in M1:**

| Queue | Schedule | What it does | Spec |
|---|---|---|---|
| `idempotency-prune` | hourly | Deletes expired `clientMutationId` results (built in M0) | SPEC-003 §9 |
| `synclog-prune` | daily | Deletes `sync_log` rows past retention (built in M0) | SPEC-002 §4.3 |
| `email-send` | on demand | Sends one email (built in M0) | SPEC-001 |
| `files-preview` | on demand, queued when an image is claimed | Makes an attachment preview and sets it with `attachment.setPreview` | SPEC-014 §4.4 |
| `files-cleanup` | hourly | Removes unclaimed and detached files, unused avatars and logos, and drains `blob_release` | SPEC-014 §4.6 |
| `files-sweep` | daily | Removes bytes with no `files` row and stale temporary files | SPEC-014 §4.5 |
| `trash-purge` | daily | Purges issues deleted 30 days ago (replaces `trash.purge`) | SPEC-015 §6.3 |
| `auto-archive` | daily | Archives closed issues after the team's period (replaces `archive.sweep`) | SPEC-015 §6.3 |
| `auto-close` | daily | Closes stale open issues in teams that turned it on | SPEC-015 §6.3 |

- Schedules are evaluated in UTC. A job that must not run twice uses a `singletonKey`, so several worker replicas never run it at once.
- **What a job may write.** A job that changes synced state runs operations through the executor as `system` (CLAUDE.md rule 1), one issue per transaction where it touches issues. A job that touches only server-only tables (`client_mutations`, `api_idempotency`, `sync_log`, `files`, `blob_release`) and the uploads volume may write them directly, as `synclog-prune` and `idempotency-prune` already do. Every job stays idempotent.

## Consequences
+ The ADR, the specs and the code use the same names.
+ Clean-up jobs that only free server-only storage don't need operations nobody else would call.
− Server-only writes by jobs are outside the executor's logging and metrics; each such job logs its own counts (SPEC-014 §10).
