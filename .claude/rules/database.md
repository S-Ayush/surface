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
- **Migrations** run through our own runner (`src/db/migrate.ts`) over the drizzle-kit journal: under `pg_advisory_lock(LOCKS.migrations)`, each in its own transaction, recorded in `schema_migrations`. Anything that prepares a database (serve, the `migrate` CLI) calls `prepareDatabase()` (`src/db/prepare.ts`), never `migrate()` alone, so extensions are created under the same lock. Generate them with `pnpm --filter @surface/server db:generate` (use `--custom --name <name>` for hand-written SQL such as data fixes).
- **Advisory-lock keys** all live in `src/db/locks.ts` (`LOCKS.*`). Never use a literal number inline.
- **Column conventions:**
  - IDs are `uuid` (UUIDv7, client-generated for synced entities).
  - Instants are `timestamptz(3)` (millisecond precision: the client replica and list cursors compare exactly what is stored, SPEC-003 §7.4), and calendar dates are `date`.
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
- **Integration tests** for DB code are `*.int.test.ts` (`pnpm test:int`). New ones are on hold except private-team leak tests and the sync property suite (`docs/07-plans/README.md` §6); keep and run the existing ones. Use `createTestDatabase()` from `test/db.ts`: a clone of the migrated template, or `{ migrated: false }` for an empty database. Drop it in `afterAll`/`afterEach`.
