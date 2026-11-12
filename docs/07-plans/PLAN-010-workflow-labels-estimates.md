# PLAN-010: Workflow statuses, labels & estimates

Implements: [SPEC-010](../06-specs/SPEC-010-workflow-labels-estimates.md) · Status: **Draft** (waits for M1 acceptance, [README §7](README.md)) · Order: **S1–S4 start at once** (they need only M0); **S5 after PLAN-011 S4 and this plan's S2–S3**; **S6 after PLAN-011 S2** · Depends on: PLAN-011 S2 (archive on the wire) for S6, PLAN-011 S4 (issue operations) for S5, PLAN-011 S1 (`store.find`, repo `updateWhere`, chunked flush) for S5, PLAN-015 S1 (`teams.auto_close_status_id`) for the auto-close refusal, PLAN-012 S1 (shortcut engine, `settings-row` scope) for the key registrations, whichever merges first (see the keys note)

> **UI note:** screens use the `packages/ui` primitives that exist today: `Dialog`, `Menu`, `Toast`, `Switch`, `Input`, `Textarea`, `Badge`, `Tabs`, `EmptyState` and `ColorPicker` (the 12-hue swatch row for status and label colors). There is no `Select`, `List` or `Toggle` component: a choice among a few values (estimate scale, group type) is a native `<select>` styled with the design tokens, an on/off setting is a `Switch`, and the reorderable rows are a `role="listbox"` built in the feature (roving `tabindex`), not a shared component. The pickers in PLAN-012 S2 are not needed. Branches are `p010-sN-topic`, e.g. `p010-s2-statuses`.

> **Keys and PLAN-012 S1.** SPEC-010 §7.1 uses `Alt+↑/↓`, `E`, `Enter`, `Esc` and `Mod+Backspace` in the `settings-row` scope, with the per-binding "inactive while typing" flag that PLAN-012 S1 adds to the shortcut engine. S2 and S3 do not wait for it. **One owner at a time, never both:** if PLAN-012 S1 has merged when S2 or S3 starts, the rows bind through the engine (`settings-row` scope, `useCommand`) and have no local handler. If not, each settings list handles these keys in its own `onKeyDown` on the focused row, ignoring text-field targets, and PLAN-012 S1 deletes those handlers in the same PR that registers the bindings (a named task in that slice, with a test that one key press runs one action).

---

## 1. Slices

### S1: Domain & migration · M (2 d)
- **Migration** (next migration number, one file, hand-written SQL for the collation): `workflow_statuses.position` gets `COLLATE "C"`; `labels.exclusive boolean not null default true`; `teams.estimate_extended boolean not null default false`, `teams.estimate_allow_zero boolean not null default false`, `teams.estimate_count_unestimated_as_one boolean not null default true`. All are synced columns. Drizzle schema in `apps/server/src/db/schema/workspace.ts`.
- **Models** in `packages/domain/src/model/workspace-models.ts`: `Label` gains `exclusive`; `Team` gains `estimateExtended`, `estimateAllowZero`, `estimateCountUnestimatedAsOne`. This bumps the schema hash on both sides. `TeamSchema` and `teamOutput` (`apps/server/src/handlers/teams/shared.ts`) carry the three new fields. `workspace-models.test.ts` (column-per-field check) must stay green.
- **Domain, pure and new:**
  - `packages/domain/src/fractional-key.ts`: `fractionalKeyBetween(a, b)`, written in-house, byte order, no new dependency. It continues the `a0`, `a1` keys the seed already writes.
  - `packages/domain/src/workflow.ts` (next to `workflowProblems` in `workspace.ts`): `STATUS_LIMIT = 50`, `statusNameProblem`, `statusDeleteProblem(workflow, defaultStatusId, issueCounts, autoCloseStatusId?)`, with the refusal order of SPEC-010 §4.1 and the exact messages of §6.
  - `packages/domain/src/label.ts`: `LABEL_LIMITS` (500 per scope, 250 per group), `RESERVED_LABEL_NAMES`, `labelNameProblem`, `parseLabelInput(text)` (`Group/Label`, `Group:Label`), `labelGroupProblem` (same scope, live group, group has no parent), and the label-write rule `applyLabelAdd(labels, current, added)` that SPEC-011 calls (AC-10).
  - `packages/domain/src/estimate.ts`: `estimateValues`, `isValidEstimate`, `formatEstimate`, taking `{ scale, extended, allowZero }`.
  - `labelUsage(labels, issues)` goes here too (pure; S5 uses it on the labels page).
