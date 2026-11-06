# Session D, phase 2: Sync property suite and inspector

Worktree: `/Users/admin/Desktop/Learning/surface-d` · First branch: `p002-s9-sim` · Guide: [README](README.md) §7 · Phase 1 log: [session-d-sync-client.md](session-d-sync-client.md)

Assigned 2026-11-07. Session D built the client side of sync in phase 1. Phase 2 proves the whole engine with the property suite (not held: plans README §6), then gives the app shell its sync hooks.

## Setup

```bash
cd /Users/admin/Desktop/Learning/surface-d
git switch -c p002-s9-sim main
source ~/.nvm/nvm.sh && nvm use && pnpm install && pnpm check
```

## Scope, in order

Read [PLAN-002](../PLAN-002-sync-engine-v0.md) S9–S10, [SPEC-002](../../06-specs/SPEC-002-sync-engine-v0.md) AC-2, AC-3 and AC-13, `.claude/rules/sync.md`, and session A's PLAN-002 S2–S5 "As built" notes.

1. **Decide where the harness lives. Ask the user before writing code.**
   - PLAN-002 S9 puts it in `packages/sync-client/test/sim/` with the real executor and Postgres.
   - `.dependency-cruiser.cjs` forbids both directions: packages never import `apps/server`, and the server never imports `sync-client`.
   - Option A: a new private workspace package, e.g. `tests/sync-sim`. It gets one additive dependency-cruiser rule allowing it to import both sides, and nothing imports it.
   - Option B: keep the harness in `sync-client` with the fake hub, and test the server separately. This is weaker for AC-2.
   - Record the choice as an ADR, and update PLAN-002 S9.
2. **PLAN-002 S9: simulation harness and property tests.**
   - Build the controllable network first (delay, drop, reorder, disconnect, server restart), plus N clients on fake-indexeddb against the in-process fake hub.
   - Switch the server side to the real executor and Postgres once session A's PLAN-002 S5 is on `main`.
   - **Property 1, convergence (AC-2)** and **property 2, exactly-once (AC-3)**.
   - 200 cases on PRs and 1,000 on `main`. Failing seeds are printed, and `pnpm sim --seed <n>` replays one.
   - Tests that need Postgres are named `*.int.test.ts` (CLAUDE.md, Testing). Update the PLAN-002 §4 rows to match.
3. **PLAN-002 S10: sync inspector and UI hooks.**
   - The demo e2e and perf parts are held (SPEC-002 D1). The plan's "after PLAN-001 S8" was for that demo, so S10 now follows S9.
   - Deliver the hooks session C needs for PLAN-005 S7: `useConnectionState()`, `usePendingCount()`, `onRejected`, `onOutdated`, `useBootstrapProgress()`.
   - Deliver the inspector panel in dev builds. The `?debug=sync` Admin gate waits for session A's PLAN-001 S7; leave a typed TODO until then.
4. **PLAN-002 §4 test table:** list the client AC-9 test, the AC-6 unit tests, and AC-3 as partial until S9 lands (open items from your S7 and S8 logs).

## Owns

- `packages/sync-client/**`, `packages/sync-protocol/**`
- The harness package or folder chosen in step 1, and its dependency-cruiser rule (additive only)
- PLAN-002 S9 and S10 sections and the §4 test table; `docs/04-architecture/sync-protocol.md` (changes logged and handed off to A)

## Shared registry files

These files are append-only for everyone: `apps/server/src/handlers/index.ts`, `packages/operations/src/ops/index.ts`, `packages/domain/src/model/index.ts`, `apps/server/src/sync/models.ts`, `apps/server/src/db/schema/index.ts` and `packages/domain/src/index.ts`.
- Add your own lines only.
- On a rebase conflict, keep both sides.

## Must not touch

`apps/server/src/**` (session A; ask for test hooks such as a restartable in-process server through a handoff), `apps/web/**`, `packages/ui/**`, migrations, `CLAUDE.md`, `.claude/**`.

## Notes

- **Ports:** dev server 3400.
- **Determinism:** seeded randomness, fake timers and an injectable clock and transport. No real sleeps.
- **A failing property is a bug in the engine, not the test.** Shrink it, keep the seed as a regression example, fix it in the right session (handoff to A for server bugs), and say so in the log.

## Handoffs (requests from D to other sessions)

| To | Request | Why / blocking? | Status |
|---|---|---|---|

## Log (append-only)

| Date | Slice | Branch | State | Notes / handoffs |
|---|---|---|---|---|

## Prompt

```
You are session D of the Surface project, phase 2, working in the git worktree /Users/admin/Desktop/Learning/surface-d. Your track is the sync property suite and the sync inspector: PLAN-002 S9, then S10.
Read, in order:
- CLAUDE.md, .claude/rules/sync.md, docs/07-plans/sessions/README.md (especially §7, phase 2), docs/07-plans/sessions/session-d2-sync-tests.md;
- then PLAN-002, SPEC-002, docs/04-architecture/sync-protocol.md, and session A's PLAN-002 S2–S5 "As built" notes.
Check the Log and Handoffs tables in all phase 2 session files (a2, c2, d2, e2) before starting.

First, propose where the simulation harness lives (step 1 of the scope) and wait for my choice. Then implement the scope in session-d2-sync-tests.md one slice at a time, following .claude/skills/slice/SKILL.md exactly, on branch p002-s9-sim.
Edit only the files listed under "Owns", and the shared registry files append-only. Server changes go to session A through the Handoffs table.
Before each slice: git rebase main, then pnpm install and pnpm check.
After each slice:
- append a row to the Log in session-d2-sync-tests.md;
- update PLAN-002's "As built" notes for that slice;
- stop and ask me to run /review and /commit.
Never merge to main unless I ask, and then use docs/07-plans/sessions/README.md §5.
```
