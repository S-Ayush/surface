# ADR-0023: Document schema migrations rewrite synced rows without logging them

Status: **Accepted** (with SPEC-013 D6 at the M1 acceptance gate, 2026-11-12) · Date: 2026-11-12 · An exception to architecture rule 2 ("every synced write is logged", [architecture §6](../architecture.md#6-data-architecture)); no ADR is superseded.

## Context
Rich text is stored as editor JSON (ADR-0009) in synced content tables: `issue_content.description` and `comments.body` (SPEC-011, SPEC-013). The editor schema will change over time: a new node, a renamed attribute. SPEC-013 D6 decides how: `DOC_SCHEMA_VERSION` (in `packages/domain`) is bumped, the server accepts only documents valid against the current schema, and **a data migration rewrites the stored documents in the same release**.

Architecture rule 2 says only the repo layer writes synced tables, and it logs a `sync_log` row for each row it writes. A database migration runs at server start, before the executor exists, and may rewrite every document in the workspace. Logging each row would put the whole content of the workspace into `sync_log` for 30 days and send it to every subscribed connection, which would then throw it away, because the release also makes every client resync.

## Options
1. **Rewrite documents through the repo after start-up** (a job that runs the rewrite as `system`, logging every row). Follows rule 2, but floods `sync_log` and the hub, and old-format documents are served until the job finishes.
2. **Convert on read**, never rewriting stored documents. No migration, but every reader (server, client, API, MCP, search text) must handle every past format forever.
3. **Rewrite in the migration, unlogged, and rely on the resync** that the same release forces.

## Decision
**Option 3**, as a stated exception to rule 2:

- A migration that changes stored documents may rewrite rows of synced tables **directly, in the migration**, without `sync_log` rows. It may change only the document columns (`issue_content.description`, `comments.body`) and the server-only search text derived from them.
- It is allowed only when the **same release** bumps `DOC_SCHEMA_VERSION`. `DOC_SCHEMA_VERSION` is part of the `schemaHash` input (sync-protocol §8), so every client gets `CLIENT_OUTDATED` or `resync(schema)` and bootstraps again. A resync clears the replica, the cached content and the hydration marks, so no client keeps an old-format document or applies a delta across the change.
- The editor's snapshot test pairs `DOC_SCHEMA_VERSION` with a hash of the schema, so a schema change without the bump fails the build (SPEC-013 AC-9).
- A queued offline mutation that carries an old-format document is replayed after the reload. If it no longer validates, it is rejected and rolled back like any rejection (SPEC-013 §4.4).

## Consequences
+ One migration, no flood of `sync_log` rows, and only one document format to support at a time.
+ No new client code: the resync path already exists (SPEC-002 E7).
− Every client re-bootstraps after such a release, and content is fetched again on demand.
− `sync_log` rows from before the migration still hold old-format documents for up to 30 days. No client reads them: the hash changes, so catch-up across the release never happens.
− An old server process must not keep writing documents after the migration ran. A deploy that runs old and new versions side by side (`SURFACE_ROLE` split) must stop the old ones first, as for any schema change.
− One more stated exception to rule 2 (the other is [ADR-0022](0022-purge-content-unlogged.md)). Only document migrations may use it, and each is reviewed as one.
