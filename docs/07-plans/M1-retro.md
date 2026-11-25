# M1 retrospective: draft for the retro

Status: **Draft**, not the retro's conclusions · Drafted 2026-11-25 by an agent for the coordinator, to hold the retro with the user · Milestone: **M1 Core issues** ([README §7](README.md#7-m1-core-issues))

How to read this:

- Facts come from the M1 coordination log ([m1-coordination.md](sessions/m1-coordination.md), cited as "log, date, slice"), the [coordinator handoff](sessions/coordinator-handoff.md), the plans' "As built" notes, and `git log` (`db2a0d1` to `c2bde2a` on `main`).
- Where something is **the coordinator's reading** (an inference, not a recorded decision), it says so. Nothing here is the user's opinion or decision unless the log records it as theirs.
- Nothing in the PRD, METHODOLOGY or any other doc was changed. Section 5 only lists proposals.

## 1. What M1 delivered against the exit criteria

M1's exit is "start dogfooding" ([README §7.6](README.md#76-m1-exit-checklist), METHODOLOGY M1). Status of each checklist line, as of 2026-11-25:

| Exit item | State | Evidence |
| --- | --- | --- |
| Acceptance gate merged | Done 2026-11-12 | `db2a0d1`; ADR-0021 to 0024 written, ADR-0020 accepted, SPEC-010 to 015 Accepted |
| All ACs have passing tests, except held | Ticked 2026-11-24 | Every AC row in PLAN-010 to 015 names an existing test or is marked ⏸; one stated exception: SPEC-011 AC-14's skewed worst case is a known limit by the user's decision (SPEC-011 D19, `092dbf0`) |
| Sync property suite green with issues, content, archive, restore | Ticked, with a caveat | 1,000 cases passed for the fake hub, `content.prop`, `partial.prop` and the real-server issue properties on `79792e6`. The other real-server sims ran at 20 cases only (log, 2026-11-25, `sim:deep extended`) |
| Leak suite covers every new model and read op | Ticked 2026-11-24 | `lifecycle-leak`, `comment-leak`, `attachment-leak`, `content-leak`, `history-leak` (`b32864f`) and others; open checklist items: cross-issue mention chip (M4), `search_operations` (M6) |
| Dogfood demo by hand | **Open** | [M1-demo-script.md](M1-demo-script.md) exists (`3fa9a7e`); the user has not run it, so the Q16 browser-key matrix and the by-hand ACs are unchecked |
| Surface's own backlog moved into Surface | **Open** | Needs the user |
| Release `v0.2.0` | **Open** | Not prepared; publishing is the user's call |
| Retro held, PRD and METHODOLOGY updated | **Open** | This draft |

What was built: all slices of PLAN-010 (statuses, labels, estimates), PLAN-011 (issues, partial issue loading, content models, cache), PLAN-012 (issue page, list, composer, drafts, pickers, sign-out), PLAN-013 (editor, comments, reactions), PLAN-014 (files, attachments, previews) and PLAN-015 (delete, restore, archive, purge, auto-archive and auto-close). The build is raised to M1 (`3fa9a7e`).

Open or known-limited items at the end of M1 (handoff §4):

- User decisions still open: SPEC-011 D15 to D18 and provisional activity wording, SPEC-012 D21 (waits for the Q16 browser check), SPEC-014 D31 and D33, SPEC-015 "Permanently delete…" wording, reaction skin tones, an app-wide timeout.
- Known limits: the 35 MB replica budget is exceeded on a skewed team split (52.2 MiB with 3 member teams and 55.9 MiB with 5, on a Zipf(1) split; `it.fails` cases in `issue-size.test.ts`; log, 2026-11-24, PLAN-011 S8).
- Open sim items: after a server restart the server logs "could not check the sync socket's session: timeout exceeded" (reactions sim, case 332, seed 20261107), undiagnosed; the drafts sim did not finish 1,000 cases in 90 minutes; workflow and the core real-server sims have not run at 1,000.
- `#applyAnswer` has no generation check (PLAN-014 S4a As built). The new-issue composer cannot upload inline images. Two As built notes are stale (PLAN-013 S4 and S5).

## 2. Numbers

How I counted: slices from the log's `merged` rows with a PLAN-0NN slice name (42 rows) cross-checked with the "✅ Done" lines in PLAN-010 to 015; commits from `git log db2a0d1^..main`, grouped by Conventional Commit type; review findings by reading each merge row's "Review" text. Counts of "major" and "should-fix" mix two vocabularies and some rows say "minor" without a number, so I only give exact counts for blockers.

