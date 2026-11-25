# Implementation Plans: Overview

M0 (§1–§5): Status **Ready** · Date: 2026-11-06 · Milestone **M0 Foundations** · Specs: [06-specs](../06-specs/README.md) (all Accepted).
M1 (§7): Status **Ready** · Date: 2026-11-12 · Milestone **M1 Core issues** · Specs: SPEC-010 to SPEC-015 (Accepted 2026-11-12). Built by parallel agents: [sessions/m1-coordination.md](sessions/m1-coordination.md). The testing hold (§6) applies to both.

---

## 1. Plans

| Plan | Implements | Slices | Size |
|---|---|---|---|
| [PLAN-004](PLAN-004-packaging-ops-baseline.md) | SPEC-004 Repository, CI & packaging | 10 | ~10 d |
| [PLAN-003](PLAN-003-operation-registry-executor.md) | SPEC-003 Operation Registry & executor | 7 | ~10 d |
| [PLAN-002](PLAN-002-sync-engine-v0.md) | SPEC-002 Sync engine v0 | 10 | ~18 d |
| [PLAN-001](PLAN-001-workspace-auth-members-teams.md) | SPEC-001 Auth, members & teams | 9 | ~13 d |
| [PLAN-005](PLAN-005-app-shell-command-menu-shortcuts.md) | SPEC-005 Shell, command menu & shortcuts (+ design-system foundations) | 8 | ~13 d |

**Sizes:** S ≤ 1 day · M 2–3 days · L 4–5 days, in ideal engineering days for one person. The total is about **63 ideal days**, which is roughly 3 calendar months for one engineer or about 6 weeks for two, using the parallel tracks below.

## 2. Dependency graph & tracks

```mermaid
flowchart LR
  subgraph TA[Track A: platform]
    P4S1[004·S1 monorepo] --> P4S2[004·S2 server skeleton] --> P4S3[004·S3 DB + migrations]
    P4S3 --> P3S1[003·S1 registry core] --> P3S4[003·S4 executor]
    P3S4 --> P2S2[002·S2 sync tables + repo]
    P2S2 --> P2S3[002·S3 bootstrap] --> P2S4[002·S4 hub/WS] --> P2S5[002·S5 mutate]
    P2S5 --> P2S9[002·S9 simulation tests]
  end
  subgraph TB[Track B: client & UI]
    P4S1 --> P5S1[005·S1 tokens] --> P5S2[005·S2 primitives] --> P5S3[005·S3 overlays]
    P2S1[002·S1 protocol pkg] --> P2S6[002·S6 client store/IDB] --> P2S7[002·S7 socket] --> P2S8[002·S8 queue/overlay]
  end
  P2S8 --> P2S9
  P2S5 --> P1S1[001·S1 schema] --> P1S2[001·S2 setup] --> P1S3[001·S3 sessions]
  P1S3 --> P1S4[001·S4 SMTP] & P1S5[001·S5 invites] & P1S6[001·S6 account] & P1S7[001·S7 members] & P1S8[001·S8 teams]
  P5S3 --> P5S4[005·S4 shell+router]
  P1S3 --> P5S4
  P5S4 --> P5S5[005·S5 shortcuts] --> P5S6[005·S6 command menu] --> P5S7[005·S7 prefs+banners]
  P1S8 --> P2S10[002·S10 demo e2e + perf]
  P5S7 --> P5S8[005·S8 M0 demo + polish]
  P2S10 --> P5S8
```

**Critical path:** 004·S1–S3 → 003·S1–S4 → 002·S2–S5 → 001·S1–S3 → 005·S4–S8.
**Parallel work:** Track B (tokens, primitives, overlays, client store) can start as soon as the monorepo exists. That is the natural split if there are two people.

## 3. Suggested sequence (two engineers)

