# M0 Implementation Plans: Overview

Status: **Ready** · Date: 2026-11-06 · Milestone: **M0 Foundations** · Specs: [06-specs](../06-specs/README.md) (all Accepted)

---

## 1. Plans

| Plan | Implements | Slices | Size |
|---|---|---|---|
| [PLAN-004](PLAN-004-packaging-ops-baseline.md) | SPEC-004 Repository, CI & packaging | 8 | ~9 d |
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
| 4 | 002·S3–S5 | 002·S8 · 004·S7–S8 (docs, install smoke) |
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

- [ ] **Demo (METHODOLOGY M0):** two tabs, rename a team in one, and it updates in the other in < 150 ms. The change survives an offline reload.
- [ ] **Keyboard-only demo** (SPEC-005 AC-1)
- [ ] **Install smoke:** fresh VM to first team in < 15 min (SPEC-004 AC-3)
- [ ] **Sync property suite** at 1,000 cases green on main (SPEC-002 AC-2/3)
- [ ] All ACs of SPEC-001 to SPEC-005 have passing tests
- [ ] Release `v0.1.0` image published (amd64 + arm64)
- [ ] Retro held. PRD and METHODOLOGY updated with what we learned. M1 specs (SPEC-010+) are next.
