# ADR-0022: Purging an issue logs no `D` for its content rows

Status: **Accepted** (decision taken by the user, SPEC-015 Q2, 2026-11-12; ADR written at the M1 acceptance gate) · Date: 2026-11-12 · An exception to architecture rule 2 ("every synced write is logged", [architecture §6](../architecture.md#6-data-architecture)); no ADR is superseded.

## Context
Architecture rule 2 says only the repo layer writes synced tables, and it records a `sync_log` row for every row it writes, in the same transaction. Clients apply exactly what the log says, which is what makes a client that followed the stream equal to one that bootstrapped fresh.

Purging an issue (SPEC-015 §4.5, by an Admin or by the 30-day `trash-purge` job) deletes the issue and everything under it. An issue's **content rows** (IssueContent, IssueHistory, Comment, Reaction; sync-protocol §2) can number in the thousands for a busy issue. Logging a `D` for each:
- holds the global sync lock (sync-protocol §3) for the whole chunked insert, stalling every other write in the workspace;
- sends every connection subscribed to the team a delete for rows it almost never holds: content is loaded per parent, on demand;
- keeps those rows in `sync_log` for 30 days.

And the client no longer needs them. Content is only ever held for an Issue the replica holds, and SPEC-011 §5.3 already drops a parent's content and hydration mark when its Issue row is absent after a delta batch. A deleted issue is removed from the replica when it is deleted (ADR-0020), long before it is purged.

## Options
1. **Log a `D` per content row**, through `repo.deleteWhere`'s chunked insert. Follows rule 2 to the letter, at the cost above.
2. **Log no `D` for content rows whose parent Issue is deleted in the same transaction.** The Issue's own `D`, and the client's existing rule, remove them.

## Decision
**Option 2.**

- When an issue is purged, its content rows are deleted **without** `sync_log` rows. Its **eager** rows (the Issue itself and its Attachments) each log a `D`, as rule 2 requires.
- The exception covers only rows of content models (models that declare a `parent`, sync-protocol §2) whose parent Issue is deleted, with a logged `D`, in the same transaction. Every other delete, of content or not, is logged.
- The unlogged delete lives in the repo layer, as one method used only by purge. So the lint rule against synced-table writes outside `repo` still holds, and the test write audit (SPEC-002 AC-12) accepts these deletes only next to the parent Issue's `D` in the same transaction.
- No new wire rule. The client's existing rule removes the content: after a delta batch, the content rows and hydration mark of any parent whose Issue row is absent are dropped (sync-protocol §4.2). A group change's `D`+`U` pair leaves the Issue present after the batch, so it keeps its content; only a real delete removes it.
- **Fallback:** the per-row path (option 1) stays in the code, off by default. If this decision is ever reversed, purge switches to it; nothing else in SPEC-015 changes.

## Consequences
+ A purge writes a handful of `sync_log` rows, so it holds the global sync lock briefly and sends clients a few packets instead of thousands.
+ A fresh bootstrap and a client that followed the stream still agree: neither holds content for a purged issue. The sync property suite checks it (purge is in its generator).
− `sync_log` is no longer a complete record of every synced row change. Anything that reads it as one (a future audit export, a replication tool) must treat an Issue's `D` as deleting its content too.
− A content tombstone is not written for these rows. That is safe because an answer from `/sync/content` is never stored for a parent whose Issue is missing or tombstoned (sync-protocol §4.2), and the Issue's `D` is a tombstone.
− One more stated exception to rule 2 (the other is [ADR-0023](0023-document-migration-unlogged.md)). Reviewers must check that nothing else uses the unlogged delete.