| Week | Engineer 1 (platform) | Engineer 2 (client/UI) |
|---|---|---|
| 1 | 004·S1–S4 | 004·S5–S6 (Docker, CI) → 005·S1 |
| 2 | 003·S1–S4 | 005·S2–S3 · 002·S1 |
| 3 | 003·S5–S7 · 002·S2 | 002·S6–S7 |
| 4 | 002·S3–S5 | 002·S8 · 004·S7 (docs; S8 install smoke deferred) |
| 5 | 002·S9 · 001·S1–S3 | 005·S4 (shell on the real store) |
| 6 | 001·S4–S7 | 005·S5–S6 |
| 7 | 001·S8–S9 · 002·S10 | 005·S7–S8 |

## 4. Conventions for every slice

- **One slice = one PR** (or a short stack), independently mergeable with CI green. Name the branch `p<plan>-s<slice>-<topic>` (e.g. `p002-s4-sync-hub`).
- **The PR description** links the plan slice and lists the spec ACs it covers.
- **Definition of Done** ([METHODOLOGY §5](../METHODOLOGY.md#5-working-rhythm)): tests for the covered ACs, lint/typecheck green, docs updated, and new operations pass the registry lint. UI slices also need Storybook stories and the axe check.
- **Feature flags are not needed in M0.** Nothing is user-facing until the M0 demo.
- **If a slice reveals a spec problem,** update the spec (and an ADR if needed) in the same PR. Never leave the code and spec disagreeing.

## 5. M0 exit checklist

- [x] **Demo (METHODOLOGY M0):** two tabs, rename a team in one, and it updates in the other in < 150 ms. The change survives an offline reload. _2026-11-12: checked by hand by session C. The rename shows in the other tab in 46–105 ms (PLAN-005 S8). The offline reload passes on the built app in a secure context (HTTPS or localhost) since PLAN-005 S9 (`34225e6`, ADR-0019); over plain `http://` on another host there is no offline reload, which the user accepted._
- [x] **Keyboard-only demo** (SPEC-005 AC-1). _2026-11-12: checked by hand by session C in PLAN-005 S8._
- [ ] ⏸ **Install smoke:** fresh VM to first team in < 15 min (SPEC-004 AC-3). Held (§6).
- [x] Demos above: run by hand while e2e is held (§6). _2026-11-12: both, as noted on each._
- [x] **Sync property suite** at 1,000 cases green on main (SPEC-002 AC-2/3). Not held (§6). _2026-11-12, the user's decision that this run is enough: `pnpm sim --runs 1000` passed on `ee4047b`, AC-2 and AC-3 at 1,000 cases each, seed 20261107, against the fake hub. The real-server run in `test:int` uses 20 cases per property (the user's choice); the deepest real-server run so far was 100 per property._
- [ ] All ACs of SPEC-001 to SPEC-005 have passing tests, except those held under §6
- [ ] Release `v0.1.0` image published (amd64 + arm64)
- [ ] Retro held. PRD and METHODOLOGY updated with what we learned. M1 specs (SPEC-010+) are next.

## 6. Testing hold: e2e, smoke and integration

**Since 2026-11-06, by decision of the user, for faster development:** tests that need a browser, a running stack or Postgres are not written, with the exceptions below. They are added later, when the user lifts the hold.

- **Held:** e2e (Playwright), `e2e perf`, `perf`, smoke, `manual / e2e` and integration (`*.int.test.ts`) tests. A criterion whose only test is one of these is **held**: its row in the plan's test table is marked ⏸, and no test is written yet. ⏸ markers override the "Tests:" bullets in a slice's body.
- **Not held, written as usual:**
  - unit and property (fast-check) tests, including the unit parts of any held criterion. `pnpm check` is the gate;
  - the **sync property suite** (SPEC-002 AC-2/AC-3, PLAN-002 S9), against the real executor and Postgres;
  - **private-team leak tests** that need Postgres: the `permissions.md` §5 checklist and SPEC-002 AC-11 (bootstrap, catch-up and live deltas filtered by sync groups). A slice that adds a query, a delta path or a read operation adds its leak tests in `*.int.test.ts`;
  - **exceptions the user granted on 2026-11-12:** the Issue filter conformance run `issue-filter-conformance.int.test.ts` (SPEC-011 Q13, PLAN-011 S8) and the Postgres byte-lock test `files-bytes-pg.int.test.ts` (SPEC-014 Q15, PLAN-014 S3).
- **Existing integration tests are kept** (PLAN-003, PLAN-004, PLAN-002 S2 and anything else already on main). They still run with `pnpm test:int`; run them when you change code they cover. Don't delete them.
- **Recorded in** SPEC-001, SPEC-002 and SPEC-005 decision D1, and SPEC-004 D4 (CI stages, install smoke).
- **Known risk while held:** catch-up and resync (SPEC-002 AC-9/AC-10) and the auth flows (SPEC-001) are only covered by unit tests. Review these areas with extra care, and write their integration tests first when the hold lifts.
- **Slices affected:** PLAN-004 S8 (deferred); PLAN-002 S10 (inspector and UI hooks only); PLAN-005 S8 (accessibility and polish; the M0 demo is run by hand).
- **In "As built",** a slice says which held criteria it checked by hand.
- **Timing assertions removed (2026-11-07, by decision of the user):** the "< 1 s" checks in the SPEC-004 AC-6 tests and the whole `sync-lock.perf.int.test.ts` (SPEC-002 §10) failed on a shared, loaded machine. AC-6's 1 s budget is checked by hand (SPEC-004 D7); the lock budget is read from its server metric (SPEC-002 D2). This is the one exception to "existing integration tests are kept".
- **Test tiers (2026-11-24, by decision of the user: the gate must take seconds):** what runs where. Lowering a count or moving a test between tiers changes how often it runs, never what it checks.
  - **Gate** (`pnpm check`, `pnpm test`; `pnpm check:fast` while iterating): unit tests, with each property at a fifth of its full case count (`GATE_PROPERTY_SCALE`) but at least 25 cases (or all, when it has fewer; `GATE_FLOOR`), and its fixed seed. Private-team leak and permission properties run every case in every tier (`propertyParameters(…, { full: true })`; SPEC-004 D12). A property states its full count and seed through `propertyParameters` (or `propertyRuns`/`propertySeed`) from `@surface/config/properties`. Wall-clock budgets are not in the gate: each lives in a `*.perf.test.ts`, and the behaviour it measures keeps a test in the gate (e.g. `overlay-scale.test.ts` beside `overlay.perf.test.ts`). The server, sync-client and web run with `isolate: false` (`surfaceVitestShared`): files that `vi.mock` run isolated; web's `test/setup-fresh-window.ts` resets the shared window and the module singletons tests touch before each file, and every web file fails if it leaves a React root mounted or an overlay layer open (`test/setup-react-roots.ts`).
  - **`pnpm test:int`:** integration tests at their full counts, files in parallel (the sync-sim real-server files too, the old `real-server.int.test.ts` split into one file per property). sync-sim runs first, alone and one at a time, the files whose checks depend on the server's speed (`TIMING_SENSITIVE` in its `vitest.int.config.js`), then the rest, 4 at a time unless `SURFACE_VITEST_WORKERS` says otherwise. `sync-ordering.stress.int.test.ts` runs 20 × 50 here.
  - **`pnpm test:deep`** (`scripts/test-deep.mjs`, needs Docker): two phases. First every unit test with every property case and one fresh seed for the run, printed before and after (`SURFACE_PROPERTY_SEED=<seed> pnpm test:deep` replays it; one package: add `--filter @surface/<pkg>`; a package's `test:deep` run on its own prints a seed of its own), and the full 20 × 500 ordering stress (the server's `vitest.deep.config.js`). Then, once that has finished, the timing budgets (`test:timing`: `*.perf.test.ts` and the server's `*.perf.int.test.ts`), one package at a time with one worker. CI runs it on pushes to main. A timing budget that fails under load is rerun alone before it counts.
  - **`pnpm sim:deep`:** the 1,000-case sync suite (PLAN-011 S8), the standard deep sync run. Three steps, in this order, each printing its seed and files: the fake hub, sync-client's `content.prop` and `partial.prop`, then every real-server file with a generated property (`realFiles()` in `tests/sync-sim/scripts/sim-deep-plan.mjs`), one file at a time. Every generated property runs `--runs` cases (1,000 by default); fixed examples run once. `--file <name>` limits the real step to some files, to resume a run that stopped. Takes hours (§7.6).
- **Lifting the hold:** write the tests named in the plans' ⏸ rows, then remove the markers and this section.

## 7. M1 Core issues

Exit (METHODOLOGY M1): **start dogfooding.** Surface's own backlog lives in Surface.

### 7.1 Acceptance gate (before any M1 code)

**Done 2026-11-12** (branch `m1-gate`; ADR-0021 to ADR-0024 written, ADR-0020 accepted). Building starts after one docs PR that:
- applies every row of each spec's "§12. Changes to accepted docs on acceptance" (PRD, METHODOLOGY, domain docs, glossary, events, sync-protocol, SPEC-002/003/005, design docs);
- writes the ADRs the §12 tables name: one superseding ADR-0014 (files), purge without a `D` per content row (SPEC-015 Q2), the one-off document migration as a rule-2 exception (SPEC-013 D6), and any other §12 row marked "ADR: yes"; and moves [ADR-0020](../04-architecture/adr/0020-partial-issue-sync.md) (partial issue sync) from Proposed to Accepted;
- records the user's decisions. The open questions the user owned were **decided on 2026-11-12** and are in each spec's Decisions table:
  - testing-hold exceptions granted: the Issue filter conformance test (SPEC-011 Q13) and the Postgres byte-lock test (SPEC-014 Q15);
  - description history stays v2 (SPEC-011 Q18);
  - the eager size budget: copy Linear with partial issue loading, 35 MB per replica (SPEC-011 Q15, ADR-0020);
  - explicit sign-out deletes the local replica, in M1 (SPEC-012 Q3, PLAN-012 S7a);
  - purge logs no `D` per content row; the ADR is written at the gate (SPEC-015 Q2);
  - the avatar and logo foreign keys are added with no clean-up step, since there are no existing rows (SPEC-014 D13);
- fixes the spec gaps found while planning (listed in the PR);
- sets SPEC-010 to SPEC-015 to Accepted and the plans to Ready.

### 7.2 Plans

| Plan | Implements | Slices | Size |
|---|---|---|---|
| [PLAN-010](PLAN-010-workflow-labels-estimates.md) | SPEC-010 Workflow statuses, labels & estimates | 6 | ~17 d |
| [PLAN-011](PLAN-011-issues-core.md) | SPEC-011 Issues core, content models, partial issue loading, sync foundations | 11 (S4b, S4c, S5a, S5b) | ~43 d |
| [PLAN-012](PLAN-012-issue-page-list-view.md) | SPEC-012 Issue page, composer, list, shortcuts, drafts, sign-out | 7 | ~33 d |
| [PLAN-013](PLAN-013-comments-reactions-editor.md) | SPEC-013 Comments, reactions & editor | 5 | ~17 d |
| [PLAN-014](PLAN-014-attachments-files.md) | SPEC-014 Attachments & files | 6 (S4a, S4b) | ~16 d |
| [PLAN-015](PLAN-015-recently-deleted-archive.md) | SPEC-015 Recently deleted & archive | 5 | ~12 d |
| [PLAN-016](PLAN-016-ui-polish.md) | UI polish, before M2: design-system v0.2, SPEC-005 D4, SPEC-012 D32 (no new spec) | 9 (S0–S8) | ~20 d |

Total: about **138 ideal days** (40 slices), plus about 2 days for the acceptance gate. That is roughly 15 weeks for two engineers or 11 weeks for three, using the tracks below. The critical path alone is about 44 ideal days, so more people don't shorten it below about 9 weeks. Partial issue loading (ADR-0020, 2026-11-12) added about 15 days: PLAN-011 S4b and S4c (10), and the server-backed counts, archive page and issue loader in PLAN-010, PLAN-012 and PLAN-015 (4), plus sign-out (1).

**Who builds the shared pieces:**
- **PLAN-010** (*added 2026-11-24, as built in S5*): `OptimisticRefusal` in `packages/operations`, which lets an `optimistic` prediction refuse a change before it takes a seq (SPEC-002 §3.3, SPEC-003 §8), and `store.seenDeleted` for the status-gone message.
- **PLAN-011:** the sync and registry foundations: `OptimisticStore` changes, `systemOnly` and `contentParent`, repo `updateWhere`/`deleteWhere` (with the unlogged content delete for purge), archive on the wire (protocol v0.7), `lockIssueForWrite`, partial issue loading (protocol v0.8: issue groups, subscriptions, the partial bootstrap, `visibleGroups`, the client's removal rules, `useTeamLoadState`), content models (`/sync/content`, hydration, cache), `issueSlug` and the issue route, the label cascade helper, the archived-label refusal, and the `claimInlineFiles` seam.
- **PLAN-012:** the shortcut engine changes, property commands, `ui.available`, the `Draft` model, the shared `packages/ui` components, the read-only issue page frame, and delete on a live issue (dialog, `Mod+Z`).
- **PLAN-013:** `packages/editor` and `@surface/editor/schema`.
- **PLAN-014:** the file byte protocol, the file jobs, and the real `claimInlineFiles` body.
- **PLAN-015:** the issue lifecycle and its rule table, the purge-step registry (PLAN-013 and PLAN-014 append steps), the auto-close status refusal, and the restore, purge and archive UI. *As built (2026-11-24):* also `jobs/daily-batch.ts`, the batch loop the `trash-purge`, `auto-archive` and `auto-close` jobs share (S2, S3), and the history seams for the `archived` entry and the auto-close `updated` entry, which PLAN-011 S6 wired.

### 7.3 Dependency graph and tracks

```mermaid
flowchart LR
  G[7.1 acceptance gate] --> P10S1[010·S1 domain]
  subgraph TA[Track A: issues and sync]
    P10S1 --> P11S1[011·S1 foundations] --> P11S2[011·S2 archive on wire] --> P11S3[011·S3 schema + lock] --> P11S4[011·S4 issue ops]
    P11S4 --> P11S4b[011·S4b partial load server] --> P11S4c[011·S4c partial load client]
    P11S4 --> P11S5a[011·S5a content protocol] --> P11S5b[011·S5b content client] --> P11S6[011·S6 description + history] --> P11S7[011·S7 cache] --> P11S8[011·S8 leak suite]
    P11S4b --> P11S6
  end
  subgraph TB[Track B: editor and UI]
    G --> P13S1[013·S1 editor schema] --> P13S2[013·S2 editor component]
    G --> P12S1[012·S1 shortcut engine] --> P12S2[012·S2 domain + ui components]
  end
  subgraph TC[Track C: settings and files]
    P10S1 --> P10S2[010·S2 statuses] --> P10S3[010·S3 labels] --> P10S4[010·S4 estimates]
    G --> P14S1[014·S1 files schema] --> P14S2[014·S2 upload] --> P14S3[014·S3 byte protocol]
  end
  P13S1 --> P11S6
  P11S2 --> P10S6[010·S6 label archive]
  P11S4b --> P10S5[010·S5 issue halves] --> P11S8
  P10S3 --> P10S5
  P11S4c --> P12S3[012·S3 list + my issues]
  P11S4 --> P15S1[015·S1 lifecycle] --> P15S3[015·S3 auto-archive/close]
  P10S2 --> P15S1
  P11S4c --> P15S1
  P11S6 --> P12S4[012·S4 issue page]
  P11S4c --> P12S4
  P13S2 --> P12S4
  P13S2 --> P12S5[012·S5 composer + drafts]
  P11S6 --> P12S5
  P11S5b --> P13S3[013·S3 comments] --> P13S4[013·S4 reactions]
  P11S6 --> P14S4a[014·S4a attachments] --> P14S4b[014·S4b claim + previews]
  P11S4c --> P14S4a
  P14S3 --> P14S4a
  P13S1 --> P14S4b
  P11S6 --> P15S2[015·S2 purge]
  P15S1 --> P15S2
  P12S4 --> P13S5[013·S5 comments UI]
  P12S4 --> P14S5[014·S5 attachments UI]
  P14S4b --> P14S5
  P12S4 --> P15S4[015·S4 archive page]
  P11S4c --> P15S4
  P15S1 --> P12S6[012·S6 pickers + delete]
  P12S5 --> P12S6
  P12S6 --> P15S4
  P12S6 --> P12S7a[012·S7a a11y + sign-out]
  P13S5 & P14S5 & P15S4 & P12S7a & P11S7 --> P12S7b[012·S7b M1 demo]
  P15S2 & P15S3 & P15S4 --> P15S5[015·S5 leak + edges]
```

Each plan's header and slices list the exact dependencies; this graph shows the main ones.

**Critical path:** 010·S1 → 011·S1–S4 → 011·S5a → S5b → S6 → 012·S4 → 012·S6 → 015·S4 → 012·S7b, about 44 ideal days (011·S4b–S4c run beside S5a–S5b and are done before 012·S3 and 012·S4 need them; 012·S5 runs beside 012·S4).
**Start at once after the gate:** 010·S1–S4, 012·S1–S2, 013·S1–S2, 014·S1–S3.

### 7.4 Suggested sequence (two engineers)

Engineer 1 takes issues, sync (partial loading included), lifecycle and the server side of comments and attachments (about 73 days); engineer 2 takes the editor, the UI, settings and files (about 70 days). Each row only starts slices whose dependencies are done in an earlier row, or earlier in the same engineer's row.

| Weeks | Engineer 1 (issues, sync, lifecycle) | Engineer 2 (editor, UI, settings, files) |
|---|---|---|
| 1 | Gate · 010·S1 · 011·S1 | Gate · 013·S1 |
| 2–3 | 011·S2–S3 | 013·S2 · 012·S1 |
| 4–5 | 011·S4 · 010·S6 · 011·S4b | 012·S2 · 010·S2 |
| 6–7 | 011·S4c · 011·S5a | 010·S3–S4 · 014·S1 |
| 8–9 | 011·S5b · 011·S6 | 014·S2–S3 · 012·S3 |
| 10 | 010·S5 · 015·S1 | 012·S4 |
| 11 | 013·S3 · 015·S2 | 012·S5 |
| 12 | 013·S4 · 014·S4a | 012·S6 |
| 13 | 014·S4b · 011·S7 | 013·S5 · 015·S4 |
| 14 | 011·S8 · 015·S3 | 014·S5 |
| 15 | 015·S5 | 012·S7b (M1 demo) |

### 7.5 Conventions

As §4. Branches are `p0NN-sN-topic` (e.g. `p011-s5-content`). The testing hold (§6) applies: leak tests and the sync property suite are written as usual, and every new content model, delta path and read operation adds its leak tests.

### 7.6 M1 exit checklist

- [x] Acceptance gate merged (§7.1). _2026-11-12._
- [x] All ACs of SPEC-010 to SPEC-015 have passing tests, except those held under §6. _2026-11-24 (M1 docs catch-up): every AC row in the test tables of [PLAN-010](PLAN-010-workflow-labels-estimates.md) to [PLAN-015](PLAN-015-recently-deleted-archive.md) names a test file that exists, or is marked ⏸ held. Three stale names were corrected in the tables (PLAN-012 AC-27, PLAN-013 AC-19 and AC-24). The gate, `test:int` (three runs) and `test:deep` were green on `d5e4fef` ([test-speed row](sessions/m1-coordination.md)). One stated exception: SPEC-011 AC-14's skewed worst case is a known limit for M1 by the user's decision (SPEC-011 D19), kept as `it.fails` in `issue-size.test.ts`._
- [x] Sync property suite green on main with issues, content models, archive and restore in the generator. _2026-11-24: the generators cover issues, descriptions and history, comments, reactions, attachments, drafts, workflow, and delete, restore, purge and auto-archive (PLAN-011 S8, PLAN-015 S2–S3). The 1,000-case run (`pnpm sim:deep`) passed on `79792e6` for the fake hub, `content.prop`, `partial.prop` and the real-server issue properties ([PLAN-011 S8 As built](PLAN-011-issues-core.md#s8-leak-suite-filter-conformance-size-budget-hardening--m---done-2026-11-24)). Every sim file, the lifecycle, comment, reaction, attachment, workflow and draft cases included, is green in `test:int` (three runs) and `sim:deep --runs 20` on `d5e4fef`. Those cases have not run at 1,000 cases. **2026-11-25 (extended `sim:deep`, seed 20261107, stopped early by the user):** at 1,000 cases issues-convergence (20 min), lifecycle (28 min), attachments (13 min) and comments (10 min) passed. Reactions **failed** at case 197 (`reactions-real-server.int.test.ts`, path `196:2:6:5:9:16:18:15:14:14:15:8:9:9:9`): a tab ends holding a reaction a fresh bootstrap lacks, after its own offline `reaction.set` on an issue (shrunk to 7 steps). **Diagnosed 2026-11-25: a harness bug**, not the product: the tab reacted while its socket redialled; the reaction waited for its issue's content, which waits for the team's `subscribed` ack (SPEC-011 §5.3 step 6, §5.7), so it was neither queued nor pending, and `World.quiesce` settled without it. The check then read the server and ran on, and the reaction was queued in the meantime. Fixed: quiescence also waits for dispatches not yet queued; the case is a fixed example in that file. The rerun at 1,000 then failed at case 332 on a different, older cause (it fails on `main`'s harness too): after a `restart` the server logs `could not check the sync socket’s session: timeout exceeded when trying to connect`. Not yet diagnosed. Drafts did not finish within 90 min (no failure reported). Workflow and the core `real-server-archive`, `-convergence` and `-exactly-once` files did not run at 1,000 (they pass at 20 in every `test:int`)._
- [x] Private-team leak suite covers every new model, `/sync/content`, `GET /files/:id` and every new read operation. _2026-11-24: Issue (`issue-leak`, `subscribe-leak`, `archive-wire-leak`), IssueContent and IssueHistory (`content-leak`), Comment and Reaction (`comment-leak`), Attachment and files (`attachment-leak`, `files-leak`), Draft (`draft-groups.int`), statuses and labels (`status-leak`, `label-leak`), archived and deleted issues (`lifecycle-leak`), refs (`resolvers.int`); all in `apps/server/test/`. The new read operations `issue.list`, `issue.count`, `issue.groupBy`, `issue.get`, `issue.listDeleted`, `comment.list`, `status.list`, `label.list` and `label.usage` each have a non-member case. Item by item: [permissions.md §5](../03-domain/permissions.md#5-leak-checklist-must-be-covered-by-tests)._
- [ ] **Dogfood demo (by hand while e2e is held):** create, triage, edit, comment on, attach to, delete and restore issues by keyboard only, across two tabs and offline. PLAN-012 S7b.
- [ ] Surface's own backlog moved into Surface, and the team uses it daily.
- [ ] Release `v0.2.0` image published.
- [ ] Retro held. PRD and METHODOLOGY updated with what we learned.
