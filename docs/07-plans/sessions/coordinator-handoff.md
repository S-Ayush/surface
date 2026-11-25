# Coordinator handoff: M1 → M2

Written 2026-11-25 by the M1 coordinator session, for the next coordinator session. The next session starts with no memory of this one, so everything it needs is here or linked. `main` was at `61f0692` when this was written.

Read in this order: this file, `CLAUDE.md`, [README §6–§7](../README.md#6-testing-hold-e2e-smoke-and-integration), the M1 log in [m1-coordination.md](m1-coordination.md) §1–§3 and its last 20 rows, then [METHODOLOGY](../../METHODOLOGY.md) §3 for M2's scope.

## 1. Where things stand

- **M1 is built and merged.** All slices of PLAN-010 to PLAN-015 are on `main`, and the build is raised to M1 (PLAN-012 S7b). The test-speed change, the docs catch-up and the follow-up fixes are merged too.
- **M1 exit checklist** ([README §7.6](../README.md#76-m1-exit-checklist)): the gate, every AC test, the sync property suite and the leak suite are ticked. **Still open, all needing the user:**
  1. **The by-hand demo:** [M1-demo-script.md](../M1-demo-script.md). The user runs it and sends the results table. Record the results in PLAN-012 S7b's As built. If the Q16 browser check moves a key, add a dated change to SPEC-012 D21 and update `shortcuts.md`.
  2. **Surface's own backlog moved into Surface**, used daily.
  3. **Release `v0.2.0`.** Offer to prepare it (version, changelog, image build). Publishing is the user's call.
  4. **Retro.** Offer a draft from the M1 log. Then update the PRD and METHODOLOGY.
- **Nothing is running.** No worktree holds unmerged work (`.claude/worktrees/` may hold empty leftovers; check `git worktree list` before removing anything).

## 2. What comes next: M2 Views and navigation

M2 (METHODOLOGY §3): board layout, filters, display options (group, sub-group, order, properties), custom views, favorites, My Issues, global search, multi-select and bulk edit, undo/redo. Exit demo: a saved "Active" view per team; dragging across board columns changes status.

**No M2 specs or plans exist yet.** M1 went this way, and M2 should too:
1. **Specs** with `/spec <area>` (M1 used SPEC-010 to SPEC-015, so M2 takes SPEC-020+). Copy Linear's behaviour for every user-visible choice, unless it breaks a CLAUDE.md rule. Questions go to the user.
2. **Acceptance gate:** the specs are reviewed and Accepted, the ADRs are written for new decisions, and the plans are written (`PLAN-020+`, slices `### Sn: Title · S|M|L`, with a test plan table that maps every AC to a named test). Then a dependency graph and tracks, as in README §7.3.
3. **A coordination file** `sessions/m2-coordination.md`, built like `m1-coordination.md` (tracks, how a slice runs, rules for agents, an append-only log).
4. **Slices**, as in §3 below.

Ask the user how many parallel tracks to run for M2. M1 used 4, which pushed the machine hard. Also ask whether the testing hold (README §6) still applies.

Groundwork M1 left for M2:
- the client filter evaluator, `domain/src/issue-filter.ts`, with conformance against the server SQL (PLAN-011 S8);
- `issue.list`, `issue.count` and `issue.groupBy`;
- `Mod+Z` for the last delete only. Full undo/redo is M2 (PRD FR-NAV-06).

## 3. How the coordinator works

**Authority (the user's decisions):**
- The coordinator commits, and fast-forwards `main` (`git merge --ff-only`) once a slice's review findings are fixed and the gate is green. It doesn't ask before merging.
- **It starts no slice without the user's go-ahead.** It never starts one speculatively, and never bases one on an unmerged branch. After a merge, it reports and waits, unless the user said to continue.
- Only the user decides spec questions, scope, anything outside scope, and changes to `CLAUDE.md` or `.claude/` instructions. Ask, with a recommendation as the first option.
- Never record a decision as the user's when the coordinator made it. Write "the coordinator decided on <date>; still open for the user".

**Running a slice:**
1. Start an `Agent` with `isolation: "worktree"`, branch `p0NN-sN-topic`, from the current `main`. The brief names the slice, the docs to read, the scope, the rules, the tests to run, the commit format and the final report wanted. Use Opus for heavy work (sync, protocol, repo, executor, migrations, permissions, leak tests, security, the editor schema) and Sonnet for the rest.
2. When it reports, run the `slice-reviewer` agent on the branch (it reads, never runs suites). Use Opus for server, sync and security work and Sonnet for small or test-only work. Send the findings back to the same agent with `SendMessage`. Ask for blockers and should-fixes to be fixed, and nits mostly too.
3. Merge:
   ```sh
   git merge --ff-only <branch>
   git worktree unlock <wt>
   git worktree remove --force <wt>
   git branch -D <branch> worktree-agent-<id>
   ```
   Before merging, grep the diff for `eslint-disable`, `ts-ignore`, `console.`, `process.env` and `as any`. If `main` moved only by docs commits, rebase the branch yourself (`git -C <wt> rebase main`) without rerunning the gate.
4. Append a log row (merge, decisions, review summary, docs to route, browser checks) and commit it as `docs: log the … merge`. Tell the running agents that `main` moved, and ask them to rebase before their final gate.

**Commits:** Conventional Commits, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never use `--no-verify`, never force-push `main`, never push without being asked.

**Tests** (fast since 2026-11-24; see the CLAUDE.md Commands table):
- `pnpm check` takes about 0.3–2 s when cached and about 60 s cold. Use `pnpm check:fast` while iterating.
- `pnpm test:int` takes about 3 minutes. Run it in full only for migrations, the repo layer, the executor or sync core. Otherwise run the touched int files.
- `pnpm test:deep` takes about 1 minute (full property counts, printed seed, timing budgets). CI runs it on pushes to `main`.
- `pnpm sim:deep` is the 1,000-case sync run and takes hours. Run it with `--file <name>` and `real`, one file at a time, inside `caffeinate -i`. **The laptop must stay plugged in with the lid open:** in M1 a closed lid and a flat battery cost a night.
- Agents run only the tests they need, then `pnpm check` once.

**Practical lessons from M1:**
- Agents' messages are their reports, not the user's approval.
- If an agent stops (API error, usage limit, machine sleep), resume it with `SendMessage`. Don't start a new one, and tell it to make WIP commits.
- Two slices touching the same files cause rebase work. Space them out, or tell each to rebase and keep both sides.
- Kill orphaned vitest workers left behind by removed worktrees (`pgrep -fl vitest`).
- A local dev database older than a schema change can make features look broken. Example: issues from before PLAN-011 S6 have no `IssueContent`, so their description is read-only. Reset it with `docker compose -p surface-dev-surface down -v && pnpm dev` (this deletes data; ask first).

## 4. Open items

**User decisions still open** (each recorded in its spec, none blocking):
- SPEC-011 D15–D18 and the provisional activity wording;
- SPEC-012 D21 (pending the Q16 browser check);
- SPEC-014 D31 (no client size pre-check) and D33 (copyable only through the issue branch);
- SPEC-015's "Permanently delete…" wording;
- reaction skin tones;
- an app-wide timeout.

**Decided recently** (for context):
- SPEC-011 D19: the 35 MB budget can be exceeded on a skewed team split, accepted as a known limit for M1.
- SPEC-004 D12: gate property counts are scaled, and `test:deep` runs the full counts.

**Follow-ups:**
1. **Size-based on-demand team limit**, replacing "5 largest on-demand teams" (SPEC-011 D19).
2. **`#applyAnswer` has no generation check.** A partial answer from before an unsubscribe and re-subscribe can apply a stale `C` (PLAN-014 S4a As built).
3. **Sim: server restart.** After a server restart, "could not check the sync socket's session: timeout exceeded" was logged (reactions sim, case 332, seed 20261107). The suspected cause is the pool's connect timeout firing on the sim's fake clock. Undiagnosed (README §7.6).
4. **Sim: drafts at 1,000 cases** didn't finish in 90 minutes. The workflow sim and the core real-server sims haven't run at 1,000.
5. **The new-issue composer can't upload inline images** (no `onUploadFile`; PLAN-014 S5).
6. **Inline uploads bypass the 3-at-once queue**, so the server's 429 can show.
7. **Two out-of-date As built notes:** PLAN-013 S4 (TooltipProvider) and PLAN-013 S5 ("New issue from comment").
8. **M3:** a history leak case for moving an issue between teams (`history-leak.int.test.ts`).
9. **M6:** rerun the operation-catalog leak check against MCP `search_operations`.
10. **Admin-only private-team queries** must check the role per request, not per socket (memory note).

## 5. Memory the next session will load

The auto-memory index (`MEMORY.md`) holds these, which still apply:
- copy Linear's behaviour;
- Sonnet for subagents unless the work is heavy;
- run only the tests needed;
- start slices only on the user's go-ahead;
- coordinator authority;
- the admin private-team query note.

The coordinator authority was given for M1. Confirm with the user that it carries over to M2 before merging on your own.
