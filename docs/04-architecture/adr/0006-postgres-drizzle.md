# ADR-0006: PostgreSQL + Drizzle

Status: **Accepted (draft)** · Date: 2026-11-06

## Decision
- **PostgreSQL 17+** (VISION D4). Bundled in compose. Any `DATABASE_URL` works, including the free tiers of hosted Postgres.
- **Drizzle ORM** for schema-as-code and typed queries. **drizzle-kit** generates SQL migration files, which are reviewed and committed.
- The **raw SQL** escape hatch is used on the sync hot paths (bootstrap streaming, sync-log reads).
- Features we rely on: transactions, advisory locks, `LISTEN/NOTIFY`, JSONB, GIN indexes on `sync_groups text[]`, `tsvector` FTS, and `pg_trgm`.

## Consequences
+ A free, ubiquitous database with everything the sync engine needs.
− Requires Postgres; there is no SQLite mode in v1.
