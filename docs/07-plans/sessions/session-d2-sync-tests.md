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
| A | **A test entry for the real server (PLAN-002 S9 part 2).** Details in [Handoff to A: real-server test entry](#handoff-to-a-real-server-test-entry) below. | Blocks S9 part 2 only, and needs S5 (mutate endpoint) on `main` first. See ADR-0016. | open |
| user | **CI: 1,000 cases on `main`.** Add a step on pushes to `main` that runs `pnpm sim --runs 1000` (about 1 min). PRs already run 200 cases per property through `pnpm test`. `.github/**` is not session D's, and session B is retired. | Not blocking; PLAN-002 S9 asks for it. | open: deferred by the user (2026-11-07), set up later |

### Handoff to A: real-server test entry

**Goal.** `tests/sync-sim` runs the same two properties (AC-2 convergence, AC-3 exactly-once) against the real server: executor, repo, `sync_log`, hub and Postgres. It wraps the server in its `SimServer` interface (`tests/sync-sim/src/server.ts`), the way it wraps sync-client's fake hub today. The tests are `*.int.test.ts` (Postgres). They are not held: the sync property suite is exempt (SPEC-002 D1).

**What D needs from `apps/server`:**

1. **A test-only entry**, for example `@surface/server/testing`. `apps/server` has no `exports` map yet; add one with the `@surface/source` condition like the packages, so `tests/` gets TypeScript source. D will add an additive dependency-cruiser rule so only `tests/` may import it, mirroring `test-doubles-only-in-tests`.
2. **Start, restart, stop** on a database D provides (a URL from your `createTestDatabase()` / template DB, or the entry creates and drops one):
   - `start({ databaseUrl })` builds the server through `startServer` on `127.0.0.1:0` and resolves with its base URL once ready. Config comes from a `Config` object built in code, never from `process.env` (rule 7).
   - `restart()` stops it and starts a new one on the same database. Live sockets close with `1012`, in-flight requests may be lost, and committed rows and `client_mutations` survive. The port may change; D reconnects through its own network.
   - `stop()` shuts it down and closes the pool.
   - Since PLAN-001 S2 a fresh database answers `503 SETUP_REQUIRED` on `/api` and `/sync` until first-run setup is done, so `start` completes setup first (A, via the coordinator, 2026-11-07). A's order: PLAN-001 S3 or PLAN-002 S5 (the user is choosing), then C's current-session endpoint, then this entry.
3. **Signed-in users without the login flow.** Bootstrap and the socket refuse anyone but a signed-in user (Q7, Q9), and sessions arrive in PLAN-001 S3. So give D a way to:
   - create N users who are members of one team, so the debug rows' sync groups are visible to all of them;
   - authenticate each user's requests and socket upgrades, for example a `resolveActor` that maps a test header or cookie to the user.

   A private-team variant (a user outside the team) would be welcome later for AC-11, but is not needed now.
4. **Fixtures and reads:**
   - **Seed** debug items through the executor (`debug.create` as one of the users), so `sync_log` and groups are written by the repo layer (rule 2). No direct table writes.
   - **Read** the current head (the last committed `sync_id`), and `debug_items` with id, title, counter, archived/deleted state and `sync_groups`. Reading from the test database's pool directly is fine.
5. **Timers.** The harness fakes `setTimeout`, `setInterval` and `Date` for the whole process, so an in-process server runs on fake time too.
   - Let the entry set the hub's `pingIntervalMs` and `pongTimeoutMs` (`HubOptions` has them), and turn off the job worker.
   - Say which other server timers matter, such as pool idle and connection timeouts, request timeouts, and the listen retry. D decides on its side which of them run on real time.

**Not needed:** the debug ops beyond `create`, `rename`, `touch` and `delete`; metrics; logs (silent is fine).

**Server bugs** the properties find come back to A as new handoffs here, each with its seed and a shrunk case.

## Log (append-only)

| Date | Slice | Branch | State | Notes / handoffs |
|---|---|---|---|---|
| 2026-11-07 | setup | p002-s9-sim | started | Before branching, a merge slip: two `git merge --ff-only` runs in the primary worktree (which session A had switched to `p002-s3-bootstrap`) fast-forwarded A's branch instead of `main`. Nothing was lost: A rebased and carried the first commit (`34e7ed8`), the second left `p002-s3-bootstrap` equal to `main`, and `main` was then fast-forwarded with `git fetch . p002-s8-mutations:main` (README §5). Harness location: the user chose a new `tests/sync-sim` package (ADR-0016). |
| 2026-11-07 | PLAN-002 S9 part 1 | p002-s9-sim | built, in review | `@surface/sync-sim`: fake-clock harness (real `setImmediate` counted, so IndexedDB takes no virtual time; seeded `Math.random`/`randomUUID`), controllable network, Web Locks per user, tab crashes that freeze timers, network, locks and storage, quiescence that also waits for stranded queues (E5). Convergence (AC-2) and exactly-once (AC-3) properties against the fake hub, 200 cases each in `pnpm test`, `pnpm sim` for 1,000 or a replay. **Engine bug found and fixed (S8):** the queue could send a batch with a seq gap (`[1, 3]`), against sync-protocol.md §5.1; regression test in `queue.test.ts` fails without the fix. Mutation-checked both properties. Shared files edited: `pnpm-workspace.yaml`, root `package.json` (`lint:deps` scans `tests`, `sim` script), `.dependency-cruiser.cjs` (two additive rules), `pnpm-lock.yaml`, `docs/04-architecture/adr/README.md` (ADR-0016 row). Handoffs to A (real-server test entry) and the user (CI step). The sessions README §7 still lists the harness location as undecided (not D's file). `pnpm check` green (sync-sim 19, sync-client 242 tests). Part 2 (real server) waits for S5. |
| 2026-11-07 | PLAN-002 S9 part 1 | p002-s9-sim | review fixes, in review | All /review findings fixed. **M1:** `crypto.getRandomValues` seeded too; `replay.test.ts` replays 9 cases and compares a draw from each seeded global (fails with any stub removed). **M2:** an abandoned request (timeout, disconnect, crash) still reaches the server; new `hangResponse` fault. **m1:** `crashMidway` crashes a tab after its next 1–6 storage calls (limit: storage-call granularity, in ADR-0016). **m2:** convergence also fails on store errors on live tabs and start failures after heal; every user reopens a cold tab at the end. Exactly-once now counts saved mutations (instrumented `writeQueue`) instead of letting work finish before a crash. **AC-3 qualified** (approved by the user): exactly once applies to mutations stored in the replica, since a crash before the save may lose one. Shared file edited: SPEC-002 (AC-3 row and a changes row). **m3:** AC-2 row says the 1,000-case CI run is pending. **m4:** the seq-gap regression test fails fast. Mutation checks redone (convergence fails after 35 cases without the queue fix; exactly-once on the first case with dedupe off). Seeds 20261107, 1, 777 pass at 1,000 cases. No new engine bug. Rebased on `main` `08f2ccd` (PLAN-001 S1, PLAN-002 S4): no conflicts, `pnpm check` green (sync-sim 29, sync-client 242, server 322 tests). |
| 2026-11-07 | PLAN-002 S9 part 1 | p002-s9-sim | second review fixes, in review | Rebased on `main` `45944a1` (PLAN-005 S6; lockfile: `mobx` in web, `@surface/domain` dev dependency in ui), no conflicts. **M1:** quiescence waits until no request is on its way to the server, counted at the network from send until the server handled it (a crashed or impatient tab's request included); dead per-link counters removed. **m1:** 0–2 late users whose first tab bootstraps under faults, and a `compact` step that makes tabs behind the head re-bootstrap (E8). **Second engine bug found and fixed (S7/S8):** a bootstrap whose response never came left the store `bootstrapping` for good (a stuck resync blocked every later start); `bootstrap()` now abandons it after 30 s without a response (red-first tests in `resync.test.ts`). Shared doc edited: `sync-protocol.md` §4.1 and change log (client only, no wire change, nothing for A). **m2, m3, n2, n4:** plan wording on tab counts and `crashMidway`, `SimServer.seed` contract, unshrunk case seed, run time. **n1:** per-install immediate counter, red-first `clock.test.ts`. **n3:** dead code removed. Mutation checks redone; seeds 20261107, 1, 777 pass at 1,000 cases. |

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
