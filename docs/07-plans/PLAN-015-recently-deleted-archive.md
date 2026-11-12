# PLAN-015: Recently deleted & archive

Implements: [SPEC-015](../06-specs/SPEC-015-trash-archive.md) · Status: **Draft** (waits for M1 acceptance, [README §7](README.md)) · Order: **after PLAN-011 S4**, last of the M1 plans to finish · Depends on: PLAN-011 S3 (`lockIssueForWrite`, groups from the issue row) and S4 (issue operations), S1 (`updateWhere`/`deleteWhere`), S2 (archive on the wire, `unarchive`), S5/S6 (content rows, for purge); PLAN-014 S4a (the file purge step and `purge-bytes.test.ts`, on PLAN-014 S3's `deleteFiles` and `blob_release`); PLAN-012 S1 (`whileTyping`, `ui.available`, destructive ranking), S4 (issue page, read-only frame) and S6 (delete dialog, `Mod+Z`); PLAN-010 S2 (`status.delete` handler, for S1's auto-close wiring); PLAN-013 S3/S4 and PLAN-014 S4a (their operations add lifecycle rows and purge steps)

> **Where things live today.** Jobs are in `apps/server/src/jobs/index.ts` (`QUEUES`, `registerJobs`, pg-boss in the `pgboss` schema; `idempotency-prune` and `synclog-prune` are the models to copy). Operations are defined in `packages/operations/src/ops/*.ts` and handled in `apps/server/src/handlers/**`, listed in `handlers/index.ts` (`HANDLERS`) and run by `apps/server/src/executor/execute.ts`. Writes go through `apps/server/src/sync/repo.ts`. `teams` already has `autoArchiveMonths` and `autoCloseMonths` (`db/schema/workspace.ts`, `packages/domain/src/team.ts`, `model/workspace-models.ts`), but nullable and unchecked. There is no issue code yet. Everything under `issues/`, `ops/issue*.ts` and the archive screens is **new**.

---

## 1. Slices

### S1: Lifecycle: migration, rule table, delete and restore · M (2 d)
Needs PLAN-011 S4 (issue operations exist), PLAN-012 S1 (`ui.available`, `whileTyping`) and PLAN-010 S2 (`status.delete`). `deletedAt`, `deletedById` and `archivedAt` come from PLAN-011 S3's migration.
- **Migration** (next migration number): partial index on `issues (deleted_at) WHERE deleted_at IS NOT NULL`; `teams.auto_close_status_id` nullable, FK to `workflow_statuses` `ON DELETE RESTRICT`; `auto_archive_months` set not null (backfill nulls to 6) with a check in (1, 3, 6, 9, 12); `auto_close_months` check null or in that set (replaces the `>= 1` checks `teams_auto_archive_check` and `teams_auto_close_check`). `Team` model gets `autoCloseStatusId` (`packages/domain/src/model/workspace-models.ts`, `team.ts`); this bumps the `schemaHash`. `TeamSchema` and `teamOutput` (`apps/server/src/handlers/teams/shared.ts`) carry it.
- **Domain** (`packages/domain/src/issue-lifecycle.ts`, new): `lifecycleOf(issue)`, `purgeAfter(deletedAt)` (+720 h in UTC), `canRestore(issue, now)`, the refusal messages of §4.2 (`"ENG-42 is archived. Restore it to edit it."`).
- **Lifecycle rule table** as data in the same file: one row per operation of SPEC-015 §4.3 and per mode (`edit | lifecycle | cascade`). Other plans add their rows when they land.
- **Server:** `apps/server/src/issues/lifecycle.ts` holds the lifecycle part of `lockIssueForWrite` (modes from the table; PLAN-011 S3 owns the lock itself). Handlers `handlers/issues/delete.ts`, `restore.ts` and registration in `handlers/index.ts`. Idempotent no-ops write no history and emit no event. History `deleted`/`restored` (never folded), outbox events `issue.deleted`, `issue.restored`. Restore sets `updatedAt` and, for a deleted and archived issue, logs `V` and the `U` in one transaction.
- **Auto-close status refusal** (SPEC-010 AC-5, SPEC-015 E22; this slice is its only owner): the `status.delete` handler (PLAN-010 S2) passes the team's `autoCloseStatusId`, read under the team row lock it already holds, to `statusDeleteProblem`, which has had the parameter since PLAN-010 S1. Message: "This status closes stale issues. Choose another one in Settings → Automations first."
- **Wire up the edit refusals** in the handlers that exist (`issue.update`, `issue.updateDescription`): call the lock in `edit` mode. Comment, reaction and attachment handlers add theirs in PLAN-013 S3/S4 and PLAN-014 S4a; the table test (below) lists those rows as `pending` until then.
- **Operations** (`packages/operations/src/ops/issue-lifecycle.ts`, new): `issue.delete` (destructive, `ui` Delete issue, `Mod+Backspace`), `issue.restore` (`ui` Restore issue, `#`), with `optimistic` per §6.2 and `ui.available`. `issue.purge` and `issue.listDeleted` come in S2 and S4.
- **Client:** none beyond the optimistic code (uses `store.unarchive` from PLAN-011 S1/S2).
- **UI:** none yet; the commands appear in the menu but the screens come in S4.
- **Tests:** `packages/domain/src/issue-lifecycle.test.ts` and `issue-lifecycle.prop.test.ts` (one state at a time over random operation sequences; exact 720 h boundary) cover AC-1, AC-3; `apps/server/test/issue-lifecycle-table.test.ts` (one case per row, fake repo; a test fails if a handler named in the table skips the lock) covers AC-1, AC-2, E15; `apps/server/test/status-delete-auto-close.test.ts` (the handler refuses the auto-close status with the E22 message and allows it once auto-close points elsewhere) covers E22 and SPEC-010 AC-5's auto-close clause; `apps/server/test/issue-delete-restore.test.ts` covers idempotence, AC-12 (the `deleted`/`restored` entries), E3, E4; `packages/operations/src/ops/issue-lifecycle.test.ts` covers optimistic output vs the server (AC-13 unit part).

