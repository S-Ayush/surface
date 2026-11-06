---
paths:
  - 'apps/server/src/db/**'
  - 'apps/server/migrations/**'
  - 'apps/server/src/sync/**'
  - 'apps/server/drizzle.config.ts'
---

# Database (PostgreSQL 17 + Drizzle)

Decisions: ADR-0006. Conventions: `docs/03-domain/domain-model.md` §1. Sync tables: SPEC-002 and `docs/04-architecture/sync-protocol.md`.

- **Migrations are forward-only and immutable once committed.** To change the schema, edit the Drizzle schema, run `drizzle-kit generate`, then review and commit the generated SQL. Never hand-edit a committed migration (a hook blocks it). Never write a "down" migration.
- **Locking:** migrations run under `pg_advisory_lock(MIGRATIONS_LOCK)`, each in its own transaction. Advisory-lock keys are constants in one module. Never use a literal number inline.
- **Column conventions:**
  - IDs are `uuid` (UUIDv7, client-generated for synced entities).
  - Instants are `timestamptz`, and calendar dates are `date`.
  - Enums are stored as `text` with a CHECK constraint or Zod validation, not Postgres enum types (they are hard to evolve).
  - `created_at`/`updated_at` are server-set.
  - `archived_at` means archived, and `deleted_at` means trash (purged after 30 days).
- **Synced tables:**
  - Every synced table has `sync_groups text[] NOT NULL` with a GIN index.
  - **Only the repo layer** (`apps/server/src/sync/repo.ts`) inserts, updates or deletes rows in synced tables, because it appends `sync_log` rows in the same transaction. Direct `db.insert/update/delete` on a synced table is a bug (enforced by lint, SPEC-002 AC-12).
  - Mark each table as synced, user-scoped or server-only, following the entity's "Sync scope" in the domain model.
- **Visibility:** every query that returns rows to an actor filters by sync groups (`sync_groups && $actorGroups`) in SQL, not in JS after fetching. Rows the actor can't see are reported as `NOT_FOUND`.
- **Transactions:** a mutation is one transaction. Use `READ ONLY` for queries. Retry on serialization or deadlock errors only in the executor, never in handlers.
- **Raw SQL** is allowed on hot paths (bootstrap streaming, sync-log reads). Always parameterise it with Drizzle's `sql` template. Never build SQL by string concatenation.
- **Integration tests** for DB code are `*.int.test.ts`. Each test file gets its own database cloned from a migrated template.
