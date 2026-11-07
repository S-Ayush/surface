# Session C, phase 2: Web app shell

Worktree: `/Users/admin/Desktop/Learning/surface-c` · First branch: `p005-s5-shortcuts` · Guide: [README](README.md) §7 · Phase 1 log: [session-c-design-system.md](session-c-design-system.md)

Assigned 2026-11-07. Session C built the design system in phase 1. Phase 2 turns `apps/web` from a placeholder into the keyboard-first app shell.

## Setup

The phase 1 worktree was removed, so create it again:

```bash
cd /Users/admin/Desktop/Learning/surface
git worktree add ../surface-c -b p005-s5-shortcuts main
cd ../surface-c && source ~/.nvm/nvm.sh && nvm use && pnpm install && pnpm check
claude
```

## Scope, in order

Read [PLAN-005](../PLAN-005-app-shell-command-menu-shortcuts.md) S4–S8, [SPEC-005](../../06-specs/SPEC-005-app-shell-command-menu-shortcuts.md), [shortcuts.md](../../05-design/shortcuts.md), [command-menu.md](../../05-design/command-menu.md) and the PLAN-002 S6–S8 "As built" notes (the client store you render from).

1. **PLAN-005 S5: shortcut engine and help overlay.** It has no dependencies and starts now.
   - First, as a small separate commit: turn off Zod's `eval` probe with `z.config({ jitless: true })`. Put it in a module of its own, imported first in `apps/web/src/main.tsx`. This was session A's PLAN-004 S9 handoff: under the CSP the probe reports a violation on every load.
2. **PLAN-005 S6: command menu.**
   - Registry operations and the client store are on `main`.
   - Until PLAN-001 models land (session E, S1 and S8), build and test against the `debug.*` models.
   - Add live teams as a source when they exist.
3. **PLAN-005 S4: shell layout and routing.**
   - Starts when session A's PLAN-001 S3 (auth) and session E's PLAN-001 S1 (models) are on `main`.
   - Route guards: setup, auth, store-ready, admin.
4. **PLAN-005 S7: preferences, banners, screen restyle.**
   - Needs session D's PLAN-002 S10 UI hooks (`useConnectionState`, `usePendingCount`, `onRejected`, `onOutdated`).
   - Needs the `users.preferences` column from E's S1.
   - You own the `user.updatePreferences` operation and its handler.
5. **PLAN-005 S8: accessibility and polish.**
   - The keyboard-only demo e2e is held: run the demo by hand and record it in "As built".
   - The axe sweep over Storybook still runs.

## Owns

- `apps/web/**`, except the feature folders session E adds for its PLAN-001 screens (`apps/web/src/features/{teams,account,invites,members}/**`) once your S4 shell is on `main`
- `packages/ui/**`, `packages/editor/**`
- The `user.updatePreferences` operation and handler
- PLAN-005 S4–S8 sections; SPEC-005 changes (logged)

## Shared registry files

These files are append-only for everyone: `apps/server/src/handlers/index.ts`, `packages/operations/src/ops/index.ts`, `packages/domain/src/model/index.ts`, `apps/server/src/sync/models.ts`, `apps/server/src/db/schema/index.ts` and `packages/domain/src/index.ts`.
- Add your own lines only.
- On a rebase conflict, keep both sides.

## Must not touch

- `apps/server/**`, except your preferences handler
- `packages/sync-client/**` and `packages/sync-protocol/**`: you consume D's hooks; ask D for changes
- Migrations: ask session E for the preferences column
- `CLAUDE.md`, `.claude/**`

## Notes

- **Ports:** dev server 5174, Storybook 6006. Stop any other Storybook on 6006 first.
- **The web app renders from the store** (CLAUDE.md, architecture rule 3). It never fetches and writes base state itself, and every change is a dispatched operation.
- **Keyboard first:** every action reachable from a shortcut or `Mod+K` (SPEC-005).

## Handoffs (requests from C to other sessions)

| To | Request | Why / blocking? | Status |
|---|---|---|---|

## Log (append-only)

| Date | Slice | Branch | State | Notes / handoffs |
|---|---|---|---|---|
| 2026-11-07 | Zod jitless (PLAN-004 S9 handoff from A) | p005-s5-shortcuts | built | `apps/web/src/zod-config.ts` imported first in `main.tsx`; `zod` added to `apps/web` (already in the lockfile). Unit-tested; not checked on a CSP-served build. Separate commit. |
| 2026-11-07 | PLAN-005 S5 | p005-s5-shortcuts | built | Shortcut engine, registry, conflict check, `?` help, command handler registry (`apps/web/src/{shortcuts,commands,theme}`). SPEC-005 §5 gains "overlay capture" and E3 is refined (Alt/Ctrl letters by `event.code`, non-Latin fallback); shortcuts.md rules 2 and 5 and an `F8` row updated. `pnpm check` green (web 97 tests); checked by hand in Chromium. Waiting for /review and /commit. |
| 2026-11-07 | PLAN-005 S5 review | p005-s5-shortcuts | fixed | slice-reviewer: 0 blockers, 2 majors, 6 minor, 3 nits; all fixed. M1: the second key of a sequence now passes the typing and overlay gate. M2: command handlers have explicit levels (`app` < `page` < `overlay`) instead of mount order. Minor: last-word help search, `Alt+<symbol>` rejected and `Mod+,` without Option, override direction checked, editor/page scopes overlap, `Mod+Enter` uses the focused form and respects a disabled or busy submit button, hint and `inBuild` tests. Nits: Zod comment, SPEC E3 "outside A–Z", stable `bindings` note. Each fix mutation-checked. Rebased onto `db3128c`; `pnpm check` green (web 112 tests); real page rechecked in Chromium. |
| 2026-11-07 | Zod jitless + PLAN-005 S5 | main | merged | Rebased onto `db3128c` (no-op). `pnpm install`, `pnpm check` (web 112 tests) green; `pnpm test:int` 179 + 2 of 3 perf passed: `sync-lock.perf` (p95 < 2 ms) failed once under load (load average about 4, other sessions running) and passed on two re-runs; server code untouched by this branch. `main` is checked out in the primary worktree, so it was fast-forwarded there with `git merge --ff-only` instead of `git fetch . HEAD:main`; main at `7ddc5d1`. Next: PLAN-005 S6. |

## Prompt

```
You are session C of the Surface project, phase 2, working in the git worktree /Users/admin/Desktop/Learning/surface-c. Your track is the web app shell: PLAN-005 S5, S6, S4, S7 and S8, in that order.
Read, in order:
- CLAUDE.md, docs/07-plans/sessions/README.md (especially §7, phase 2), docs/07-plans/sessions/session-c2-web-shell.md;
- then PLAN-005, SPEC-005, docs/05-design/, and the PLAN-002 S6–S8 "As built" notes.
Check the Log and Handoffs tables in all phase 2 session files (a2, c2, d2, e2) before starting.

Implement the scope in session-c2-web-shell.md one slice at a time, following .claude/skills/slice/SKILL.md exactly. Start with the Zod jitless commit, then PLAN-005 S5 on branch p005-s5-shortcuts.
Edit only the files listed under "Owns", and the shared registry files append-only. Ask other sessions for changes through the Handoffs table.
Before each slice: git rebase main, then pnpm install and pnpm check.
After each slice:
- append a row to the Log in session-c2-web-shell.md;
- update PLAN-005's "As built" notes for that slice;
- stop and ask me to run /review and /commit.
Never merge to main unless I ask, and then use docs/07-plans/sessions/README.md §5.
```