### S2: Purge and the `trash-purge` job · M (2 d)
Needs S1, PLAN-011 S1 (`deleteWhere` with `log: false`), PLAN-011 S5/S6 (content and history rows exist). PLAN-014 S3 (`deleteFiles`, `blob_release`) is needed by PLAN-014 S4a's file step, not by this slice.
- **Operation** `issue.purge` (destructive, Admin only, `ui` "Permanently delete…", no shortcut) in `ops/issue-lifecycle.ts`; handler `handlers/issues/purge.ts` and `apps/server/src/issues/purge.ts` (the cascade plan from §4.5): lock in `lifecycle` mode, run every registered purge step, delete the issue with a logged `D`, `ctx.audit('issue.purged', …)`, event `issue.purged`. Counter never decremented.
- **Purge steps** (`apps/server/src/issues/purge-steps.ts`, new): a registry of `{ model, step(tx, repo, issueId) }`, run children before parents. Every child table of `issues` has an `ON DELETE RESTRICT` FK, so a child without a step makes purge fail loudly. This slice registers the content children it knows: IssueContent and IssueHistory, deleted with `repo.deleteWhere(…, { log: false })` (PLAN-011 S1; no `D` per row, Q2). Later plans append theirs in the same PR as their table: PLAN-013 S3 registers Comment and Reaction (both content models: `log: false`, replies before roots), PLAN-014 S4a registers Attachment (eager: one `D` each) and the issue's `files` rows (attachment, inline, preview) through PLAN-014 S3's `deleteFiles`, which records keys in `blob_release`. A test lists every table with an FK to `issues` (from the Drizzle schema) and fails if one has no step.
- **Q2 fallback:** a constant `LOG_CONTENT_DELETES` in `purge-steps.ts`, passed as `log` to every content step. If the acceptance gate does not accept the ADR it stays `true` and content rows get one `D` each, in chunks; flipping it needs no other change.
- **Job** `trash-purge` (`apps/server/src/jobs/trash-purge.ts`, new): add to `QUEUES` in `jobs/index.ts` (cron `53 3 * * *`), a catch-up job on worker start with `singletonKey: 'trash-purge'`, batches of 100 oldest first, at most 5,000 a run, `NOT_FOUND` counts as done, system actor through the executor, one issue per transaction. Metrics in `executor/metrics.ts` style: `surface_trash_purged_total`, `surface_trash_purge_failures_total`, oldest-deleted age gauge.
- **Shared job helper** `apps/server/src/jobs/daily-batch.ts` (new): the select-batch loop, cap, catch-up and `singletonKey` rule, reused by S3. Takes a clock and a queue so tests use fakes.
- **UI:** none (the dialog lands in S4).
- **Tests:** `apps/server/test/issue-purge.test.ts` (row and `D` counts on a fake repo: content steps unlogged, the issue `D` logged; counter kept; Admin only; `CONFLICT` on a live or archived issue) covers AC-4, AC-10 (purge part), E6, E8, E16; `apps/server/test/purge-steps.test.ts` (every table with an FK to `issues` has a step; steps run children first) guards later plans; `apps/server/test/trash-purge-job.test.ts` (fake clock, executor, queue; exact boundary, 100 per batch, 5,000 cap, resume, `singletonKey`) covers AC-6, E4; `apps/server/test/purge-bytes.test.ts` (fake blob store; crash after commit still ends with bytes removed; same for an Admin purge) covers AC-5, E7, written in PLAN-014 S4a with the file step (this slice has no file step yet); sync property generator gets `delete`, `restore`, `purge` (`packages/sync-client/test/lifecycle.prop.test.ts`, not held) covers AC-13 (purge part). Integration for AC-4/AC-6 is ⏸ held.

