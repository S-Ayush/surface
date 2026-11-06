# Database tables

Conventions are in `.claude/rules/database.md` and `docs/03-domain/domain-model.md` §1. This file
records what each table is for sync purposes.

## Sync scope

| Table              | Scope                                                         | Written by                                                  |
| ------------------ | ------------------------------------------------------------- | ----------------------------------------------------------- |
| `debug_items`      | **Synced** (internal fixture model, PLAN-002)                 | `sync/repo.ts` only                                         |
| `sync_log`         | Sync infrastructure: the change log clients sync from         | `sync/repo.ts` `flush` only, under `LOCKS.sync`             |
| `sync_state`       | Sync infrastructure: one row, the last assigned sync id       | `sync/repo.ts` `flush` only                                 |
| `client_mutations` | Sync infrastructure: exactly-once bookkeeping per sync client | `/sync/mutate` (PLAN-002 S5), in the mutation's transaction |
| `event_outbox`     | Server-only                                                   | the executor (step 11) and jobs                             |
| `api_idempotency`  | Server-only                                                   | the executor (step 6) and the prune job                     |

## The `sync_groups` convention

Every **synced** table has a `sync_groups text[] NOT NULL` column with a GIN index, holding the
groups that may see the row (permissions.md §2): `workspace`, `team:<id>` for private teams,
`user:<id>` for personal rows. The repo layer computes it with the model's `groupsOf(row, tx)`
(`sync/models.ts`) on every insert and update, so a handler can't set it wrong. Every read that
returns rows to an actor filters on it in SQL (`sync_groups && $actorGroups`).

Only the repo layer writes synced tables. `surface/no-synced-table-writes` (ESLint) flags writes
anywhere else in `src/`, and in tests a trigger audits every write so the test executor fails a
mutation that wrote a row it didn't log (SPEC-002 AC-12). Adding a synced model means:

1. the Drizzle table, with `sync_groups` and its GIN index;
2. an entry in `SYNCED_MODELS` (`table`, `def` from `@surface/domain/model`, `fixture`, `groupsOf`, `teamColumn`); every declared field needs a column of the same name (`groups` comes from `sync_groups`), which the sync registry checks at startup;
3. the table in `SYNCED_TABLES` in `packages/config/eslint.js` (a test fails until it is).
