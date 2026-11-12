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

## 4. Log (append-only)

| Date | Track | Slice | Branch | Model | State | Notes |
|---|---|---|---|---|---|---|
| 2026-11-12 | coord | Acceptance gate | m1-gate | O ×3, S ×1 | started | Split by target doc: architecture + ADRs + SPEC-002/003/004 (O); domain docs + SPEC-001 (O); product + design + SPEC-005 (S); audit of SPEC-010–015 and PLAN-010–015 (O). |