### S3: Auto-archive, auto-close and the Automations page · M (3 d)
Needs S1, S2's `daily-batch.ts`, PLAN-011 S4 (category side effects of SPEC-011 §4.6), PLAN-011 S1 (`systemOnly` flag).
- **Operations:** `issue.autoArchive` and `issue.autoClose` (`systemOnly: true`, no `ui`, no `optimistic`; `packages/operations/src/ops/issue-lifecycle.ts`), `team.updateAutomations` (`ops/team.ts`; Zod unions of 1/3/6/9/12, `null` turns auto-close off, defaults 6 months and the first Canceled status, `autoCloseStatus` must be a Canceled-category status of the team). Handlers in `handlers/issues/auto-archive.ts`, `auto-close.ts`, `handlers/teams/update-automations.ts`.
- **Handlers re-check under the lock** that the issue is still live, closed (or stale) per the team setting, so E21 holds. `autoArchive` writes `archived` history (system actor) and the `issue.archived` event and logs an `A` packet; `autoClose` writes an `updated` history entry with the status change and emits `issue.updated`.
- **Jobs:** `auto-archive` (cron `29 3 * * *`) and `auto-close` (cron `17 3 * * *`) in `apps/server/src/jobs/auto-archive.ts` and `auto-close.ts`, registered in `jobs/index.ts`. Selection SQL per §6.3 (`greatest(completedAt, canceledAt, updatedAt) + N months`); Duplicate counts as Canceled. Metrics per §6.3.
- **Status guard:** done in S1 (the auto-close status can't be deleted). `team.updateAutomations` changing `autoCloseStatus` is what lifts it.
- **UI:** `apps/web/src/features/teams/TeamAutomationsScreen.tsx` (new) and route `/settings/teams/:key/automations` (`app/router.tsx`, link from `TeamSettingsLayout.tsx`). Selects offer only 1/3/6/9/12 months, auto-archive has no off switch, auto-close toggle off by default; copy as in §3.2. Hide the M3 toggles.
- **Registry:** `systemOnly` rows are exempt from the seed run and rule 4 (PLAN-011 S1); add the archived and deleted issue to the seed fixture for `pnpm registry:lint` examples.
- **Tests:** `apps/server/test/auto-archive-job.test.ts` covers AC-7, E19, E20; `apps/server/test/auto-close-job.test.ts` covers AC-8, E21; `apps/server/test/automations-handlers.test.ts` covers AC-16 (operation validation), AC-10 (`team.updateAutomations`, system-only ops not callable by a user, key or MCP), E10; `apps/web/test/team-automations.test.tsx` covers AC-16 (component); `packages/operations/test/spec-015.test.ts` covers AC-18; the sync property generator adds `autoArchive` (archive then restore equals a fresh bootstrap), AC-13.

### S4: Archive page, issue page states, shortcuts, dialogs · M (3 d)
Needs S1, S2, PLAN-012 S4 (issue page and its read-only frame), PLAN-012 S6 (delete dialog, `Mod+Z`), PLAN-011 S2 (`$archived` on the client), PLAN-012 S1 (engine).
- **Ownership with PLAN-012.** PLAN-012 owns what acts on a live issue: the read-only frame of the issue page (S4: badge, breadcrumb, pills that don't open, comment box and reactions hidden, not-found page), the delete confirm dialog, `Mod+Backspace`, `last-delete.ts` and `Mod+Z` (S6). This slice owns what acts on an archived or deleted issue: the archive page, Restore and `#`, Permanently delete…, `G X` and the Go-to-archive commands.
- **Operation** `issue.listDeleted` (`ops/issue-lifecycle.ts`; full `listInput` plus `team?`, `DeletedIssue` = `IssueSummary` + `deletedBy`, `purgeAfter`; applies `teamIds` in SQL; passes lint rule 6); handler `handlers/issues/list-deleted.ts` using `executor/list.ts`.
- **Client filters:** every list view filters with `lifecycleOf` (`apps/web/src/features/issues/lifecycle-filter.ts`, new; PLAN-012 S3 lists call it). The team list footer shows "N archived issues"; a deleted row hides by the client clock once `now >= purgeAfter`.
- **Screens:** `apps/web/src/features/archive/` (new): `ArchiveScreen.tsx` with tabs Issues and Recently deleted issues, routes `/team/:key/archive` and `/team/:key/archive/recently-deleted` (`app/router.tsx`), the removed reserved `/trash` route, empty state "No matching issues", row menu Copy › and Restore. Works from the replica, offline.
- **Issue page actions** (into PLAN-012 S4's read-only frame): the "…" menu items Restore and Permanently delete… (Admin) next to Copy ›; after a purge the open page shows PLAN-012 S4's not-found state (E5, E9).
- **Dialogs:** Permanently delete confirm (plain, no shortcut). The delete confirm is PLAN-012 S6's `DeleteIssueDialog`; this slice checks its SPEC-015 wording (`Delete "ENG-42 – <title>"?`, the 30-day text). Rejected-edit toast with **Copy text** (E1, E2).
- **Shortcuts and commands:** the `Restore issue` handler behind `#` (the binding is registered by PLAN-012 S1 and S6, `whileTyping: false`); `G` `X` goes to the archive page; commands "Go to archived issues in {team}" and "Go to recently deleted issues in {team}" (`command-menu/sources/navigation.ts`); `ui.available` shows Restore only on archived and deleted issues (PLAN-012 S6 hides the edit commands there). `Mod+Backspace`, `Mod+Z` and destructive ranking are PLAN-012's (S1, S6). Update `docs/05-design/shortcuts.md` on acceptance.
- **Tests:** `apps/server/test/issue-list-deleted.test.ts` covers AC-9 (query part), E13; `packages/domain/src/issue-lifecycle-views.test.ts` covers AC-9 (filters); `apps/web/test/archive-screen.test.tsx` covers AC-9 (UI), E13, E14 (queued restore); `apps/web/test/issue-page-lifecycle.test.tsx` covers AC-2 (UI), E5, E9, E17; `apps/web/test/purge-dialog.test.tsx` covers AC-15 (Permanently delete) and checks the delete dialog's SPEC-015 wording; `apps/web/test/lifecycle-shortcuts.test.ts` covers AC-14 (`#`, `G X`), E18; `apps/web/test/command-menu-lifecycle.test.ts` covers AC-15 (Restore availability, Go-to commands). AC-17 is ⏸ held; checked by hand at the M1 demo.

### S5: Leak tests and edge cases · S (1 d)
Needs S1 to S4.
- **Leak test** `apps/server/test/lifecycle-leak.int.test.ts` (not held): for a non-member, `issue.listDeleted` with `withTotal`, `issue.delete`/`restore`/`purge` on a private team (all `NOT_FOUND`, worded as for a missing issue), `/sync/content` and `GET /files/:id` of a deleted private issue and its attachments, the `U`, `A`, `V` and `D` deltas including the jobs' archive, MCP `search_operations` examples; an API key with `teamIds=[A]` sees nothing of team B in any of them. Admin non-member purge of a private team's issue (E12).
- **Sync property suite:** make sure delete, restore, auto-archive and purge are in the generator and the "equals fresh bootstrap" check (AC-13); run at the usual case count.
- **Edge sweep:** add any E-case still without a named test (see §4); update the lifecycle rule table test so no row is `pending`.
- **Docs:** mark slices done, "As built" notes, update SPEC-015 and the docs of its §12 if behaviour changed.
- **Tests:** as above; covers AC-11, AC-13, E12.

---

## 2. Modules touched
`packages/domain/src/{issue-lifecycle,team}.ts`, `packages/domain/src/model/workspace-models.ts`, `packages/operations/src/ops/{issue-lifecycle,team}.ts`, `apps/server/src/issues/{lifecycle,purge}.ts`, `apps/server/src/handlers/{issues,teams}/*` and `handlers/index.ts`, `apps/server/src/jobs/{index,daily-batch,trash-purge,auto-archive,auto-close}.ts`, `apps/server/src/db/schema/workspace.ts`, `apps/server/src/executor/metrics.ts`, migration, `apps/web/src/features/{archive,issues,teams}/*`, `apps/web/src/app/router.tsx`, `apps/web/src/shortcuts/*`, `apps/web/src/command-menu/*`, `packages/sync-client/test/lifecycle.prop.test.ts`, docs listed in SPEC-015 §12.

## 3. Migration & rollback
One migration (S1), with the index, the new team column and the tightened checks. Before release, a rollback is a revert of the migration (drop the index and column, restore the old checks and nullability). After release it is forward-only: later changes add a new migration. Backfilling null `auto_archive_months` to 6 is lossless. The jobs and operations are code only.

## 4. Test plan (AC → test)

> ⏸ Tests that need a browser, a running stack or Postgres are held ([README §6](README.md#6-testing-hold-e2e-smoke-and-integration)). Held rows get no test for now. Unit and property tests, the sync property suite and private-team leak tests are still written.

| AC | Test |
|---|---|
| AC-1 | `issue-lifecycle.test.ts`, `issue-lifecycle.prop.test.ts` (domain), `server/test/issue-lifecycle-table.test.ts` (S1; rows added by PLAN-013/014 slices) |
| AC-2 | `server/test/issue-lifecycle-table.test.ts` (repo calls on a fake repo), `web/test/issue-page-lifecycle.test.tsx` |
| AC-3 | `domain/src/issue-lifecycle.test.ts` "restore at 720 h minus 1 ms / at 720 h", `server/test/issue-delete-restore.test.ts` |
| AC-4 | `server/test/issue-purge.test.ts` + `server/test/purge-steps.test.ts` (S2; steps added by PLAN-013 S3 and PLAN-014 S4a) + ⏸ held (integration) `server/test/issue-purge.int.test.ts` |
| AC-5 | `server/test/purge-bytes.test.ts` (written in PLAN-014 S4a with the file step) |
| AC-6 | `server/test/trash-purge-job.test.ts` + ⏸ held (integration) `server/test/trash-purge-job.int.test.ts` |
| AC-7 | `server/test/auto-archive-job.test.ts` |
| AC-8 | `server/test/auto-close-job.test.ts` |
| AC-9 | `domain/src/issue-lifecycle-views.test.ts`, `server/test/issue-list-deleted.test.ts`, `web/test/archive-screen.test.tsx` |
| AC-10 | `server/test/issue-purge.test.ts` (Admin only, `allowDestructive`), `server/test/automations-handlers.test.ts` (system-only ops, `teamIds`), `server/test/issue-list-deleted.test.ts` (`teamIds` in SQL) |
| AC-11 (leak) | `server/test/lifecycle-leak.int.test.ts` (not held: permissions.md §5) |
| AC-12 | `server/test/issue-delete-restore.test.ts` (history kinds, one `restored`), `server/test/auto-archive-job.test.ts` (`archived`), `server/test/auto-close-job.test.ts` (`updated`) |
| AC-13 | `operations/src/ops/issue-lifecycle.test.ts` (unit) + `sync-client/test/lifecycle.prop.test.ts` (sync property suite, not held) |
| AC-14 | `web/test/lifecycle-shortcuts.test.ts` (S4: `#`, `G X`) + PLAN-012 S6 `web/test/last-delete.test.ts` and `issue-shortcuts.test.tsx` (`Mod+Backspace`, `Mod+Z`) + PLAN-012 S1 `shortcuts-conflicts.test.ts` |
| AC-15 | `web/test/purge-dialog.test.tsx`, `web/test/command-menu-lifecycle.test.ts` (S4) + PLAN-012 S6 `web/test/delete-issue-dialog.test.tsx` (delete confirm) and PLAN-012 S1 `command-ranking.test.ts` (destructive ranking) |
| AC-16 | `server/test/automations-handlers.test.ts`, `web/test/team-automations.test.tsx` |
| AC-17 | ⏸ held (e2e) `e2e/lifecycle-keyboard.spec.ts`; checked by hand at the M1 demo (PLAN-012 S7) |
| AC-18 | `operations/test/spec-015.test.ts` + the registry-wide `operations/test/lint.test.ts` |
| E1, E2 | `web/test/issue-page-lifecycle.test.tsx` (rollback, Copy text) + `server/test/issue-lifecycle-table.test.ts` (the message) |
| E3, E15 | `server/test/issue-delete-restore.test.ts` (lock order and result with two interleaved fake transactions) |
| E4, E14 | `server/test/issue-delete-restore.test.ts`, `web/test/archive-screen.test.tsx` |
| E5, E9 | `web/test/issue-page-lifecycle.test.tsx` |
| E6, E7, E8, E16 | `server/test/issue-purge.test.ts`, `server/test/purge-bytes.test.ts` |
| E10 | `server/test/automations-handlers.test.ts` (S3) |
| E22 | `server/test/status-delete-auto-close.test.ts` (S1) |
| E11 | PLAN-010 S5 label-delete tests, plus one case in `issue-lifecycle-table.test.ts` (stays archived or deleted, `updatedAt` unchanged) |
| E12 | `server/test/lifecycle-leak.int.test.ts` |
| E13 | `web/test/archive-screen.test.tsx`, `server/test/issue-list-deleted.test.ts` |
| E17 | `server/test/issue-lifecycle-table.test.ts` (`reaction.set` row) |
| E18 | `web/test/lifecycle-shortcuts.test.ts` |
| E19, E20 | `server/test/auto-archive-job.test.ts` |
| E21 | `server/test/auto-close-job.test.ts` |

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| A new write path skips `lockIssueForWrite`, so a comment lands on a deleted issue | The table test fails if a named handler skips the lock; each later plan adds its row (PLAN-013 S3/S4, PLAN-014 S4a). |
| A new child table of `issues` has no purge step, so purge fails on the `RESTRICT` FK | `purge-steps.test.ts` reads the schema and fails when a table with an FK to `issues` has no registered step; PLAN-013 S3 and PLAN-014 S4a register theirs in the PR that adds the table. |
| Purge of a heavy issue holds the global sync lock too long | Content rows log no `D` (Q2); the fallback constant keeps the chunked per-row log if the ADR is not accepted. Measured against the §10 budget once the perf hold lifts. |
| Skipping content `D`s leaves a client replica with stale content | The client drops content when the Issue is absent after a batch (PLAN-011 S5b); the sync property suite compares the replica to a fresh bootstrap after a purge. |
| Jobs run twice or never (several workers, a down day) | `singletonKey` plus catch-up on start; all three jobs are idempotent and cap at 5,000 a run. |
| Auto-archive or auto-close surprises users (a big backlog archived at once) | Default 6 months, "changes apply within a day" copy, 5,000 cap spreads a large backlog over days (E19). |
| The 30-day boundary differs between client and server | One `purgeAfter` in `packages/domain`, used by both; exact-boundary tests with a fake clock. |
| Blocking dependency order: S1 needs PLAN-011 S4 and PLAN-012 S1; S4 needs PLAN-012 S4 | The slices stay mergeable because the rule table, handlers and jobs are tested with fakes; S4 is the last slice and waits for the issue page. |
| Existing nullable team columns hold rows that break the new checks | The migration backfills nulls to 6 before adding the checks. |