- Nothing is wired to operations yet. Every function is exported from `packages/domain/src/index.ts`.
- **Tests:** `packages/domain/src/fractional-key.test.ts` and `fractional-key.prop.test.ts` (AC-3 property: any insert and move sequence is a strict total order, no duplicates); `workflow.test.ts` (AC-5 and AC-6 pure parts, message wording, refusal order; AC-6 issue-set property is written in S5); `label.test.ts` (AC-9 name and group rules, AC-13 limits, AC-25, E18, E19); `label-write.test.ts` and `label-write.prop.test.ts` (AC-10); `estimate.test.ts` (AC-8, E5); `label-usage.test.ts` (AC-26); `server/test/workspace-models.test.ts` (new columns match the new fields).

### S2: Statuses · L (4 d)
- **Operations** in `packages/operations/src/ops/status.ts` (new, registered in `ops/index.ts`): `status.list`, `status.create`, `status.update`, `status.reorder`, `status.delete` (destructive), as in SPEC-010 §6. Each has two or more keywords and an example against the seed fixture. `status.create` has the `ui` entry "Add status…" (team context).
- **Handlers** in `apps/server/src/handlers/statuses/{list,create,update,reorder,delete}.ts` (new, added to `handlers/index.ts`), using the repo only. Each takes the team row `FOR UPDATE` first, then the status rows, then re-reads anchors `FOR KEY SHARE` (SPEC-010 §4.4). Create and reorder compute the key with `fractionalKeyBetween` from the neighbours in the category. The 50-status limit and the name uniqueness (case-insensitive) are checked under the lock. `status.delete` runs `statusDeleteProblem` with **no issue count yet**: the issue half is S5, and `lockIssueForWrite` does not exist. Until S5 the count is zero by construction (there are no issues). The `RESTRICT` foreign key arrives with PLAN-011 S3.
- **Refs:** `StatusRef` already resolves by name within the team. Check `apps/server/src/executor/refs/sources.ts` serves it for `status.*` input and that the `team` scoping works for all five operations.
- **Optimistic** (`optimistic` on each operation, same `fractionalKeyBetween` as the server): create inserts the row, update patches, reorder writes only the moved row, delete removes the row. The "has issues, so refuse" branch lands in S5.
- **Settings page** `apps/web/src/features/statuses/` (new): `WorkflowScreen.tsx`, `StatusRow.tsx`, `StatusForm.tsx` (the inline add and edit form), `model.ts` (grouping by category, hiding Triage, Duplicate marked "System", the "+" disabled while a form is open), `commands.ts` (`STATUS_COMMANDS` for `status.create`: `opens: 'settings.addStatus'` with the category sub-page), `statuses.module.css`. Registered in `features/screens.ts` and `features/commands.ts` (one line each). Route `/settings/teams/:key/workflow` added in `apps/web/src/app/router.tsx`, nav entry in `app/settings.ts`. Rows are a `role="listbox"` in the `settings-row` scope with the keys described in the note above (engine bindings or local handlers, never both): `Enter` edit, `Esc` cancel, `Alt+↑/↓` reorder, `Mod+Backspace` delete. Drag reorder uses pointer events and calls `status.reorder` once on drop. The delete dialog ("Delete the "In Review" status? This can't be undone.") is the `packages/ui` `Dialog`. The refusal toast and the issue-count column show "—" until S5. Non-members of a public team see the page read-only with "Join the team to edit".
- **Make default** is in the row menu; the operation itself (`team.setDefaultStatus`) is S4, so the menu item is added in S4. The "Default" badge shows from `team.defaultStatusId` now.
- **Behind a stub until later:** the issue count and "View issues" link (S5, PLAN-012 S3); the auto-close refusal (see PLAN-015 S1, which adds `teams.auto_close_status_id` and passes it into `statusDeleteProblem`; S1 already has the parameter and a test for it).
- **Tests:**
  - `packages/operations/src/ops/status.test.ts` (shape, inputs, `category` excludes triage and duplicate, example runs, optimistic rows; AC-1, AC-16 optimistic part)
  - `apps/server/test/status-handlers.test.ts` (AC-1, AC-2, AC-3, AC-5 without issue counts, AC-13 status limit, AC-14 permissions and E11, E3 lock order by reading the lock calls on a fake repo, E4, E17 first half)
  - `apps/server/test/status-workflow.prop.test.ts` (AC-4: random sequences of create, update, reorder, delete and default changes, through the handlers on an in-memory repo; `workflowProblems` empty after every commit, a rejected operation changes nothing)
  - `packages/sync-client/test/status-optimistic.test.ts` (optimistic equals the server's rows, AC-16)
  - `apps/web/test/workflow-screen.test.tsx` (grouping, Triage hidden, Duplicate no menu, add and edit forms, `Alt+↑/↓`, delete dialog, read-only note, AC-23 for "Add status…")
  - `apps/web/test/status-commands.test.ts` (`checkOperationCommands`)

### S3: Labels · L (4 d)
- **Operations** in `packages/operations/src/ops/label.ts` (new): `label.list`, `label.create`, `label.update`, `label.delete` (destructive), `label.moveToWorkspace`. `label.archive` and `label.unarchive` are **S6**, because archive state is not on the wire before PLAN-011 S2 (a client would drop an archived label from its replica). `label.create` has the `ui` entry "Create label…" (team and global contexts). `label.list` takes the full `listInput` and honours `includeArchived`, `team`, `scope` and `group`.
- **`LabelRef` changes** (SPEC-003 §4, in `packages/domain/src/refs.ts` and the server resolver in `apps/server/src/executor/refs/`): `Group/Label` with spaces around `/` ignored; a uuid resolves to any visible label without `team`; a bare name matching several labels is `INVALID_INPUT` listing `Group/Label` candidates (E9); a team label name without `team` does not resolve.
- **Handlers** in `apps/server/src/handlers/labels/{list,create,update,delete,move-to-workspace}.ts` (new). Lock order: workspace row (workspace labels) or team row (team labels), then the label rows. `moveToWorkspace` locks the workspace row, then the team row. Create and update check name, reserved words, group scope and group liveness (`archived_at` is null; no archive ops exist yet, so it is always true until S6), and the limits under the lock. `exclusive` only with `isGroup`. A narrowed API key gets `FORBIDDEN` on any workspace-label mutation (permissions §3.5), implemented in the permission check of these operations (`packages/operations/src/permission.ts`). `label.delete` here refuses a group with labels and deletes the label row; the `labelIds` rewrite is **S5**, and until then there are no issues so there is nothing to rewrite.
- **`label.moveToWorkspace`:** sets `teamId` to null on the label, or on a group and all its labels, in one transaction through `repo.update`. A label inside a group is refused (E21); a name clash is `CONFLICT` on `name` (E20). No issue is read. The repo already logs `U`, or `D` then `U` when groups change (sync-protocol §6): a test pins both.
- **Optimistic:** create, update, delete (removes the Label row only), moveToWorkspace (label, or group and `store.find('Label', { parentId })`).
- **Pages** `apps/web/src/features/labels/` (new): `LabelsScreen.tsx` (one component for the team page and the workspace page), `LabelTable.tsx`, `LabelRow.tsx` (inline description edit, row menu with `E`, Move to workspace, Delete), `NewLabelRow.tsx` (uses `parseLabelInput`), `model.ts` (filter by name, group expand, "N labels inherited from workspace"), `commands.ts` (`LABEL_COMMANDS`: `opens: 'settings.createLabel'` and the scope sub-page), `labels.module.css`. Routes `/settings/teams/:key/labels` and `/settings/labels` (every member; nav entry under Workspace, outside the Admin-only page). Delete and Move to workspace use Dialogs with the §3.2 wording. The Archived section, the Archive menu item and the group "Add label to group" archive rule appear in S6. The usage columns (Used in, Issues, Last applied) show "—" until S5.
- **Group type** ("Group type: Single / Multiple", a native `<select>`) calls `label.update { exclusive }` and never reads issues.
- **Tests:**
  - `packages/operations/src/ops/label.test.ts` (shapes, `Group/Label` input, examples, optimistic rows, AC-16)
  - `packages/domain/src/refs.test.ts` additions (AC-18)
  - `apps/server/test/label-handlers.test.ts` (AC-9, AC-13 label limits, AC-14 incl. narrowed key and E15, AC-24 unit parts: one transaction, E20, E21, no issue touched; E7 count shape without issues; E9, E18, E19)
  - `apps/server/test/label-move-log.test.ts` (AC-24 repo log: one `U` per label for a public team; `D` then `U` for a private team)
  - `apps/server/test/label-leak.int.test.ts` (AC-15 and AC-24 leak part, **not held**: a non-member of private SEC gets none of its labels or statuses in bootstrap, catch-up and live deltas; every `label.*` and `status.*` operation naming one is `NOT_FOUND` worded as for an unknown one, by name, uuid and `Group/Label`; `label.list` and `status.list` never return them; after `moveToWorkspace` of a SEC label a non-member receives only the `U`). The statuses half of the matrix is written here so one file covers the settings rows.
  - `packages/sync-client/test/label-optimistic.test.ts` (AC-16, AC-17 label part)
  - `apps/web/test/labels-screen.test.tsx` (table, filter, group expand, New label row, Group/Label typing, delete and move dialogs, read-only note, AC-23 for "Create label…")
  - `apps/web/test/label-commands.test.ts`

### S4: Estimates & default status · M (2 d)
- **Operations** in `packages/operations/src/ops/team.ts` (existing file, two new operations): `team.setDefaultStatus` (`ui` "Set default status…", team context, `page` kind) and `team.setEstimates` (`ui` "Change estimate scale…", team context, `page` kind), as in SPEC-010 §6. `TeamSchema` already has the fields from S1. `team.update` stays unchanged.
- **Handlers** `apps/server/src/handlers/teams/{set-default-status,set-estimates}.ts` (new). Both take the team row `FOR UPDATE`. `setDefaultStatus` re-reads the status `FOR KEY SHARE` and accepts only Backlog or Unstarted of the same team (E17). `setEstimates` requires at least one field and never reads an issue (Q8).
- **Optimistic:** `setDefaultStatus` patches `defaultStatusId` with the resolved id, never the ref text. `setEstimates` patches the given fields.
- **Estimates page** `apps/web/src/features/estimates/` (new): `EstimatesScreen.tsx` (a native `<select>` for the scale and three `Switch`es, each change saves at once), `model.ts` (the scale labels with their value lists from `estimateValues`). Route `/settings/teams/:key/estimates`. Command entries in `features/estimates/commands.ts` (sub-pages listing the scales, and the team's Backlog and Unstarted statuses).
- **Make default** menu item and the Default badge hookup added to the S2 row menu (`features/statuses/StatusRow.tsx`).
- **Tests:** `packages/operations/src/ops/team.test.ts` additions (AC-7, AC-16); `apps/server/test/team-estimates-handlers.test.ts` (AC-7, AC-14 for both, E17 both orders on a fake repo); `apps/server/test/status-workflow.prop.test.ts` extended with default changes (AC-4); `packages/sync-client/test/team-settings-optimistic.test.ts` (AC-16); `apps/web/test/estimates-screen.test.tsx` (each toggle saves at once, `off` hides the toggles); `apps/web/test/workflow-commands.test.ts` and `estimate-commands.test.ts` (AC-23 for "Set default status…" and "Change estimate scale…").

### S5: Issue-dependent halves · M (3 d) · needs S2, S3, PLAN-011 S1 and S4
- **`status.delete`:** the handler now counts issues with that `status_id` in every lifecycle state, apart from permanently deleted (there is no row for those), and passes the counts to `statusDeleteProblem`, with the split into "archived or recently deleted" for the message. It locks no issue (SPEC-010 §4.4). The optimistic prediction checks `store.find('Issue', { statusId })` and throws the refusal message, so nothing queues. The settings page shows the issue count per status and the refusal toast. The "View issues" link waits for PLAN-012 S3 and is left out.
- **`label.delete`:** the handler takes the scope row (team or workspace) and the label row `FOR UPDATE`, then calls PLAN-011 S4's `removeLabelFromIssues(tx, repo, labelId)` (issues in ascending id, `updateWhere` with `touchUpdatedAt: false`, chunked), then deletes the label. It does not write `labelIds` itself. It returns `removedFromIssues` counting only issues the actor can see. No history entry, no event, no lifecycle change; archived and recently deleted issues are written too.
- **Label write rule in `issue.create` and `issue.update`:** PLAN-011 S4 owns it: it calls `applyLabelAdd` (S1), takes `FOR KEY SHARE` on newly set labels and statuses before the issue lock, and refuses archived labels (SPEC-010 E12, E13). S5 adds no code there; it adds the tests that need a real `label.delete` and `status.delete` racing those edits (`issue-label-lock.test.ts`, the AC-19 run).
- **Client:** `label.delete` optimistic removes the Label row only; renderers skip unknown label ids (this is PLAN-012's rule; S5 adds `labelsOf(issue, store)` in `packages/domain` or the web feature as the one shared helper and a test). The labels page now shows the usage columns from `labelUsage`. The E1 message: a helper `statusGoneMessage(error, store)` in `packages/sync-client` returns "That status was deleted. Choose another." when the replica has seen the status's `D` delta, else the server's message.
- **Sync property suite:** `tests/sync-sim/src/steps.ts` and `properties.ts` gain `status.delete`, `status.create`, `team.setDefaultStatus`, `label.delete` and label-add steps, so concurrent runs interleave a delete with an issue edit into the same status or label (AC-19, E16, E17). Invariant added: no issue references a missing status or label after a run, INV-04/05 hold, replicas equal a fresh bootstrap. The deletes need real `issues`, so this runs in the real-server run (`real-server.int.test.ts`) and in the fake-hub simulation if its server model has issues; if not, only the real-server run covers it, and the plan says so in "As built".
- **Leak additions** (`apps/server/test/label-leak.int.test.ts`, **not held**): E7, `removedFromIssues` counts only issues the actor can see when a workspace label is deleted; `status.delete` on a status the actor can't see gives no count.
- **Tests:**
  - `packages/domain/src/workflow.prop.test.ts` (AC-6: for any workflow and issue set, an allowed delete leaves no issue on the status and keeps INV-04/05)
  - `packages/domain/src/label-write.prop.test.ts` extended with the real issue shapes (AC-10)
  - `apps/server/test/status-delete-issues.test.ts` (AC-5 with counts: wording with and without the archived suffix, E8)
  - `apps/server/test/label-delete-cascade.test.ts` (AC-12: lock order scope row → label row → the helper, then the label delete; no `updatedAt` or history change; group refusal. Chunking itself is tested in PLAN-011 S1 and S4)
  - `apps/server/test/issue-label-lock.test.ts` (E16: `label.delete` and an `issue.update` adding the label, interleaved on a fake repo; read the lock calls, no cycle)
  - `packages/sync-client/test/status-label-delete-optimistic.test.ts` (AC-17 with fake-indexeddb: refusal queues nothing, rollback on rejection, E1 message)
  - `apps/web/test/labels-usage.test.tsx`
  - the suite files above (AC-19, not held)

### S6: Label archive · S (1 d) · needs PLAN-011 S2
- **Operations:** `label.archive` and `label.unarchive` in `ops/label.ts`; handlers `apps/server/src/handlers/labels/{archive,unarchive}.ts`. A group takes all its labels in one transaction, archived or not; unarchiving a group unarchives all (Q16). Archiving an archived label changes nothing.
- **Rules now enforced** in `label.create`, `label.update` and `label.moveToWorkspace`: no new label in, no move into, and no unarchive of a label in an archived group (E14, "The Size group is archived. Unarchive the group first."). An archived label can still be renamed and recolored. `label.list` returns archived labels with `includeArchived`.
- **Add-path refusal** (E12, E13) is PLAN-011 S4's: `issue.create` and `issue.update` already refuse an archived label from `Label.archivedAt`. S6 adds no issue code; its tests archive a label through `label.archive` and check that the issue path refuses it.
- **Optimistic:** archive and unarchive use `store.unarchive` and the readable `archivedAt` (PLAN-011 S1/S2), including `store.find('Label', { parentId })` for groups.
- **UI:** the Archive and Unarchive menu items with the §3.2 dialog wording, the collapsed "Archived" section, and the "Add label to group" rule on the label table.
- **Tests:** `packages/operations/src/ops/label.test.ts` additions; `apps/server/test/label-archive-handlers.test.ts` (AC-11, E14, E15 for archive; E12, E13: archive with `label.archive`, then `issue.update` adding it is refused); `packages/sync-client/test/label-archive-optimistic.test.ts` (AC-16, group archive); `apps/server/test/label-archive-wire.int.test.ts` (**not held**, leak test: an archived team label is delivered as archive state to members and never to a non-member of a private team; bootstrap and catch-up included); `apps/web/test/labels-archive.test.tsx`.

---

## 2. Modules touched
`packages/domain/src/{fractional-key,workflow,label,estimate,refs,workspace,index}.ts`, `packages/domain/src/model/workspace-models.ts`, `packages/operations/src/ops/{status,label,team,index}.ts`, `packages/operations/src/permission.ts`, `apps/server/migrations/` (one new), `apps/server/src/db/schema/workspace.ts`, `apps/server/src/handlers/{statuses,labels,teams}/*`, `apps/server/src/handlers/index.ts`, `apps/server/src/executor/refs/*`, `packages/sync-client` (tests, `statusGoneMessage`), `tests/sync-sim/src/{steps,properties}.ts`, `apps/web/src/features/{statuses,labels,estimates}/*`, `apps/web/src/features/{screens,commands}.ts`, `apps/web/src/app/{router.tsx,settings.ts}`.

## 3. Migration & rollback
One migration (S1), adding three team columns, one label column and a collation change. All are additive or default-safe, but the collation change rewrites the `position` index.
- **Before release:** roll back by reverting the code and dropping the four columns and resetting the collation with `ALTER COLUMN position TYPE text COLLATE "default"`. Fractional keys written under `"C"` still sort correctly under the default collation for lower-case-and-digit keys, but the client and server would disagree on mixed-case keys, so revert the keys with the migration.
- **After release:** forward-only. The columns stay. A later change to them is a new migration.
- S2 to S6 add no migration. Settings deletes are hard deletes and cannot be rolled back by code; take a backup before running label-delete tests against real data.

## 4. Test plan (AC → test)

> ⏸ **Tests that need a browser, a running stack or Postgres are held** ([README §6](README.md#6-testing-hold-e2e-smoke-and-integration)). Leak tests and the sync property suite are not held. Unit and property tests in a held row are still written.

| AC | Test |
|---|---|
| AC-1 | `server/test/status-handlers.test.ts` (end of category, `after`, default hue, name clash `CONFLICT`, Triage and Duplicate `INVALID_INPUT`) + `operations/src/ops/status.test.ts` (S2) |
| AC-2 | `server/test/status-handlers.test.ts` (rename, recolor, describe; Duplicate refused; no `category` input) (S2) |
| AC-3 | `domain/src/fractional-key.prop.test.ts` (total order, no duplicates) (S1) + `server/test/status-handlers.test.ts` (only the moved row written; cross-category `INVALID_INPUT`) (S2) |
| AC-4 | `server/test/status-workflow.prop.test.ts` (S2, extended in S4) |
| AC-5 | `domain/src/workflow.test.ts` (refusal order and messages, S1) + `server/test/status-handlers.test.ts` (default, last in category, Triage, Duplicate, empty status deleted; S2) + `server/test/status-delete-issues.test.ts` (with issues, S5) + auto-close refusal: the pure part in S1, the handler wiring and its test in PLAN-015 S1 |
| AC-6 | `domain/src/workflow.prop.test.ts` (S5) |
| AC-7 | `server/test/team-estimates-handlers.test.ts` + `operations/src/ops/team.test.ts` (S4) |
| AC-8 | `domain/src/estimate.test.ts` (every scale, Extended and zero on and off; `off` accepts none; 0 vs `null`) (S1) |
| AC-9 | `domain/src/label.test.ts` (S1) + `server/test/label-handlers.test.ts` (S3) |
| AC-10 | `domain/src/label-write.test.ts` + `label-write.prop.test.ts` (S1); with real issues in S5 (`server/test/issue-label-lock.test.ts`); "moving into a group or switching to single reads no issues" in `server/test/label-handlers.test.ts` (S3) |
| AC-11 | `server/test/label-archive-handlers.test.ts` (S6) |
| AC-12 | `server/test/label-delete-cascade.test.ts` (S5); group refusal in `server/test/label-handlers.test.ts` (S3) |
| AC-13 | `domain/src/label.test.ts` (limits, S1) + `server/test/status-handlers.test.ts` (51st status, S2) + `server/test/label-handlers.test.ts` (501st and 251st, archived counted once S6 lands) |
| AC-14 | `server/test/status-handlers.test.ts` (S2), `server/test/label-handlers.test.ts` incl. narrowed key (S3), `server/test/team-estimates-handlers.test.ts` (S4) |
| AC-15 | `server/test/label-leak.int.test.ts` (S3; extended in S5 and S6; **not held**) |
| AC-16 | `operations/test/lint.test.ts` (registry-wide) + each `ops/*.test.ts` + `sync-client/test/{status,label,team-settings,label-archive}-optimistic.test.ts` (S2–S6) |
| AC-17 | `sync-client/test/status-label-delete-optimistic.test.ts` (S5) |
| AC-18 | `domain/src/refs.test.ts` additions (S3) |
| AC-19 | `tests/sync-sim` steps and properties + `real-server.int.test.ts` (S5; sync property suite, **not held**) |
| AC-20 | ⏸ held (e2e perf), checked by hand in S2 on a rename and a reorder across two tabs |
| AC-21 | ⏸ held (perf). The chunked-flush unit part (chunks ≤ 5,000, under 65,535 binds) is PLAN-011 S1's `server/test/sync-repo-bulk.test.ts`; `label.delete` reaching it through the helper is `server/test/label-delete-cascade.test.ts` (S5); the 2 s lock budget is read from the sync-lock metric by hand |
| AC-22 | ⏸ held (e2e), checked by hand across S2–S6 and recorded in the last slice's "As built" |
| AC-23 | `web/test/status-commands.test.ts` (S2), `label-commands.test.ts` (S3), `workflow-commands.test.ts` and `estimate-commands.test.ts` (S4) |
| AC-24 | `server/test/label-handlers.test.ts` + `label-move-log.test.ts` (S3) + leak part in `label-leak.int.test.ts` (**not held**); archived labels moving with a group, in S6 |
| AC-25 | `domain/src/label.test.ts` (`parseLabelInput`) (S1) + `web/test/labels-screen.test.tsx` (new group is single-select) (S3) |
| AC-26 | `domain/src/label-usage.test.ts` (S1) + `web/test/labels-usage.test.tsx` (S5) |
| E1 | `sync-client/test/status-label-delete-optimistic.test.ts` (S5) |
| E3 | `server/test/status-handlers.test.ts` (lock order) (S2) + AC-19 run (S5) |
| E4 | `server/test/status-handlers.test.ts` (S2) |
| E7 | `server/test/label-leak.int.test.ts` (S5, **not held**) |
| E9 | `server/test/label-handlers.test.ts` + `domain/src/refs.test.ts` (S3) |
| E11 | `server/test/status-handlers.test.ts` (S2) |
| E12, E13 | PLAN-011 S4 `server/test/issue-handlers.test.ts` (the refusal on the add path) + `server/test/label-archive-handlers.test.ts` (S6: archived through `label.archive`, then refused) |
| E14, E15 | `server/test/label-archive-handlers.test.ts` (S6); E15 non-archive paths in S3 |
| E16, E17 | `server/test/issue-label-lock.test.ts` and AC-19 run (S5); E17 unit in `server/test/team-estimates-handlers.test.ts` (S4) |
| E18, E19, E20, E21 | `domain/src/label.test.ts` (S1) + `server/test/label-handlers.test.ts` (S3) |
| Private-team leak (permissions §5) | `server/test/label-leak.int.test.ts` (S3, S5, S6; **not held**), covering bootstrap, catch-up, live deltas, `status.list` and `label.list`, refs by name, uuid and `Group/Label`, counts, and the `moveToWorkspace` delta pair |

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Label archive needs archive state on the wire (PLAN-011 S2). Without it, an archived label would vanish from clients. | Archive ops are a separate slice (S6) that starts after PLAN-011 S2. S3 ships no archive operation, and `label.list` is already correct for `includeArchived`. |
| A 10,000-issue `label.delete` holds the global sync lock and sends 10,000 deltas. | Chunked `updateWhere` and `sync_log` flush from PLAN-011 S1, used through PLAN-011 S4's cascade helper; chunk sizes are unit-tested there; read the lock duration by hand (AC-21 held); the dialog shows a pending state. |
| Delete and issue-edit race on a status or label (E16). | Single lock order and `FOR KEY SHARE` on newly set refs before the issue lock (PLAN-011 S4's code), pinned by S5's race test and the AC-19 run. |
| Fractional keys collide or diverge between client and server (collation, concurrent inserts). | One shared `fractionalKeyBetween`, `COLLATE "C"`, a property test, and the server re-reads neighbours under the team lock. Two tabs inserting between the same neighbours give equal keys only if the server rejects the duplicate: the handler recomputes from the live neighbours, and the client's key is only a prediction. |
| `Mod+Backspace` deletes text in an edit field instead of the row, or one key runs two handlers. | Local handlers ignore text-field targets (S2, S3). One owner at a time: PLAN-012 S1 deletes the local handlers in the PR that registers the engine bindings, and tests that one press runs one action. |
| Label usage computed from the replica (Issues, Used in, Last applied) is wrong if issues are not all in the replica. | `labelUsage` is a pure function over whatever the store holds; S5 checks SPEC-011 §5 for which issues are eager and records the answer in "As built". If some are lazy, the columns say "—" for them. |
| The status-delete refusal for auto-close (SPEC-015 §4.9) needs a column that PLAN-015 S1 adds. | `statusDeleteProblem` takes the auto-close id from S1 and is tested; PLAN-015 S1 passes it from the team row and adds the handler test. Until then AC-5's auto-close clause is tested only in the pure function. |
| Hard deletes cannot be undone. | Confirm dialogs, an empty-status rule, and no cascade except the label rewrite. |
