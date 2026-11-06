# Parallel sessions: coordination

Status: **Active, phase 2** (from 2026-11-07, see §7) · Created: 2026-11-06 · Milestone: **M0**

M0 is split into **four Claude Code sessions** that run at the same time, each in its **own git worktree**, owning disjoint parts of the repo. Each session has a file in this folder. That file is the session's brief, its paste-ready prompt, and its append-only log.

| Session | Track | Scope (phase 1) | File |
|---|---|---|---|
| **A** | Platform core: the critical path | PLAN-004 S3 (finish) → PLAN-003 S1–S7 → PLAN-002 S2–S5 | [session-a-platform.md](session-a-platform.md) |
| **B** | Packaging, CLI & CI | PLAN-004 S4–S7 (+ S8 parts that don't need auth) | [session-b-packaging.md](session-b-packaging.md) |
| **C** | Design-system foundations | PLAN-005 S1–S3 | [session-c-design-system.md](session-c-design-system.md) |
| **D** | Client sync engine | PLAN-002 S1, S6, S7 (S8 once PLAN-003 S1 is on `main`) | [session-d-sync-client.md](session-d-sync-client.md) |

**Phase 2** (after these): PLAN-001 auth and teams (needs PLAN-002 S5 and S8), then PLAN-005 S4–S8 and PLAN-002 S9–S10. Replan at the sync point below.

## 1. Setup (once per session, from the main checkout)

```bash
cd /Users/admin/Desktop/Learning/surface      # main checkout (session A lives here)
git worktree add ../surface-b -b p004-s4-cli main
git worktree add ../surface-c -b p005-s1-tokens main
git worktree add ../surface-d -b p002-s1-protocol main
# then, in each new worktree:
cd ../surface-b && source ~/.nvm/nvm.sh && nvm use && pnpm install
```

Start Claude Code **inside the worktree folder** (e.g. `cd ../surface-b && claude`) and paste the prompt from that session's file. The project's `CLAUDE.md`, rules, commands and hooks are committed, so every worktree has them.

> **Start after** PLAN-004 S3 is committed and on `main`, because sessions A and B build on it. Sessions C and D don't depend on S3 and could start from the current `main`.

## 2. Rules every session follows

1. **Stay in your worktree and your branch.** Never `git checkout` another session's branch, and never edit files in another worktree. Branches follow `p<plan>-s<slice>-<topic>`.
2. **Edit only what your session owns** (listed in its file). Shared files may be changed only as described in §3. If you need a change in another session's area, write a **handoff** (§4) instead of making it yourself.
3. **One slice at a time, using the `/slice` procedure** (`.claude/skills/slice/SKILL.md`). When a slice is done, append a row to your log, then **stop** so the user can run `/review` and `/commit` in your session.
4. **Before starting each slice:**
   - rebase on `main` (`git rebase main`), then run `pnpm install` and `pnpm check`;
   - read the **Handoffs** sections of the other session files for anything addressed to you.
5. **Merging to `main` happens only when the user asks.** See §5.
6. **Migrations:** only session **A** generates migrations in phase 1. Two sessions generating at once would clash on the journal index. Anyone else who needs a table writes a handoff to A.
7. **Ports and Docker:** tests use port 0 and random database names, so suites can run at the same time on the shared Colima VM. Dev servers use your session's ports: A 3100/5173, B 3200, C 6006 (Storybook) and 5174, D 3400.

## 3. Shared files

| File | Rule |
|---|---|
| `pnpm-lock.yaml`, root `package.json`, any `package.json` | Add dependencies with `pnpm --filter <pkg> add`. Never hand-edit the lockfile. On a rebase conflict, take `main`'s lockfile (`git checkout --ours pnpm-lock.yaml` during a rebase), run `pnpm install`, stage the result, and continue. |
| `packages/config/*`, `turbo.json`, `.dependency-cruiser.cjs`, `eslint.config.js` | Additive changes only (a new preset or a new rule). Note them in your log under "Shared-file changes". Never relax an existing rule. |
| `CLAUDE.md`, `.claude/**` | Owned by session **A**. Others propose changes as a handoff to A. |
| `docs/07-plans/PLAN-*.md` | Edit only **your own slice sections** ("✅ Done" and "As built"). |
| `docs/06-specs/*` | Edit only the spec your slice implements, and record the change in your log. |
| `docs/07-plans/README.md` | Owned by session **A**. |
| `.github/workflows/*` | Owned by session **B**. Others ask B for CI jobs through handoffs. |

## 4. Handoffs

When you need something from another session, add a row to the **Handoffs** table in **your own** session file:

| To | Request | Why / blocking? | Status |
|---|---|---|---|

The receiving session reads it at the start of its next slice, does the work (or replies in its own file), and the requester marks it done. Urgent blocking requests should also be told to the user.

## 5. Integrating into `main` (only when the user asks)

`main` is not checked out in any worktree; session A works on slice branches too. Update it with a fast-forward from the finished branch:

```bash
git rebase main                     # in your worktree, on your committed slice branch
pnpm install && pnpm check          # plus: pnpm test:int when Docker is up
git fetch . HEAD:main               # fast-forward main to this branch (refuses if not ff)
git switch -c p<plan>-s<next>-<topic>   # start the next slice from the updated main
```

Merge order when several slices are ready: **A first** (critical path), then B, D, C. A slice that fails `pnpm check` after the rebase is fixed in its own session before merging.

## 6. Sync point: end of phase 1

Phase 1 ends when PLAN-002 S5 (A) and S8 (D) are on `main`. Then:
- session A updates `docs/07-plans/README.md`, including the exit checklist;
- the sessions are reassigned for phase 2 (PLAN-001 and PLAN-005 S4+);
- the worktrees are removed with `git worktree remove ../surface-x` once their branches are merged.

`/status` summarises every session's latest log row.

## 7. Phase 2 (from 2026-11-07)

Assigned by the user on 2026-11-07, before the phase 1 sync point, so that the sessions that had finished could start. Session A's PLAN-002 S3–S5 carries over and still ends phase 1. Each session has a new file. The phase 1 files stay as the record of phase 1, and their logs are closed.

| Session | Track | Scope, in order | Starts | File |
|---|---|---|---|---|
| **A** | Sync server, setup, auth | PLAN-002 S3–S5 → PLAN-001 S2, S3, S7, S9 | now (S3 in progress) | [session-a2-server-auth.md](session-a2-server-auth.md) |
| **C** | Web app shell | PLAN-005 S5 → S6 → S4 → S7 → S8 | now (S5); S4 after PLAN-001 S1 + S3 | [session-c2-web-shell.md](session-c2-web-shell.md) |
| **D** | Sync property suite, inspector | PLAN-002 S9 → S10 | now; S9 uses the real server after PLAN-002 S5 | [session-d2-sync-tests.md](session-d2-sync-tests.md) |
| **E** | Workspace data, accounts, teams | PLAN-001 S1 → S8 → S4 → S5 → S6 | now (S1) | [session-e2-accounts-teams.md](session-e2-accounts-teams.md) |
| **B** | Retired | none: packaging work resumes when the testing hold lifts (PLAN-004 S8, [end-of-phase handoff](session-b-packaging.md)) | — | — |

**Dependencies between sessions:**
- E's PLAN-001 S1 (tables) unblocks A's PLAN-001 S2 and C's PLAN-005 S4.
- A's PLAN-001 S3 (auth) unblocks C's PLAN-005 S4 and E's PLAN-001 S4–S6.
- D's PLAN-002 S10 (UI hooks) unblocks C's PLAN-005 S7.
- C's PLAN-005 S4 (shell) unblocks the web halves of E's slices.

The session that merges an unblocking slice tells the user.

**Changes to the phase 1 rules:**
- **Migrations (replaces §2 rule 6):** one session holds the migration lock at a time. **E** holds it until PLAN-001 S1 is on `main`, then **A**. Anyone else who needs a table or column writes a handoff to the holder. A handover of the lock is logged by both sessions.
- **Shared registry files**, append-only for everyone:
  - `apps/server/src/handlers/index.ts`
  - `packages/operations/src/ops/index.ts`
  - `packages/domain/src/model/index.ts`
  - `apps/server/src/sync/models.ts`
  - `apps/server/src/db/schema/index.ts`
  - `packages/domain/src/index.ts`

  Add your own lines only. On a rebase conflict, keep both sides.
- **Merge order** (replaces §5): A, then E, D, C.
- **Ports:** A 3100/5173, C 5174 and Storybook 6006, D 3400, E 3500/5175 (dev Postgres 5435).
- **Worktrees:** C's worktree is created again (`git worktree add ../surface-c -b p005-s5-shortcuts main`). `../surface-b` can be removed; its branches are on `main`.
- **Not decided yet:** where the PLAN-002 S9 harness lives. Package boundaries forbid importing the server from `sync-client` and the reverse. D proposes a location, and the user decides (session-d2, scope step 1).

