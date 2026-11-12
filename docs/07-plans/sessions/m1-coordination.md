# M1 parallel sessions: coordination

Status: **Active** · Created: 2026-11-12 · Milestone: **M1 Core issues** · Plans: [README §7](../README.md#7-m1-core-issues)

M1 runs as agents started and driven by one **coordinator** session (the main checkout). The user decided on 2026-11-12:
- **4 parallel tracks.**
- **The coordinator commits and fast-forwards `main`** once a slice's independent review findings are fixed and `pnpm check` is green (plus `pnpm test:int` when database code changed). Spec decisions that only the user can make still go to the user.
- **Models:** Opus for heavy work (sync, protocol, repo, executor, migrations with locking, permissions and leak tests, upload and byte security, the editor schema); Sonnet for the rest (UI components and screens, settings that follow existing patterns, docs).

M0's session files in this folder are the record of M0. Their logs are closed.

## 1. Tracks and queue

Each track runs one slice at a time. When a track finishes, it takes the next slice in its queue whose dependencies are on `main` ([README §7.3](../README.md#73-dependency-graph-and-tracks)). If none is ready, it takes a ready slice from another queue, critical path first.

| Track | Theme | Queue (model) |
|---|---|---|
| **A** | Issues and sync: the critical path | 010·S1 (O) → 011·S1 (O) → 011·S2 (O) → 011·S3 (O) → 011·S4 (O) → 011·S5a (O) → 011·S5b (O) → 011·S6 (O) → 011·S7 (O) → 011·S8 (O) |
| **B** | Editor and comments | 013·S1 (O) → 013·S2 (S) → 013·S3 (O) → 013·S4 (S) → 013·S5 (S) |
| **C** | Web UI | 012·S1 (S) → 012·S2 (S) → 012·S3 (S) → 012·S4 (S) → 012·S5 (S) → 012·S6 (S) → 012·S7 (S) |
| **D** | Files, settings, lifecycle | 014·S1 (O) → 014·S2 (O) → 014·S3 (O) → 010·S2 (S) → 010·S3 (S) → 010·S4 (S) → 010·S6 (S) → 010·S5 (O) → 015·S1 (O) → 015·S2 (O) → 015·S3 (S) → 015·S4 (S) → 015·S5 (O) |
| **any** | Pulled by the first free track | 011·S4b (O) → 011·S4c (O) · 014·S4a (O) → 014·S4b (O) → 014·S5 (S) |

O = Opus, S = Sonnet. The coordinator may move a slice to another track or model, and logs the move.

## 2. How a slice runs

1. The coordinator starts an agent in its own git worktree, based on the current `main`, on the branch `p0NN-sN-topic`.
2. The agent follows `.claude/skills/slice/SKILL.md`: it builds the slice, writes the tests, runs `pnpm check` (and `pnpm test:int` for database code), writes the plan's "✅ Done" and "As built", and commits on its branch. It never touches `main`.
3. The coordinator runs the **slice-reviewer** agent on the branch. The implementing agent fixes the findings.
4. The agent rebases on `main`, runs `pnpm install` and `pnpm check` again, and reports. The coordinator fast-forwards `main` (`git merge --ff-only`) and logs the merge below.

## 3. Rules for every agent

- **Stay in your worktree and on your branch.** Edit only what the slice needs. Don't widen scope; note follow-ups in "As built".
- **Shared registry files are append-only** (add your own lines; on a rebase conflict keep both sides): `apps/server/src/handlers/index.ts`, `packages/operations/src/ops/index.ts`, `packages/domain/src/model/index.ts`, `packages/domain/src/index.ts`, `apps/server/src/sync/models.ts`, `apps/server/src/db/schema/index.ts`, `apps/web/src/features/{commands,screens,hosts}.ts`.
- **Migrations:** generate them as usual. If `main` gained a migration after you branched, delete yours on rebase and generate it again on top. The coordinator merges one migration slice at a time.
- **Lockfile:** add dependencies with `pnpm --filter <pkg> add`. On a rebase conflict, take `main`'s lockfile, run `pnpm install` and stage the result.
- **Shared docs:** edit the plan sections and the spec of your own slice only. A change any other doc needs goes in your report, and the coordinator routes it.
- **Ports** (dev servers only; tests use port 0): A 3100/5173, B 3200/5176, C 5174 and Storybook 6006, D 3400/5177.
- **Testing hold** ([README §6](../README.md#6-testing-hold-e2e-smoke-and-integration)) applies: no new e2e, perf, smoke or integration tests, except leak tests, the sync property suite and the two granted exceptions.
- **Questions only the user can answer:** stop and report them. Don't guess.
- **Node in agent sandboxes:** if `source ~/.nvm/nvm.sh` is refused, put `~/.nvm/versions/node/v24.22.2/bin` first on `PATH`. `drizzle-kit generate` needs `pnpm build` first so it can resolve `@surface/domain`.
- **Scratch files:** the scratchpad directory is shared by all tracks. Prefix every scratch file with your track and slice (e.g. `trackD-p014s1-check.log`).
- **Load:** four tracks running `pnpm test:int` at once push the machine load past 20. A perf test that times out under that load is rerun alone before it counts as a failure; say so in the report.

## 4. Log (append-only)

| Date | Track | Slice | Branch | Model | State | Notes |
|---|---|---|---|---|---|---|
| 2026-11-12 | coord | Acceptance gate | m1-gate | O ×3, S ×1 | started | Split by target doc: architecture + ADRs + SPEC-002/003/004 (O); domain docs + SPEC-001 (O); product + design + SPEC-005 (S); audit of SPEC-010–015 and PLAN-010–015 (O). |
| 2026-11-12 | coord | Acceptance gate | main | — | merged | `db2a0d1`. ADR-0021–0024 written, ADR-0020 accepted, INV-23–26, specs Accepted, plans Ready. Rebased onto `bda997a` (another session's partial-issue-sync review fixes, already contained in the gate; tree identical). New dependency from that commit: 011·S4c before 015·S1. Not done, for the user: CLAUDE.md rule 2 doesn't mention the ADR-0022/0023 exceptions. |
| 2026-11-12 | A | PLAN-010 S1 | p010-s1-domain | O | started | migration |
| 2026-11-12 | B | PLAN-013 S1 | p013-s1-editor-schema | O | started | |
| 2026-11-12 | C | PLAN-012 S1 | p012-s1-shortcuts | S | started | |
| 2026-11-12 | C | PLAN-012 S1 | main | S | merged | `dc39e53`. Review: 0 blockers, 1 major (an unfalsifiable property test), 5 minor, 2 nits; all fixed, mutation-checked. `BUILD_MILESTONE` stays M0 until S7 raises it. For PLAN-010 S2/S3: settings-row keys go through the engine (`settings-row` scope) with `settings-row-keys.test.tsx`; for S4: the Esc step via `useCommand('ui:escape', …, { level: 'page', when })`; for S6: fill `PROPERTY_COMMANDS` (section and refs required). |
| 2026-11-12 | C | PLAN-012 S2 | p012-s2-ui | S | started | |
| 2026-11-12 | A | PLAN-010 S1 | main | O | merged | `bb0128d`. Review: 0 blockers, 0 majors, 3 minor (fractional-key reserved-integer edge, boundary coverage), 2 nits; fixed. Migration `0010_workflow_labels_estimates` with a hand-appended `COLLATE "C"` line (Drizzle can't declare it): anyone regenerating on top keeps it. For PLAN-011 S3: jitter digits `0-9A-Za-z`, never ending in `0`; for S4 `mergeLabels`: use `applyLabelAdd`. |
| 2026-11-12 | A | PLAN-011 S1 | p011-s1-foundations | O | started | |
| 2026-11-12 | D | PLAN-014 S1 | main | O | merged | `5317f66` (the two commits squashed so every commit has its migrations). Review (O): 1 blocker (the upload route accepted the new purposes, so previews could be uploaded and never cleaned up), 1 major (anyone could set another user's avatar as their own; now only your own upload or the current one, like Linear; SPEC-003 §4 updated), 2 minor, nits; all fixed. Migrations regenerated as 0011 and 0012. SPEC-014 D25, D26. For S2: headers are set before the "row without bytes" 404. For S4a: pass `visibleGroups` as `reader.groups`. |
| 2026-11-12 | D | PLAN-014 S2 | p014-s2-upload | O | started | |
| 2026-11-12 | coord | User decisions | main | — | recorded | The user approved the CLAUDE.md rule 2 pointer to ADR-0022/0023 (added). Kept as is: "issue subscription" vs "team subscription" wording; the limits the gate recorded as decided (SPEC-010 D16/D22, SPEC-011 Q8/Q9/Q16, SPEC-013 D14/D15, SPEC-014 D20/D23, SPEC-015 D18); attachment removal with an Undo toast and no dialog. Coordinator calls: SPEC-013 D26 (own Markdown over markdown-it) accepted after review, on its conditions; SPEC-012 D22 (treegrid) accepted. |
| 2026-11-12 | D | PLAN-014 S1 | p014-s1-files-schema | O | started | migration |
| 2026-11-12 | coord | Shared test timeout | main | — | merged | `c90a61b`: the shared unit-test preset's `testTimeout` is 30 s. Property tests timed out at 5 s under parallel load. |
| 2026-11-12 | C | PLAN-012 S2 | main | S | merged | `7c3667c`. Review: 0 blockers, 1 major (slug folding duplicated; `foldToSlug` is now exported and **PLAN-011 S4's `issueSlug` must use it**), 10 minor; fixed. An `eslint-disable` added in the fixes was removed (stable callbacks documented instead). D22 treegrid accepted. Gate run by the coordinator after the rebase: 10/10. For S3: pass stable `itemHeight`/`isHeader`; `T` collapses groups. |
| 2026-11-12 | A | PLAN-011 S1 | main | O | merged | `bceb055`. Review (O): 1 blocker (the unlogged-delete check accepted a group change's `D`; now only rows really removed by purge or a logged `deleteWhere`), 1 major (`deleteWhere` now locks ascending then deletes), 7 minor; fixed with failing tests first. Gate run by the coordinator after the rebase: green. For S5a: replace `Reflect.get(def,'parent')` with a typed field and add the repo-level `log: false` test. Known flake: sync-sim `real-server.int.test.ts` exact-replay test failed once under full `test:int` load and passed 4 times alone (after `852fd2e`); watch it. |
| 2026-11-12 | C | PLAN-010 S2 | p010-s2-statuses | S | started | 012·S3 waits for 011·S4c, so C takes D's 010·S2. |
| 2026-11-12 | A | PLAN-011 S2 | p011-s2-archive-wire | O | started | |
| 2026-11-12 | coord | Scope | — | — | paused | The user: start no new slices until they say so; finish the four in progress (011·S2, 013·S1, 010·S2, 014·S2). |
| 2026-11-12 | D | PLAN-014 S2 | p014-s2-upload | O | review fixing | Review (O): 1 blocker (crafted JPEG/GIF split the stripper's output into millions of pieces: CPU, fs writes, memory), 2 majors (no idle timeout on slow bodies; per-user caps bypassed by parallel uploads), 6 minor. The user left the stripping to the coordinator: wider stripping accepted, including dropping bytes after the image end, the whole APP13 and GPS in the Exif sub-IFD (SPEC-014 D27, which names the losses: MPF images, HDR gain maps, Motion Photo video). |
| 2026-11-12 | B | PLAN-013 S1 | main | O | merged | `d1c2c20`. Review (O): 1 blocker (emphasis repair could freeze the server for minutes on crafted Markdown; now ≤ 8 passes and a linear serializer), 3 majors (markdown-it nesting silently dropped content, NUL and lone surrogates accepted, the AC-8 property partly held by construction), 7 minor; fixed with failing tests first. D26 (own Markdown over markdown-it) accepted by the coordinator on the review's conditions. `normalize`/`docToMarkdown` now throw on invalid docs. For PLAN-011 S6: cap Markdown input length before parsing, then `validateDoc`. For S2: E19 belongs to paste handling. New ESLint `no-restricted-globals` on `packages/editor/src/schema/**`. |
