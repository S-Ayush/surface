# ADR-0010: Background jobs

Status: **Accepted (draft)** · Superseded in part by [ADR-0024](0024-job-queues.md) (the queue list, and which jobs run operations) · Date: 2026-11-06

## Decision
**pg-boss**, a job queue stored in Postgres. No Redis, and no extra container.

Queues: `cycle.tick` (hourly), `outbox.consume`, `notify.fanout`, `email.send`, `webhook.deliver`, `archive.sweep` (daily), `trash.purge` (daily), `updates.remind` (hourly check), `backup.run` (cron), `synclog.prune` (daily).

Every job is **idempotent** (keyed by entity and step) and runs operations through the executor with `actor = system`.

## Consequences
+ The job state is transactional with the data.
− Throughput is bounded by Postgres, which is fine at this scale.