| Measure | Value | Source and caveat |
| --- | --- | --- |
| Estimate | ~138 ideal days, 40 slices, ~15 weeks for two engineers, critical path ~44 days | README §7.2, §7.4 |
| Calendar time | 2026-11-12 (gate) to 2026-11-24 (last slice merged): 13 calendar days, with merges on 5 of them (11-12, 11-13, 11-14, 11-16, 11-24); follow-ups to 2026-11-25 | Log and `git log` dates. No commits 11-17 to 11-23 |
| Slices merged | 42 (plan said 40) | The plan grew by 2: PLAN-012 S4 split into S4 and S4b, and S7 into S7a and S7b (log, 2026-11-13 and 2026-11-16) |
| Model on the merge row | 27 Opus, 15 Sonnet | Log "Model" column on merged rows; the 2026-11-13 PLAN-012 S5 and 013 S4 moves from Sonnet to Opus are counted as Opus |
| Commits since the gate | 166: 71 docs, 44 fix, 41 feat, 5 test, 4 chore, 1 refactor | Of the 44 fixes, 36 have "review" in the subject; 8 do not (3 of those are PLAN-012 S4b re-review rounds, 2 are the SPEC-014 D30 orphan fix, 1 is the sim quiesce fix) |
| Reverts | 0 commits with "Revert" | `git log --grep='^Revert'`. One in-slice revert: PLAN-014 S4b's new `jobs.int` cases broke the testing hold and were removed in review |
| Reworked or re-scoped slices | At least 5 | PLAN-012 S4 and S7 split; PLAN-011 S5a and S4b pre-started on an unmerged commit and stopped (log, 2026-11-13 pause), S5a resumed with `rebase --onto`; PLAN-012 S4b needed three review rounds (`2a510a2`, `3d741a7`, `1279f19`); PLAN-014 S4a needed an extra fix commit for a harness false alarm (`460dd19`) |
| Slices where review found at least one blocker | 9 of 42 | 014 S1, 014 S2, 011 S1, 013 S1, 010 S3, 011 S5b, 012 S7a, 012 S4b, 014 S4a. Blocker count 11 (012 S4b had one in each of 3 rounds). Two more blockers in the test-speed change (not a slice) |
| Majors and should-fixes found by review | About 75 to 80 | My hand tally of the merge rows; treat as approximate |
| Bugs found by the sync property or sim suites after a slice merged | 1 product bug | SPEC-014 D30 orphan: a PLAN-014 S4a bug found by PLAN-011 S8's 1,000-case `partial.prop` run (seed 20261106, case 389); fixed in `eba404a` and `13df6d5` |
| Harness bugs found by the sim suites | 3 | `live.prop` quiesce during a re-bootstrap (test-speed row), D14 refusal in a restart race (`460dd19`), `World.quiesce` settling too early (`5e30ca2`; this was the reactions case-197 failure) |
| Found by review but not caught by the author's tests | Most blockers | Each blocker row says "fixed with failing tests first" or "mutation-checked" in the fix, which means the author's suite did not cover it |
| Bugs found after merge by a person, by hand | 0 recorded | The by-hand demo has not run, so this number is not yet meaningful. One fix with no review or sim origin in the log: `0124ed5` (TipTap destroyed instance in editor effects), cause described in the commit body only |
| Unresolved sim issues | 1 undiagnosed, 1 unfinished | Case 332 session-check timeout; drafts at 1,000 |
| Test speed before and after (2026-11-24, `6bdd6d6`, `d4df49a`) | No-op `pnpm check` 9.6 s to 0.3 s; cold 138 s to 60 s; one package 7 to 32 s to 1.5 to 8 s; `test:int` 356 s to 157 to 208 s; new `test:deep` 58 s | Log, 2026-11-24, test-speed row, as measured by the agent. I did not re-measure |
| Machine load | Load 34 (`warm-start.perf`), 23 (`overlay.perf`, full `test:int`), about 20 (`executor-overhead`, full `test:int`), 15 (agent's `test:int` with 6 failures) | Log rows 2026-11-12 to 2026-11-16. Each perf timeout passed when rerun alone |

Caveat on the calendar comparison (the coordinator's reading): the estimate is in ideal engineer-days and the actual is wall-clock days of agent work. The log does not record the user's hours, agent compute time or token cost, so "13 days against about 15 weeks" is a calendar fact, not a productivity ratio.

## 3. What went well and what didn't

### Went well

1. **Review caught serious problems before merge.** Examples: a crafted JPEG could split the stripper's output into millions of pieces (014 S2, `b3d534d`); an ENG member could edit a public DES label (010 S3, `9234b8d`); offline logout left the HttpOnly cookie signing the old user back in (012 S7a, `c387613`); a lost update from a saver on an overlay-predicted version (012 S4b, `b1fc434`). Every merge row records a review and its fixes.
2. **The leak and sync suites found a real cross-slice bug.** The D30 orphan came from the 1,000-case `partial.prop` run (log, 2026-11-24, `eba404a`). No private-team leak is recorded in M1; review found leak-adjacent defects (e.g. 011 S4b's partial bootstrap cutting `user:<self>`, `59f5e7a`) before merge.
3. **Handoffs between slices worked.** Rows end with a bold "For S5 / PLAN-011 S4" list, and later reviews cite them (e.g. 010 S3's INV-06 handoff reappears in 011 S4's review, 2026-11-13). The coordinator's docs catch-up (`5ec1a62`, 23 files) routed every "Docs to route" item.
4. **The user's gating cut scope drift.** Pausing on 2026-11-12 and 2026-11-13 left the four in-flight slices finishing cleanly; the 2026-11-13 pre-started S4b was stopped with no work lost, and S5a's WIP was resumed.
5. **The test-speed change worked on its own terms.** `pnpm check` went from 9.6 s no-op to 0.3 s and `test:deep` took over the full counts (`6bdd6d6`). Its review found 2 blockers (a toast leaking across shared files; spec and plan tables contradicting the code) before merge.
6. **Decisions were separated from the user's.** The log keeps "coordinator decision" and "open for the user" apart (e.g. SPEC-011 D11, D13, D14, D19; SPEC-014 D28, D31, D33), and the handoff lists the open ones.

### Didn't go well

1. **The machine was overloaded by four tracks.** Load past 20 made perf tests time out (log, 2026-11-12, 2026-11-13, 2026-11-16); an agent's full `test:int` had 6 failures at load 15; three orphaned vitest workers burned about 4 h of CPU after a worktree was removed (log, 2026-11-16, PLAN-011 S6). The user cut full test runs on 2026-11-13.
2. **Shared-file collisions cost rework.** Three tracks added migration 0014 (log, 2026-11-13: "whoever merges second regenerates"), and sim steps, lifecycle rule rows and the issue page were touched by several slices at once. The coordinator wrote "keep both sides" on many starts.
3. **Review loops can run long.** PLAN-012 S4b took five commits and three review rounds, each finding a new blocker (log, 2026-11-16). Of 42 slices, 9 had blockers; the other 33 had none, so review depth was the same for slices that needed it and slices that did not (the coordinator's reading).
4. **The long 1,000-case runs are fragile.** The extended `sim:deep` was interrupted by sleep and a flat battery overnight, then stopped by the user (log, 2026-11-25). One of its two failures was a harness bug (`5e30ca2`); the other is undiagnosed. The exit checklist's "sync property suite green" is ticked while most real-server sims have only run at 20 cases.
5. **Work stopped whenever it waited for a go.** Four track-idle rows on 2026-11-13 and a coordinator idle row on 2026-11-12 ("waiting for the user's go-ahead"); no merges 11-17 to 11-23 and the next slices were approved on 11-24. This was the user's rule, so it is a cost of that rule, not an error.
6. **The testing hold and the real risk sat close together.** The hold kept `jobs.int` additions out (014 S4b), yet most of M1's real bugs were server and sync concurrency bugs found by int-level suites that the hold exempts (leak, sync property, conformance). Catch-up, resync and auth are still unit-only (README §6 "Known risk").
7. **Some spec questions stayed open for the whole milestone.** SPEC-011 D15 to D18, SPEC-012 D21, SPEC-014 D31 and D33 and others are "open for the user, not blocking" and were still open at the handoff.
8. **Plan fidelity slipped in places.** PLAN-012 S5 and PLAN-012 S4 took scope cuts and `TODO(...)` seams (log, 2026-11-13); two As built notes went stale (PLAN-013 S4 and S5); the AC-14 size budget was found infeasible on a skewed split only at the last slice (011 S8, log 2026-11-24).
9. **Process documents diverged from practice.** See section 5; for example METHODOLOGY Phase 7 says "PR, CI, review, merge" and the log shows an agent branch, a `slice-reviewer` agent and a coordinator fast-forward, with no PR.

## 4. Process questions for the user to decide

Each has evidence and options. The options are listed so the retro can choose; none is a decision.

### Q1. How many parallel tracks for M2, and how to limit machine load?

Evidence: M1 ran 4 tracks (log, 2026-11-12). Load reached 34; perf tests timed out and passed alone; orphaned workers ran 4 h; the handoff says four tracks "pushed the machine hard". Overlap cost: migration 0014 collided three times (2026-11-13). Idle tracks: four on 2026-11-13 because dependencies blocked them.
Options: (a) 4 tracks again with the new fast gate (full `test:int` is now about 3 min); (b) 2 or 3 tracks; (c) 4 tracks but only 2 may run `test:int` at once; (d) number of tracks set per milestone by how many independent slices exist.

### Q2. Does the testing hold (README §6) still apply in M2?

Evidence: in force since 2026-11-06; exceptions for leak tests, the sync property suite, filter conformance and the byte-lock test. Review sent back new `jobs.int` cases (014 S4b). 55 lines in PLAN-010 to 015 carry ⏸. The by-hand demo is the only check for held ACs. README §6 names catch-up, resync and auth as covered only by unit tests. Test speed is no longer the reason the hold started (gate 0.3 s cached, `test:int` about 3 min).
Options: (a) keep the hold unchanged; (b) lift it for integration tests only, keep e2e held; (c) lift it for the known-risk areas first (catch-up, resync, auth) and keep the rest held; (d) lift it fully and add the ⏸ rows as a slice.

### Q3. What is the `sim:deep` practice?

Evidence: the 1,000-case run took hours: the real-server file alone took 49.6 min; issues-convergence 20, lifecycle 28, attachments 13, comments 10 min. A closed lid and a flat battery lost a night (handoff §3). Of three failures at 1,000 cases, two were harness bugs and one is undiagnosed. CI runs `test:deep` (not `sim:deep`) on pushes to `main`.
Options: (a) per milestone, before the exit checklist, on a plugged-in machine; (b) nightly or weekly on CI or another machine; (c) only for the sync files a milestone changed; (d) lower the case count and rely on seeds.

### Q4. How quickly should spec questions and go-aheads be answered, and by whom?

Evidence: the user answered the gate's questions on 2026-11-12 (recorded same day) and gave "go" on 2026-11-12, 13, 16 and 24; no slices were started 11-17 to 11-23. 4 track-idle rows were logged while waiting on dependencies, and several spec decisions (D15 to D18 and others) were left "open for the user" rather than blocking. CLAUDE.md says the coordinator never starts a slice without the user's go.
Options: (a) keep "no slice without a go" and batch go-aheads per milestone phase; (b) pre-approve a queue (the log shows this on 2026-11-16 and 2026-11-24); (c) let the coordinator start any ready slice on the approved plan and stop only for spec questions; (d) set a review-day for pending decisions.

### Q5. What should the review loop cost?

Evidence: 42 of 42 slices were reviewed; 9 had blockers (11 in total); PLAN-012 S4b needed three rounds; the review also found 2 blockers in the test-speed change. About 36 of 44 fix commits are review fixes. Reviewers read and do not run suites (m1-coordination §3).
Options: (a) the same review for every slice; (b) full Opus review for server, sync, security and migrations, a lighter or Sonnet pass for UI and test-only slices (the handoff already does this for small slices); (c) cap rounds (for example 2) and send the rest to a follow-up slice; (d) review once per track batch.

### Q6. Do the plan's estimates and slice count stay in "ideal days"?

Evidence: README §7.2 estimates 138 ideal days and about 15 weeks for two engineers; actual wall-clock was 13 days and the unit is not comparable. The slice count grew from 40 to 42, and PLAN-011 S4b and S4c (added by ADR-0020) were already extra.
Options: (a) keep ideal days as a sizing aid only and drop calendar estimates for agent-built work; (b) record agent wall-clock and review rounds per slice and estimate from that; (c) estimate in slices and risk class (S, M, L) only.

### Q7. Does the coordinator's authority carry to M2, and does METHODOLOGY's PR step apply?

Evidence: the user gave the coordinator authority to commit and fast-forward `main` for M1 (log header); the handoff says "confirm that it carries over to M2". METHODOLOGY Phase 7 lists PR, CI and merge, and M1 used none.
Options: (a) the same authority for M2; (b) authority only after review and a green gate on an explicit list of checks; (c) merge through PRs again once CI runs `test:deep` on every PR.

### Q8. When does the by-hand demo run, and what counts as "dogfooding"?

Evidence: the demo script exists (`3fa9a7e`) and takes about 85 minutes to seed; it is the only check for held ACs and the Q16 browser key matrix; the backlog move and `v0.2.0` also need the user. M2 specs are not written yet.
Options: (a) run the demo before M2 specs start; (b) run it in parallel with M2 spec drafting; (c) split it into smaller demos per feature area.

## 5. Candidate updates to the PRD tiers and METHODOLOGY

All of these are proposals for the retro to accept, change or drop. None has been applied.

### PRD (tiers, priorities and budgets)

1. **Re-tier "full undo/redo" language.** FR-NAV-06 is v1 Must for M2; M1 shipped only `Cmd+Z` for the last delete (PRD §4). Candidate: no tier change, but note M1's partial in the FR row.
2. **Size-based on-demand team limit.** SPEC-011 D19 and the handoff list "replace 5 largest on-demand teams with a size-based limit" as a follow-up. Candidate: add it to the PRD risk row R2 (replica size) or tier it v1 Should.
3. **Replica budget.** R2 says "measure eager size and memory from M1"; M1 measured 29.7 MiB (even split) and 52.2 to 55.9 MiB (Zipf split) against the 35 MB budget. Candidate: restate the NFR-03/10 budget with the measured split assumption, or keep it as a known limit.
4. **Alpha gate wording.** The release table says "J1 and J2 work. Sync is stable for a week of daily use." Candidate: tie "stable" to a named sim run (for example the extended `sim:deep` at 1,000 cases passing) so it can be checked.
5. **Open v1 items from M1.** An app-wide request and idle timeout, reaction skin tones, and inline uploads in the new-issue composer are not in the PRD as rows. Candidate: tier each (v1 Should, v1 Could or Later).
6. **Linear parity rule.** "Copy Linear" is a standing rule in memory and decisions but not in the PRD. Candidate: add one line to PRD §1.1 or VISION.

### METHODOLOGY

1. **Phase 7 build loop.** Replace "PR, CI, review, merge" with what M1 did (agent branch, `slice-reviewer`, coordinator fast-forward, log row), or restore the PR step; depends on Q7.
2. **Phase 8 gates.** E2E, performance and accessibility gates were held for all of M1. Candidate: record the hold as part of the gate table, and name where each gate runs (`pnpm check`, `test:int`, `test:deep`, `sim:deep`, by-hand demo). Depends on Q2 and Q3.
3. **§5 working rhythm and Definition of Done.** DoD already says "held criteria excepted"; candidate: add "properties scaled in the gate (SPEC-004 D12), full counts in `test:deep`", and the review rule "blockers fixed, failing test first, mutation-checked".
4. **Cadence.** "Each milestone takes roughly 1 to 3 cycles of 2 weeks"; M1 took 13 calendar days. Candidate: restate the cadence for agent-built milestones, or drop it. Depends on Q6.
5. **Parallel work.** METHODOLOGY says little about parallel tracks; M1's rules live in `m1-coordination.md`. Candidate: promote the reusable parts (tracks, append-only registry files, one migration slice merged at a time, "keep both sides", scratch-file prefixes, load limits) to a short METHODOLOGY section or a template for `m2-coordination.md`. Depends on Q1.
6. **Slice sizing and splitting.** Two M1 slices split mid-build (PLAN-012 S4 and S7). Candidate: add a rule that a slice with more than one risky area (migration plus UI plus sync) is split at planning time.
7. **Acceptance gate.** The gate for M1 produced ADR-0021 to 0024 and settled questions in one docs PR; candidate: keep as the template for M2 (specs Accepted, ADRs, plans, graph, coordination file; handoff §2).
8. **Retro and release step.** Phase 9 says "run a retro, then update the PRD tiers"; candidate: add a sentence that the retro uses the coordination log as its source, and that it comes after the by-hand demo.
9. **Decision records.** Add the log's convention ("the coordinator decided on <date>; still open for the user") to the process, so a decision is never recorded as the user's by mistake.
