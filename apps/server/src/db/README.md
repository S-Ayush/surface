# Database tables

Conventions are in `.claude/rules/database.md` and `docs/03-domain/domain-model.md` §1. This file
records what each table is for sync purposes.

## Sync scope

| Table                                                                                                | Scope                                                                                                                                                     | Written by                                                     |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `debug_items`                                                                                        | **Synced** (internal fixture model, PLAN-002)                                                                                                             | `sync/repo.ts` only                                            |
| `workspace`, `users`, `user_preferences`, `teams`, `team_memberships`, `workflow_statuses`, `labels` | **Synced** (PLAN-001 S1)                                                                                                                                  | `sync/repo.ts` only                                            |
| `issues`                                                                                             | **Synced** (PLAN-011 S3): the `Issue` model, eager                                                                                                        | `sync/repo.ts` only                                            |
| `issue_content`, `issue_history`                                                                     | **Synced** content tables (PLAN-011 S3): `IssueContent`, `IssueHistory`, loaded per issue by `GET /sync/content` (PLAN-011 S5a)                           | `sync/repo.ts` only                                            |
| `drafts`                                                                                             | **Synced**, user-scoped (PLAN-012 S5): the `Draft` model, eager, in its owner's `user:<id>` group only; no foreign key to teams or issues (SPEC-012 §4.3) | `sync/repo.ts` only                                            |
| `comments`, `reactions`                                                                              | **Synced** content tables (PLAN-013 S3): `Comment`, `Reaction`, parent `Issue`, loaded per issue by `GET /sync/content`                                   | `sync/repo.ts` only                                            |
| `comment_search_text`                                                                                | Server-only (PLAN-013 S3): a comment's plain text, for search (SPEC-013 §4.1)                                                                             | the comment handlers, in their transaction                     |
| `issue_search_text`                                                                                  | Server-only (PLAN-011 S3): the plain text of a description, for search (SPEC-011 §4.3)                                                                    | the description's handlers (PLAN-011 S6), in their transaction |
| `user_credentials`, `sessions`, `invites`, `magic_link_tokens`, `password_reset_tokens`              | Server-only (PLAN-001 S1): password hashes and tokens                                                                                                     | auth handlers (PLAN-001 S3–S5)                                 |
| `team_issue_counters`                                                                                | Server-only (PLAN-001 S1): the last issue number per team                                                                                                 | issue creation (`issues/numbering.ts`), by upsert              |
| `setup_state`                                                                                        | Server-only: one row, seeded by migration `0007`                                                                                                          | first-run setup (PLAN-001 S2)                                  |
| `files`                                                                                              | Server-only (PLAN-001 S6, PLAN-014 S1): avatars, the logo and issue files; bytes in `<DATA_DIR>/uploads`; read only through `visibleFile`                 | `files/routes.ts` (`files/store.ts`)                           |
| `blob_release`                                                                                       | Server-only (PLAN-014 S1): storage keys whose last row may be gone (SPEC-014 §4.5)                                                                        | the byte protocol (PLAN-014 S3)                                |
| `sync_log`                                                                                           | Sync infrastructure: the change log clients sync from                                                                                                     | `sync/repo.ts` `flush` only, under `LOCKS.sync`                |
| `sync_state`                                                                                         | Sync infrastructure: one row, the last assigned sync id                                                                                                   | `sync/repo.ts` `flush` only                                    |
| `client_mutations`                                                                                   | Sync infrastructure: exactly-once bookkeeping per sync client                                                                                             | `/sync/mutate` (PLAN-002 S5), in the mutation's transaction    |
| `event_outbox`                                                                                       | Server-only                                                                                                                                               | the executor (step 11) and jobs                                |
| `api_idempotency`                                                                                    | Server-only                                                                                                                                               | the executor (step 6) and the prune job                        |

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

A child row of an issue (IssueContent, IssueHistory, Comment, Reaction, Attachment) declares `issueChild: true`, `groupsOf: groupsOfIssueChild` and `groupFields: ['issueId', 'teamId']` in its entry (the registry refuses one without the others at startup): the repo then stores the issue's team as its `teamId` on insert, never one from input or a patch, refuses a patch of `issueId`, and its groups are `team:<teamId>` only (SPEC-011 §5.1). The Issue entry's `groupsOnUpdate` keeps the locked row's groups on update unless the patch moves the issue to another team, so an issue edit reads no team row after the issue lock (SPEC-011 §4.8).

A synced table holds **only the fields its model declares**, plus `sync_groups` and `archived_at`. The repo logs whole rows to `sync_log` and every write is a delta, so a secret or a counter on a synced table would be stored in the log and broadcast on every change. Put it in a server-only table keyed by the row's id (`user_credentials`, `team_issue_counters`). `workspace-models.test.ts` fails on any other column.
